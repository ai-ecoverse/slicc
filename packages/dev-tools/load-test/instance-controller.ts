/**
 * InstanceController — manages a single SLICC instance lifecycle.
 *
 * Lifecycle:
 * 1. Spawn the SLICC server process on a designated port
 * 2. Wait for HTTP readiness (GET /api/runtime-config)
 * 3. Connect to the CDP WebSocket proxy at ws://localhost:{port}/cdp
 * 4. Wait for agent ready state, then inject the prompt
 * 5. Poll for agent completion via DOM state
 * 6. Optionally verify expected VFS output files
 * 7. Tear down cleanly (CDP close → SIGTERM → SIGKILL)
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { resolve } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import type { Scenario, ScenarioStep, InstanceResult } from './types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

export interface InstanceControllerOptions {
  index: number;
  port: number;
  scenario: Scenario;
  timeoutMs: number;
  envFile?: string;
  /** Adobe IMS access token to inject into localStorage before prompting. */
  adobeToken?: string;
  /** Model ID to select (default: claude-sonnet-4-6). */
  modelId?: string;
  /** Bedrock CAMP provider config. */
  bedrockApiKey?: string;
  bedrockBaseUrl?: string;
  bedrockModelId?: string;
  /** Extension mode: path to unpacked extension. */
  extensionPath?: string;
  /** Extension mode: URL to navigate to before opening side panel. */
  extensionUrl?: string;
}

export class InstanceController {
  private opts: InstanceControllerOptions;
  private serverProcess: ChildProcess | null = null;
  private chromeCdpPort: number | null = null;
  private extensionId: string | null = null;
  /** Cached sandbox target ID for fast lick dispatch. */
  private sandboxTargetId: string | null = null;
  private cdpWs: WebSocket | null = null;
  private cdpIdCounter = 1;
  private cdpCallbacks = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
    }
  >();
  private aborted = false;
  private promptSentAt = 0;
  private completedAt = 0;

  constructor(opts: InstanceControllerOptions) {
    this.opts = opts;
  }

  private log(msg: string): void {
    console.log(`[inst-${this.opts.index} :${this.opts.port}] ${msg}`);
  }

  /** Phase 1: Boot, connect CDP, inject provider, run prepare steps. */
  async prepare(): Promise<void> {
    if (this.opts.extensionPath) {
      await this.bootExtension();
    } else {
      await this.boot();
      if (this.opts.adobeToken || this.opts.bedrockApiKey) {
        await this.connectAndInjectProvider();
      } else {
        await this.connectAndWaitIdle();
      }
    }

    // Run prepare steps (e.g., upskill, shortcut-migrate)
    const prepSteps = this.opts.scenario.prepareSteps;
    if (prepSteps?.length) {
      this.log(`Running ${prepSteps.length} prepare step(s)...`);
      this.promptSentAt = Date.now(); // needed for remainingMs()
      for (let i = 0; i < prepSteps.length; i++) {
        const step = prepSteps[i]!;
        this.log(`Prepare ${i + 1}/${prepSteps.length}: ${this.describeStep(step)}`);
        await this.runStep(step);
      }
    }

    this.log('READY');
  }

  /** Phase 2: Execute scenario, capture screenshot, teardown. */
  async execute(): Promise<InstanceResult> {
    try {
      await this.executeScenario();
      return await this.verifyAndReport();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = /timeout/i.test(msg);
      this.log(`${isTimeout ? 'TIMEOUT' : 'ERROR'}: ${msg}`);
      return this.buildResult(isTimeout ? 'timeout' : 'error', msg);
    } finally {
      await this.captureScreenshot();
      await this.teardown();
    }
  }

  /** Signal this instance to abort. */
  abort(): void {
    this.aborted = true;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle phases (called from run)
  // ---------------------------------------------------------------------------

  private async boot(): Promise<void> {
    // Clean the Chrome profile so each run starts fresh (no stale VFS/sessions)
    const suffix = this.opts.port === 5710 ? '' : `-${this.opts.port}`;
    const profileDir = resolve(tmpdir(), `browser-coding-agent-chrome${suffix}`);
    try {
      execSync(`rm -rf ${JSON.stringify(profileDir)}`, { stdio: 'ignore' });
      this.log(`Cleaned Chrome profile: ${profileDir}`);
    } catch {
      // Profile may not exist yet
    }

    this.log('Starting server...');
    this.spawnServer();
    this.log('Waiting for HTTP readiness...');
    await this.waitForReady();
    this.log('Server ready. Waiting for CDP proxy to settle...');
    // The server's CDP proxy pre-connects to Chrome asynchronously.
    // Connecting too early hits a race where chromeWs is null.
    await this.sleep(3000);
  }

  /**
   * Extension mode boot: launch Chrome with unpacked extension,
   * navigate to target URL, open side panel, inject provider,
   * connect CDP to the side panel target.
   */
  private async bootExtension(): Promise<void> {
    const extPath = this.opts.extensionPath!;
    const targetUrl = this.opts.extensionUrl ?? 'about:blank';
    const profileDir = resolve(tmpdir(), `slicc-ext-test-${this.opts.port}`);

    // Clean profile
    try {
      execSync(`rm -rf ${JSON.stringify(profileDir)}`, { stdio: 'ignore' });
      this.log(`Cleaned extension profile: ${profileDir}`);
    } catch {
      /* may not exist */
    }

    // Find Chrome and detect variant
    const { path: chromePath, branded } = this.findChromeWithVariant();
    this.log(`Using Chrome: ${chromePath} (${branded ? 'branded' : 'chromium'})`);

    if (branded) {
      // Branded Chrome (Canary/Stable 137+): two-step pipe dance
      await this.launchBrandedWithExtension(chromePath, extPath, profileDir, targetUrl);
    } else {
      // Chromium: simple --load-extension
      this.serverProcess = spawn(
        chromePath,
        [
          `--remote-debugging-port=${this.opts.port}`,
          `--user-data-dir=${profileDir}`,
          `--load-extension=${resolve(extPath)}`,
          `--disable-extensions-except=${resolve(extPath)}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-crash-reporter',
          '--window-size=1920,1080',
          targetUrl,
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        }
      );
    }
    this.chromeCdpPort = this.opts.port;

    const verbose = !!process.env['LOAD_TEST_VERBOSE'];
    const tag = `[inst-${this.opts.index}]`;
    if (verbose) {
      this.serverProcess.stdout?.on('data', (chunk: Buffer) => {
        for (const l of chunk.toString().split('\n').filter(Boolean)) console.log(`${tag} ${l}`);
      });
      this.serverProcess.stderr?.on('data', (chunk: Buffer) => {
        for (const l of chunk.toString().split('\n').filter(Boolean)) console.error(`${tag} ${l}`);
      });
    }

    // Wait for CDP to be ready
    this.log('Waiting for Chrome CDP...');
    await this.waitForChromeCDP(this.opts.port);
    this.log('Chrome CDP ready.');

    // Wait for page to load
    await this.sleep(3000);

    // Open the side panel using cdp-ext-pilot approach
    // Discover extension ID from targets (skip if already set by pipe dance)
    if (!this.extensionId) {
      this.extensionId = await this.discoverExtensionId();
    }
    this.log(`Extension ID: ${this.extensionId}`);

    this.log('Opening side panel...');
    const sidePanelTargetId = await this.openSidePanel();
    this.log(`Side panel opened: ${sidePanelTargetId}`);

    // Connect CDP to the side panel target
    const sidePanelWsUrl = await this.getTargetWsUrl(sidePanelTargetId);
    await this.connectCDPToUrl(sidePanelWsUrl);
    this.log('CDP connected to side panel.');

    // Inject provider if configured
    if (this.opts.adobeToken || this.opts.bedrockApiKey) {
      const { accountJson, selectedModel, providerName } = this.buildProviderAccount();
      this.log(`Injecting ${providerName} provider...`);
      await this.cdpEval(`
        (function() {
          localStorage.setItem('slicc_accounts', ${JSON.stringify(accountJson)});
          localStorage.setItem('selected-model', ${JSON.stringify(selectedModel)});
          return 'injected';
        })()
      `);

      // Reload the side panel to pick up provider
      this.log('Reloading side panel...');
      await this.cdpEval('window.location.reload()');
      if (this.cdpWs) {
        try {
          this.cdpWs.close();
        } catch {
          /* ignore */
        }
        this.cdpWs = null;
      }
      this.cdpCallbacks.clear();
      await this.sleep(3000);

      // Reconnect to the side panel (target ID may change after reload)
      const newSidePanelId = await this.findSidePanelTarget();
      const newWsUrl = await this.getTargetWsUrl(newSidePanelId);
      await this.connectCDPToUrl(newWsUrl);
      this.log('Reconnected to side panel after provider injection.');
    }

    // Wait for the UI to be ready (dialog dismissed or chat visible)
    this.log('Waiting for side panel UI ready...');
    await this.waitForAgentIdle(60_000);
    this.log('Side panel ready.');
  }

  /** Find Chrome and detect if it's a branded build (needs pipe dance). */
  private findChromeWithVariant(): { path: string; branded: boolean } {
    const candidates: Array<{ path: string; branded: boolean }> = [
      {
        path: '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        branded: true,
      },
      { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', branded: true },
      { path: '/Applications/Chromium.app/Contents/MacOS/Chromium', branded: false },
    ];
    for (const c of candidates) {
      try {
        execSync(`test -x ${JSON.stringify(c.path)}`, { stdio: 'ignore' });
        return c;
      } catch {
        /* try next */
      }
    }
    throw new Error('No Chrome or Chromium found');
  }

  /**
   * Launch branded Chrome with extension using the pipe dance:
   * 1. Start with --remote-debugging-pipe, load extension via Extensions.loadUnpacked
   * 2. Kill, then restart with --remote-debugging-port
   */
  private async launchBrandedWithExtension(
    chromePath: string,
    extPath: string,
    profileDir: string,
    targetUrl: string
  ): Promise<void> {
    this.log('Branded Chrome: loading extension via pipe...');

    // Step 1: pipe launch to load extension
    const child1 = spawn(
      chromePath,
      [
        '--remote-debugging-pipe',
        '--enable-unsafe-extension-debugging',
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1920,1080',
      ],
      {
        stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
        detached: false,
      }
    );

    const pipeIn = child1.stdio[3] as NodeJS.WritableStream;
    const pipeOut = child1.stdio[4] as NodeJS.ReadableStream;

    // Send Extensions.loadUnpacked via pipe
    await new Promise<void>((resolveLoad, rejectLoad) => {
      child1.on('error', (err) => rejectLoad(new Error(`Chrome failed: ${err.message}`)));

      let buf = Buffer.alloc(0);
      pipeOut.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        let idx: number;
        while ((idx = buf.indexOf(0)) !== -1) {
          const msg = buf.subarray(0, idx).toString();
          buf = buf.subarray(idx + 1);
          const parsed = JSON.parse(msg) as {
            id?: number;
            result?: { id?: string };
            error?: { message?: string };
          };
          if (parsed.id === 1) {
            if (parsed.result?.id) {
              this.extensionId = parsed.result.id;
              this.log(`Extension loaded: ${parsed.result.id}`);
              resolveLoad();
            } else {
              rejectLoad(new Error(parsed.error?.message ?? 'Failed to load extension'));
            }
          }
        }
      });

      setTimeout(() => {
        const cmd =
          JSON.stringify({
            id: 1,
            method: 'Extensions.loadUnpacked',
            params: { path: resolve(extPath) },
          }) + '\0';
        pipeIn.write(cmd);
      }, 3000);

      setTimeout(() => rejectLoad(new Error('Timed out loading extension via pipe')), 20_000);
    });

    // Close pipe session and kill first Chrome
    pipeIn.end();
    (pipeOut as NodeJS.ReadableStream).destroy();
    child1.kill();
    await this.sleep(2000);

    // Step 2: restart with CDP port
    this.log('Restarting Chrome with CDP port...');
    this.serverProcess = spawn(
      chromePath,
      [
        `--remote-debugging-port=${this.opts.port}`,
        `--user-data-dir=${profileDir}`,
        '--enable-unsafe-extension-debugging',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-crash-reporter',
        '--window-size=1920,1080',
        targetUrl,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      }
    );
  }

  /** Wait for Chrome's CDP endpoint to respond. */
  private async waitForChromeCDP(port: number, maxMs = 30_000): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      this.throwIfAborted();
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(2000),
        });
        if (resp.ok) return;
      } catch {
        /* not ready */
      }
      await this.sleep(500);
    }
    throw new Error(`Chrome CDP not ready after ${maxMs}ms`);
  }

  /** Discover the extension ID from browser targets. */
  private async discoverExtensionId(): Promise<string> {
    const port = this.chromeCdpPort!;
    const versionResp = await fetch(`http://127.0.0.1:${port}/json/version`);
    const { webSocketDebuggerUrl } = (await versionResp.json()) as {
      webSocketDebuggerUrl: string;
    };
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise<void>((r, j) => {
      ws.on('open', () => r());
      ws.on('error', j);
      setTimeout(() => j(new Error('WS timeout')), 5000);
    });

    return new Promise<string>((resolve, reject) => {
      ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('getTargets timeout'));
      }, 5000);
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as {
          id?: number;
          result?: {
            targetInfos?: Array<{ url: string }>;
          };
        };
        if (msg.id === 1) {
          clearTimeout(timeout);
          // Find the slicc extension by looking for its service-worker.js
          for (const t of msg.result?.targetInfos ?? []) {
            const match = t.url.match(/chrome-extension:\/\/([a-z]{32})\/service-worker\.js/);
            if (match) {
              ws.close();
              resolve(match[1]!);
              return;
            }
          }
          ws.close();
          reject(new Error('No extension targets found'));
        }
      });
    });
  }

  /**
   * Open the SLICC side panel using the cdp-ext-pilot approach:
   * 1. Find the extension's content script context on the page
   * 2. Send chrome.runtime.sendMessage({type: 'open_side_panel'})
   * 3. Poll Target.getTargets for the side panel target
   */
  private async openSidePanel(): Promise<string> {
    const port = this.chromeCdpPort!;

    // Find the page target
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Array<{
      type: string;
      url: string;
      webSocketDebuggerUrl?: string;
    }>;

    const page = targets.find(
      (t) =>
        t.type === 'page' &&
        !t.url.startsWith('chrome-extension://') &&
        !t.url.startsWith('chrome://')
    );
    if (!page?.webSocketDebuggerUrl) {
      throw new Error('No page target found for side panel');
    }

    // Connect to page, find extension content script context
    const pageWs = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      pageWs.on('open', () => resolve());
      pageWs.on('error', reject);
      setTimeout(() => reject(new Error('Page WS timeout')), 5000);
    });

    let pageId = 1;
    const pageSend = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = pageId++;
        const timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 10_000);
        const handler = (raw: WebSocket.RawData) => {
          const msg = JSON.parse(String(raw)) as Record<string, unknown>;
          if (msg.id === id) {
            pageWs.off('message', handler);
            clearTimeout(timeout);
            if (msg.error)
              reject(new Error(String((msg.error as Record<string, unknown>).message)));
            else resolve(msg.result as Record<string, unknown>);
          }
        };
        pageWs.on('message', handler);
        pageWs.send(JSON.stringify({ id, method, params }));
      });

    // Find extension content script context
    const extCtxId = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        pageWs.off('message', handler);
        reject(new Error('No extension content script context found'));
      }, 10_000);
      const handler = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(String(raw)) as Record<string, unknown>;
        if (msg.method === 'Runtime.executionContextCreated') {
          const params = msg.params as { context: { id: number; origin: string } };
          if (this.extensionId && params.context.origin.includes(this.extensionId)) {
            pageWs.off('message', handler);
            clearTimeout(timer);
            resolve(params.context.id);
          }
        }
      };
      pageWs.on('message', handler);
      pageSend('Runtime.enable').catch(reject);
    });

    // Send open_side_panel message with userGesture
    await pageSend('Runtime.evaluate', {
      contextId: extCtxId,
      expression: 'chrome.runtime.sendMessage({type: "open_side_panel"})',
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    pageWs.close();

    // Poll for side panel target
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const id = await this.findSidePanelTarget().catch(() => null);
      if (id) return id;
      await this.sleep(500);
    }
    throw new Error('Side panel did not appear');
  }

  /** Find the side panel target ID via browser-level CDP. */
  private async findSidePanelTarget(): Promise<string> {
    const port = this.chromeCdpPort!;
    const versionResp = await fetch(`http://127.0.0.1:${port}/json/version`);
    const { webSocketDebuggerUrl } = (await versionResp.json()) as {
      webSocketDebuggerUrl: string;
    };

    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise<void>((r, j) => {
      ws.on('open', () => r());
      ws.on('error', j);
      setTimeout(() => j(new Error('Browser WS timeout')), 5000);
    });

    return new Promise<string>((resolve, reject) => {
      ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('getTargets timeout'));
      }, 5000);
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as {
          id?: number;
          result?: { targetInfos?: Array<{ targetId: string; url: string; type: string }> };
        };
        if (msg.id === 1) {
          clearTimeout(timeout);
          const panel = msg.result?.targetInfos?.find(
            (t) =>
              this.extensionId && t.url.includes(this.extensionId) && t.url.includes('index.html')
          );
          ws.close();
          if (panel) resolve(panel.targetId);
          else reject(new Error('Side panel target not found'));
        }
      });
    });
  }

  /** Get a target's WebSocket debugger URL by ID. */
  private async getTargetWsUrl(targetId: string): Promise<string> {
    const port = this.chromeCdpPort!;
    const versionResp = await fetch(`http://127.0.0.1:${port}/json/version`);
    const { webSocketDebuggerUrl: browserWsUrl } = (await versionResp.json()) as {
      webSocketDebuggerUrl: string;
    };

    const ws = new WebSocket(browserWsUrl);
    await new Promise<void>((r, j) => {
      ws.on('open', () => r());
      ws.on('error', j);
      setTimeout(() => j(new Error('Browser WS timeout')), 5000);
    });

    return new Promise<string>((resolve, reject) => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Target.attachToTarget',
          params: { targetId, flatten: true },
        })
      );
      // For flattened sessions, the WS URL is the browser URL itself
      // but we need to use the page-level /devtools/page/ URL
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('attachToTarget timeout'));
      }, 5000);
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as Record<string, unknown>;
        if (msg.id === 1) {
          clearTimeout(timeout);
          ws.close();
          // Construct the page-level WS URL
          resolve(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
        }
      });
    });
  }

  /** Connect CDP to a specific WebSocket URL (for side panel target). */
  private connectCDPToUrl(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.cdpWs = new WebSocket(wsUrl);

      const timeout = setTimeout(() => reject(new Error('CDP connection timeout')), 10_000);

      this.cdpWs.on('open', () => {
        clearTimeout(timeout);
        this.cdpSend('Runtime.enable', {}).then(() => resolve(), reject);
      });

      this.cdpWs.on('message', (raw) => {
        this.handleCdpMessage(String(raw));
      });

      this.cdpWs.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private async connectAndWaitIdle(): Promise<void> {
    this.log('Connecting CDP...');
    await this.connectCDP();

    this.log('CDP connected. Waiting for agent idle...');
    await this.waitForAgentIdle(60_000);
    this.log('Agent idle.');
  }

  /**
   * Connect CDP, inject the Adobe provider into localStorage, reload,
   * then wait for agent idle. This must happen BEFORE the first
   * waitForAgentIdle — otherwise the app shows a setup dialog
   * (no accounts) that blocks the chat UI.
   *
   * Writes two localStorage keys:
   *   slicc_accounts  — account with accessToken + 24h expiry
   *   selected-model  — "adobe:<modelId>"
   *
   * See: packages/webapp/src/ui/provider-settings.ts
   */
  private async connectAndInjectProvider(): Promise<void> {
    this.log('Connecting CDP...');
    await this.connectCDP();

    const { accountJson, selectedModel, providerName } = this.buildProviderAccount();
    this.log(`CDP connected. Injecting ${providerName} provider...`);

    await this.cdpEval(`
      (function() {
        localStorage.setItem('slicc_accounts', ${JSON.stringify(accountJson)});
        localStorage.setItem('selected-model', ${JSON.stringify(selectedModel)});
        return 'injected';
      })()
    `);

    this.log('Reloading page to pick up provider config...');
    await this.cdpEval('window.location.reload()');

    // The page target WebSocket dies on reload — close and reconnect.
    this.log('Reconnecting CDP to new page target...');
    if (this.cdpWs) {
      try {
        this.cdpWs.close();
      } catch {
        /* ignore */
      }
      this.cdpWs = null;
    }
    this.cdpCallbacks.clear();
    await this.sleep(2000); // Let the new page target register
    await this.connectCDP();

    this.log('Waiting for agent idle (post-reload)...');
    await this.waitForAgentIdle(60_000);
    this.log('Agent idle with provider configured.');
  }

  /** Build the localStorage account entry for the configured provider. */
  private buildProviderAccount(): {
    accountJson: string;
    selectedModel: string;
    providerName: string;
  } {
    if (this.opts.bedrockApiKey) {
      const modelId = this.opts.bedrockModelId ?? 'global.anthropic.claude-sonnet-4-6';
      return {
        accountJson: JSON.stringify([
          {
            providerId: 'bedrock-camp',
            apiKey: this.opts.bedrockApiKey,
            baseUrl: this.opts.bedrockBaseUrl,
            modelId,
          },
        ]),
        selectedModel: `bedrock-camp:${modelId}`,
        providerName: 'Bedrock CAMP',
      };
    }

    const token = this.opts.adobeToken!;
    const modelId = this.opts.modelId ?? 'claude-sonnet-4-6';
    return {
      accountJson: JSON.stringify([
        {
          providerId: 'adobe',
          apiKey: '',
          accessToken: token,
          tokenExpiresAt: Date.now() + 86_400_000,
        },
      ]),
      selectedModel: `adobe:${modelId}`,
      providerName: 'Adobe',
    };
  }

  private async executeScenario(): Promise<void> {
    this.promptSentAt = Date.now();
    const steps = this.resolveSteps();

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      this.log(`Step ${i + 1}/${steps.length}: ${this.describeStep(step)}`);
      await this.runStep(step);
    }

    this.completedAt = Date.now();
    const secs = ((this.completedAt - this.promptSentAt) / 1000).toFixed(1);
    this.log(`Scenario completed in ${secs}s.`);
  }

  /** Execute a single scenario step. */
  private async runStep(step: ScenarioStep): Promise<void> {
    const remaining = this.remainingMs();
    switch (step.type) {
      case 'prompt':
        await this.executePromptStep(step.text, remaining);
        break;
      case 'click-sprinkle-button':
        await this.clickSprinkleButton(step.label, remaining);
        break;
      case 'wait-idle':
        await this.waitForAgentIdle(remaining);
        break;
      case 'wait-sprinkle-text':
        await this.waitForSprinkleText(step.text, remaining);
        break;
      case 'browse':
        try {
          await this.browseAndRun(step.url, step.script, step.waitMs);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`Browse step failed (non-fatal): ${msg}`);
        }
        break;
      case 'click-button':
        await this.clickButton(step.label, remaining);
        break;
      case 'wait-text':
        await this.waitForText(step.text, remaining);
        break;
      case 'send-lick':
        await this.sendLick(step.action, remaining);
        break;
    }
  }

  /** Convert a simple prompt scenario to steps if no steps are defined. */
  private resolveSteps(): ScenarioStep[] {
    if (this.opts.scenario.steps?.length) {
      return this.opts.scenario.steps;
    }
    return [{ type: 'prompt', text: this.opts.scenario.prompt }];
  }

  private describeStep(step: ScenarioStep): string {
    switch (step.type) {
      case 'prompt':
        return `prompt "${step.text.slice(0, 50)}..."`;
      case 'click-sprinkle-button':
        return `click "${step.label}"`;
      case 'wait-idle':
        return 'wait for agent idle';
      case 'wait-sprinkle-text':
        return `wait for "${step.text}"`;
      case 'browse':
        return `browse ${step.url} + run script`;
      case 'click-button':
        return `click button "${step.label}"`;
      case 'wait-text':
        return `wait for text "${step.text}"`;
      case 'send-lick':
        return `send lick "${step.action}"`;
    }
  }

  private remainingMs(): number {
    const elapsed = Date.now() - this.promptSentAt;
    return Math.max(this.opts.timeoutMs - elapsed, 5000);
  }

  private async executePromptStep(text: string, maxMs: number): Promise<void> {
    await this.submitPrompt(text);
    this.log('Prompt submitted. Waiting for processing...');
    await this.waitForAgentProcessing(15_000);
    this.log('Agent processing.');
    await this.waitForAgentIdle(maxMs);
    this.log('Agent idle.');
  }

  /**
   * Find and click a button inside a sprinkle panel iframe.
   *
   * Sprinkle panels render as .sprinkle-panel > iframe[srcdoc] in CLI mode.
   * The iframe has sandbox="allow-scripts allow-same-origin" so we can
   * access its contentDocument via CDP. We poll until the button appears
   * (the sprinkle may still be loading after upskill completes).
   */
  private async clickSprinkleButton(label: string, maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    const escaped = label.replace(/'/g, "\\'");

    let pollCount = 0;
    while (Date.now() < deadline) {
      this.throwIfAborted();

      const result = (await this.cdpEval(`
        (function() {
          var panels = document.querySelectorAll('.sprinkle-panel');
          var iframes = document.querySelectorAll('.sprinkle-panel iframe');
          if (iframes.length === 0) {
            return { status: 'no_iframes', panels: panels.length };
          }
          var allButtons = [];
          for (var i = 0; i < iframes.length; i++) {
            var doc;
            try { doc = iframes[i].contentDocument; } catch(e) {
              allButtons.push('(cross-origin)');
              continue;
            }
            if (!doc) { allButtons.push('(null doc)'); continue; }
            var buttons = doc.querySelectorAll('button');
            for (var j = 0; j < buttons.length; j++) {
              var text = buttons[j].textContent.trim();
              if (text.indexOf('${escaped}') !== -1) {
                buttons[j].click();
                return { status: 'clicked', text: text };
              }
              allButtons.push(text);
            }
          }
          return {
            status: 'not_found',
            iframes: iframes.length,
            buttons: allButtons.slice(0, 10)
          };
        })()
      `)) as { status: string; text?: string; [k: string]: unknown } | null;

      if (result?.status === 'clicked') {
        this.log(`Sprinkle button clicked: ${result.text}`);
        return;
      }

      // Log diagnostics periodically
      pollCount++;
      if (pollCount % 5 === 1) {
        this.log(`Button poll: ${JSON.stringify(result)}`);
      }

      await this.sleep(1000);
    }

    throw new Error(`Timeout: sprinkle button "${label}" not found after ${maxMs}ms`);
  }

  /**
   * Poll sprinkle iframe content for specific text (e.g., "Migration Complete").
   * Logs progress every 30s with a snippet of what the sprinkle currently shows.
   */
  private async waitForSprinkleText(text: string, maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    const escaped = text.replace(/'/g, "\\'");
    let lastLogAt = 0;

    while (Date.now() < deadline) {
      this.throwIfAborted();

      const result = (await this.cdpEval(`
        (function() {
          // Search assistant chat messages and all iframes for target text.
          // Only assistant messages are checked — avoids matching the user's
          // own prompt which may contain the same sentinel text.
          var snippets = [];

          // Check assistant messages only (class: .msg--assistant .msg__content)
          var assistantEls = document.querySelectorAll('.msg--assistant .msg__content');
          for (var a = 0; a < assistantEls.length; a++) {
            var t = assistantEls[a].textContent || '';
            if (t.indexOf('${escaped}') !== -1) {
              return { found: true, where: 'assistant-msg', snippet: t.slice(0, 200) };
            }
          }

          // Check all iframes (sprinkle panels, tabs, etc.)
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            var doc;
            try { doc = iframes[i].contentDocument; } catch(e) { continue; }
            if (!doc || !doc.body) continue;
            var bodyText = doc.body.textContent || '';
            if (bodyText.indexOf('${escaped}') !== -1) {
              return { found: true, where: 'iframe-' + i, snippet: bodyText.slice(0, 200) };
            }
            var label = iframes[i].closest('[data-sprinkle]')
              ? iframes[i].closest('[data-sprinkle]').dataset.sprinkle
              : 'iframe-' + i;
            snippets.push(label + ': ' + bodyText.replace(/\\n/g, ' ').slice(0, 60));
          }
          return {
            found: false,
            count: iframes.length,
            snippet: snippets.join(' | ') || '(no iframes)'
          };
        })()
      `)) as { found: boolean; snippet: string; count?: number; where?: string } | null;

      if (result?.found) {
        this.log(`Text "${text}" found in ${result.where}`);
        return;
      }

      // Log progress every 30s
      const now = Date.now();
      if (now - lastLogAt > 30_000) {
        lastLogAt = now;
        const elapsed = Math.round((now - (deadline - maxMs)) / 1000);
        const snippet = result?.snippet?.slice(0, 80) ?? '(null)';
        this.log(`Waiting (${elapsed}s)... sprinkle: "${snippet}"`);
      }

      await this.sleep(3000);
    }

    throw new Error(`Timeout: sprinkle text "${text}" not found after ${maxMs}ms`);
  }

  /**
   * Open a URL in a new Chrome tab, wait for load, run a script, close tab.
   * Uses Chrome's /json/new to create the tab (returns target info directly),
   * then connects to the tab's page-level CDP to run the script.
   */
  private async browseAndRun(url: string, script: string, waitMs = 5000): Promise<void> {
    if (!this.chromeCdpPort) {
      throw new Error('Chrome CDP port not available');
    }

    // Create tab via Chrome's HTTP API — returns target info directly
    const createResp = await fetch(
      `http://127.0.0.1:${this.chromeCdpPort}/json/new?${encodeURIComponent(url)}`,
      { method: 'PUT', signal: AbortSignal.timeout(5000) }
    );
    const target = (await createResp.json()) as {
      id: string;
      webSocketDebuggerUrl: string;
    };
    this.log(`Opened tab: ${url} (target: ${target.id})`);

    // Wait for page to load
    await this.sleep(waitMs);

    // Connect to tab's CDP and run script
    const tabWs = new WebSocket(target.webSocketDebuggerUrl);
    try {
      await new Promise<void>((resolve, reject) => {
        tabWs.on('open', () => resolve());
        tabWs.on('error', reject);
        setTimeout(() => reject(new Error('Tab WS timeout')), 5000);
      });

      tabWs.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.enable',
          params: {},
        })
      );
      await this.sleep(500);

      const result = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Script timed out')), 20_000);
        tabWs.on('message', (raw) => {
          try {
            const msg = JSON.parse(String(raw)) as {
              id?: number;
              result?: unknown;
              error?: unknown;
            };
            if (msg.id === 2) {
              clearTimeout(timeout);
              const r = msg.result ?? msg.error ?? 'no result';
              resolve(JSON.stringify(r).slice(0, 200));
            }
          } catch {
            // Ignore parse errors from other CDP events
          }
        });
        tabWs.send(
          JSON.stringify({
            id: 2,
            method: 'Runtime.evaluate',
            params: {
              expression: script,
              awaitPromise: true,
              returnByValue: true,
            },
          })
        );
      });
      this.log(`Script result: ${result}`);
      await this.sleep(2000);
    } finally {
      tabWs.close();
    }

    // Close the tab
    await fetch(`http://127.0.0.1:${this.chromeCdpPort}/json/close/${target.id}`, {
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
    this.log('Tab closed.');
  }

  /**
   * Click a button by label text in the current page (side panel or main).
   * Searches all buttons including inside iframes.
   */
  private async clickButton(label: string, maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    const escaped = label.replace(/'/g, "\\'");
    let pollCount = 0;

    while (Date.now() < deadline) {
      this.throwIfAborted();

      const result = (await this.cdpEval(`
        (function() {
          // Search buttons in main document
          var buttons = document.querySelectorAll('button');
          for (var i = 0; i < buttons.length; i++) {
            if (buttons[i].textContent.trim().indexOf('${escaped}') !== -1) {
              buttons[i].click();
              return { clicked: true, text: buttons[i].textContent.trim() };
            }
          }
          // Search inside iframes (sprinkle sandboxes)
          var iframes = document.querySelectorAll('iframe');
          for (var j = 0; j < iframes.length; j++) {
            var doc;
            try { doc = iframes[j].contentDocument; } catch(e) { continue; }
            if (!doc) continue;
            var ibtns = doc.querySelectorAll('button');
            for (var k = 0; k < ibtns.length; k++) {
              if (ibtns[k].textContent.trim().indexOf('${escaped}') !== -1) {
                ibtns[k].click();
                return { clicked: true, text: ibtns[k].textContent.trim(), iframe: true };
              }
            }
          }
          return { clicked: false };
        })()
      `)) as { clicked: boolean; text?: string; iframe?: boolean } | null;

      if (result?.clicked) {
        this.log(`Button clicked: "${result.text}"${result.iframe ? ' (in iframe)' : ''}`);
        return;
      }

      pollCount++;
      if (pollCount % 5 === 1) {
        this.log(`Waiting for button "${label}"...`);
      }
      await this.sleep(1000);
    }

    throw new Error(`Timeout: button "${label}" not found after ${maxMs}ms`);
  }

  /**
   * Wait for specific text to appear anywhere in the page (including iframes).
   * Polls every 3s, logs progress every 30s.
   */
  private async waitForText(text: string, maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    const escaped = text.replace(/'/g, "\\'");
    let lastLogAt = 0;

    while (Date.now() < deadline) {
      this.throwIfAborted();

      const result = (await this.cdpEval(`
        (function() {
          // Check main document
          var mainText = document.body.textContent || '';
          if (mainText.indexOf('${escaped}') !== -1) {
            return { found: true, where: 'main' };
          }
          // Check iframes
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            var doc;
            try { doc = iframes[i].contentDocument; } catch(e) { continue; }
            if (!doc || !doc.body) continue;
            var t = doc.body.textContent || '';
            if (t.indexOf('${escaped}') !== -1) {
              return { found: true, where: 'iframe-' + i };
            }
          }
          return { found: false };
        })()
      `)) as { found: boolean; where?: string } | null;

      if (result?.found) {
        this.log(`Text "${text}" found in ${result.where}`);
        return;
      }

      // Extension mode: also check sandbox targets via browser CDP
      if (this.opts.extensionPath && this.chromeCdpPort) {
        const sandboxFound = await this.checkSandboxText(escaped);
        if (sandboxFound) {
          this.log(`Text "${text}" found in sandbox`);
          return;
        }
      }

      const now = Date.now();
      if (now - lastLogAt > 30_000) {
        lastLogAt = now;
        const elapsed = Math.round((now - (deadline - maxMs)) / 1000);
        this.log(`Waiting for "${text}" (${elapsed}s)...`);
      }

      await this.sleep(3000);
    }

    throw new Error(`Timeout: text "${text}" not found after ${maxMs}ms`);
  }

  /**
   * Send a lick event by dispatching postMessage from the sprinkle sandbox.
   * The message goes to the parent (side panel) and passes the event.source
   * check because it originates from the sandbox iframe's contentWindow.
   *
   * Polls for the sandbox target to appear (it may not exist yet if the
   * sprinkle is still loading).
   */
  /**
   * Send a lick event from the sprinkle sandbox.
   * Caches the sandbox target ID for fast subsequent calls.
   */
  private async sendLick(action: string, maxMs: number): Promise<void> {
    if (!this.chromeCdpPort) {
      throw new Error('Chrome CDP port not available for sendLick');
    }

    // Find sandbox target ID — re-discover each time since the sandbox
    // target is recreated when sprinkles change (e.g., welcome → migration)
    const t0 = Date.now();
    this.sandboxTargetId = await this.findSandboxTargetId(maxMs);
    this.log(`Sandbox found in ${Date.now() - t0}ms`);

    // Connect, attach, send lick — single fast operation
    const browserWsUrl = await this.getBrowserWsUrl();
    const browserWs = new WebSocket(browserWsUrl);
    try {
      await new Promise<void>((r, j) => {
        browserWs.on('open', () => r());
        browserWs.on('error', j);
        setTimeout(() => j(new Error('WS timeout')), 5000);
      });

      const { bSend } = this.makeBrowserSender(browserWs);

      const att = await bSend('Target.attachToTarget', {
        targetId: this.sandboxTargetId,
        flatten: true,
      });
      const sid = (att as { sessionId: string }).sessionId;
      await bSend('Runtime.enable', {}, sid);
      await bSend(
        'Runtime.evaluate',
        {
          expression: `parent.postMessage({ type: "sprinkle-lick", action: "${action}", data: null }, "*")`,
          returnByValue: true,
        },
        sid
      );
      this.log(`Lick "${action}" sent from sandbox (total ${Date.now() - t0}ms).`);
    } finally {
      try {
        browserWs.close();
      } catch {
        /* ignore */
      }
    }
  }

  /** Poll for the sprinkle sandbox target ID. */
  private async findSandboxTargetId(maxMs: number): Promise<string> {
    const deadline = Date.now() + maxMs;
    const browserWsUrl = await this.getBrowserWsUrl();

    while (Date.now() < deadline) {
      this.throwIfAborted();
      const browserWs = new WebSocket(browserWsUrl);
      try {
        await new Promise<void>((r, j) => {
          browserWs.on('open', () => r());
          browserWs.on('error', j);
          setTimeout(() => j(new Error('WS timeout')), 5000);
        });
        const { bSend } = this.makeBrowserSender(browserWs);
        const targets = (await bSend('Target.getTargets')) as {
          targetInfos: Array<{ targetId: string; url: string }>;
        };
        const sandbox = targets.targetInfos.find((t) => t.url.includes('sprinkle-sandbox.html'));
        if (sandbox) {
          browserWs.close();
          return sandbox.targetId;
        }
      } catch {
        /* retry */
      } finally {
        try {
          browserWs.close();
        } catch {
          /* ignore */
        }
      }
      await this.sleep(1000);
    }
    throw new Error('Sandbox target not found');
  }

  /** Create a send helper for a browser-level WebSocket. */
  private makeBrowserSender(browserWs: WebSocket): {
    bSend: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string
    ) => Promise<Record<string, unknown>>;
  } {
    let bId = 1;
    const bSend = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      const id = bId++;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 10_000);
        const handler = (raw: WebSocket.RawData) => {
          const msg = JSON.parse(String(raw)) as Record<string, unknown>;
          if (msg.id === id) {
            browserWs.off('message', handler);
            clearTimeout(timer);
            if (msg.error) {
              const e = msg.error as Record<string, unknown>;
              reject(new Error(String(e.message ?? 'CDP error')));
            } else {
              resolve((msg.result ?? {}) as Record<string, unknown>);
            }
          }
        };
        browserWs.on('message', handler);
        const payload: Record<string, unknown> = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        browserWs.send(JSON.stringify(payload));
      });
    };
    return { bSend };
  }

  /** Check if text exists in any sprinkle sandbox target. */
  private async checkSandboxText(escaped: string): Promise<boolean> {
    let browserWs: WebSocket | null = null;
    try {
      const browserWsUrl = await this.getBrowserWsUrl();
      browserWs = new WebSocket(browserWsUrl);
      await new Promise<void>((r, j) => {
        browserWs!.on('open', () => r());
        browserWs!.on('error', j);
        setTimeout(() => j(new Error('WS timeout')), 5000);
      });

      let bId = 1;
      const bSend = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
        const id = bId++;
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout')), 10_000);
          const handler = (raw: WebSocket.RawData) => {
            const msg = JSON.parse(String(raw)) as Record<string, unknown>;
            if (msg.id === id) {
              browserWs!.off('message', handler);
              clearTimeout(timer);
              resolve((msg.result ?? {}) as Record<string, unknown>);
            }
          };
          browserWs!.on('message', handler);
          const payload: Record<string, unknown> = { id, method, params };
          if (sessionId) payload.sessionId = sessionId;
          browserWs!.send(JSON.stringify(payload));
        });
      };

      const targets = (await bSend('Target.getTargets')) as {
        targetInfos: Array<{ targetId: string; url: string }>;
      };

      for (const t of targets.targetInfos) {
        if (!t.url.includes('sprinkle-sandbox.html')) continue;
        try {
          const att = await bSend('Target.attachToTarget', {
            targetId: t.targetId,
            flatten: true,
          });
          const sid = (att as { sessionId: string }).sessionId;
          await bSend('Runtime.enable', {}, sid);
          const result = (await bSend(
            'Runtime.evaluate',
            {
              expression: `document.body?.innerText?.includes('${escaped}') || false`,
              returnByValue: true,
            },
            sid
          )) as { result?: { value?: boolean } };
          if (result.result?.value) return true;
        } catch {
          // sandbox not accessible
        }
      }
    } catch {
      // browser WS failed
    } finally {
      try {
        browserWs?.close();
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  /** Get the browser-level WebSocket debugger URL. */
  private async getBrowserWsUrl(): Promise<string> {
    const resp = await fetch(`http://127.0.0.1:${this.chromeCdpPort}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });
    const json = (await resp.json()) as { webSocketDebuggerUrl: string };
    return json.webSocketDebuggerUrl;
  }

  private async verifyAndReport(): Promise<InstanceResult> {
    if (this.opts.scenario.expectFile) {
      this.log(`Verifying: ${this.opts.scenario.expectFile}`);
      const ok = await this.verifyFile();
      if (!ok) {
        const msg = `Expected file not found: ${this.opts.scenario.expectFile}`;
        this.log(`FAIL — ${msg}`);
        return this.buildResult('fail', msg);
      }
    }
    this.log('PASS');
    return this.buildResult('pass');
  }

  // ---------------------------------------------------------------------------
  // Server lifecycle
  // ---------------------------------------------------------------------------

  private spawnServer(): void {
    const args = [resolve(REPO_ROOT, 'dist/node-server/index.js')];
    if (this.opts.envFile) {
      args.push(`--env-file=${this.opts.envFile}`);
    }

    this.serverProcess = spawn('node', args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(this.opts.port),
        CHROME_WINDOW_SIZE: '1920,1080',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    const verbose = !!process.env['LOAD_TEST_VERBOSE'];
    const tag = `[inst-${this.opts.index}]`;

    // Parse Chrome CDP port from stdout: "Chrome CDP listening on port XXXXX"
    this.serverProcess.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      const match = text.match(/CDP listening on port (\d+)/);
      if (match) {
        this.chromeCdpPort = parseInt(match[1]!, 10);
      }
      if (verbose) {
        for (const l of text.split('\n').filter(Boolean)) {
          console.log(`${tag} ${l}`);
        }
      }
    });
    if (verbose) {
      this.serverProcess.stderr?.on('data', (chunk: Buffer) => {
        for (const l of chunk.toString().split('\n').filter(Boolean)) {
          console.error(`${tag} ${l}`);
        }
      });
    }
  }

  private async waitForReady(maxMs = 60_000): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      this.throwIfAborted();
      try {
        const url = `http://localhost:${this.opts.port}/api/runtime-config`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (resp.ok) return;
      } catch {
        // server not up yet
      }
      await this.sleep(500);
    }
    throw new Error(`Server readiness timeout after ${maxMs}ms`);
  }

  // ---------------------------------------------------------------------------
  // CDP connection and evaluation
  // ---------------------------------------------------------------------------

  /**
   * Connect to a Chrome page target's CDP WebSocket directly.
   *
   * The SLICC server's /cdp proxy connects to the browser-level target,
   * which doesn't support Runtime.enable. Instead, we query Chrome's
   * /json endpoint to discover the page target for localhost:{port},
   * then connect to its webSocketDebuggerUrl directly.
   */
  private async connectCDP(): Promise<void> {
    if (!this.chromeCdpPort) {
      throw new Error('Chrome CDP port not captured from server output');
    }

    // Find the page target for our SLICC instance
    const pageWsUrl = await this.findPageTarget(this.chromeCdpPort);

    return new Promise((resolve, reject) => {
      this.cdpWs = new WebSocket(pageWsUrl);

      const timeout = setTimeout(() => reject(new Error('CDP connection timeout')), 10_000);

      this.cdpWs.on('open', () => {
        clearTimeout(timeout);
        this.cdpSend('Runtime.enable', {}).then(() => resolve(), reject);
      });

      this.cdpWs.on('message', (raw) => {
        this.handleCdpMessage(String(raw));
      });

      this.cdpWs.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /** Poll Chrome's /json endpoint to find the page target for our port. */
  private async findPageTarget(chromeCdpPort: number, maxMs = 15_000): Promise<string> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      this.throwIfAborted();
      try {
        const resp = await fetch(`http://127.0.0.1:${chromeCdpPort}/json`, {
          signal: AbortSignal.timeout(2000),
        });
        const targets = (await resp.json()) as Array<{
          type: string;
          url: string;
          webSocketDebuggerUrl?: string;
        }>;
        const page = targets.find(
          (t) =>
            t.type === 'page' &&
            t.url.includes(`localhost:${this.opts.port}`) &&
            t.webSocketDebuggerUrl
        );
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      } catch {
        // Chrome not ready yet
      }
      await this.sleep(500);
    }
    throw new Error(`Could not find page target on CDP port ${chromeCdpPort}`);
  }

  private handleCdpMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
      };
      if (msg.id == null || !this.cdpCallbacks.has(msg.id)) return;
      const cb = this.cdpCallbacks.get(msg.id)!;
      this.cdpCallbacks.delete(msg.id);
      if (msg.error) {
        cb.reject(new Error(msg.error.message ?? 'CDP error'));
      } else {
        cb.resolve(msg.result);
      }
    } catch {
      // ignore malformed messages
    }
  }

  private cdpSend(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.cdpWs || this.cdpWs.readyState !== WebSocket.OPEN) {
        reject(new Error('CDP not connected'));
        return;
      }
      const id = this.cdpIdCounter++;
      this.cdpCallbacks.set(id, { resolve, reject });
      this.cdpWs.send(JSON.stringify({ id, method, params }));

      setTimeout(() => {
        if (this.cdpCallbacks.has(id)) {
          this.cdpCallbacks.delete(id);
          reject(new Error(`CDP call ${method} timed out`));
        }
      }, 15_000);
    });
  }

  /** Evaluate JS in the page, returning the result by value. */
  private async cdpEval(expression: string): Promise<unknown> {
    const result = (await this.cdpSend('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown } };
    return result?.result?.value;
  }

  // ---------------------------------------------------------------------------
  // Agent state detection
  //
  // The chat panel toggles the stop button visible when streaming:
  //   chat__stop-btn.style.display === 'flex'  → processing
  //   chat__stop-btn.style.display === 'none'  → idle/ready
  // See: packages/webapp/src/ui/chat-panel.ts:886
  // ---------------------------------------------------------------------------

  private async getAgentState(): Promise<'processing' | 'idle' | 'not_loaded'> {
    const state = await this.cdpEval(`
      (function() {
        var stop = document.querySelector('.chat__stop-btn');
        if (!stop) return 'not_loaded';
        return stop.style.display === 'flex' ? 'processing' : 'idle';
      })()
    `);
    if (state === 'processing' || state === 'idle') return state;
    return 'not_loaded';
  }

  /** Polls until the agent is idle. Handles not_loaded (page still booting). */
  private async waitForAgentIdle(maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      this.throwIfAborted();
      const state = await this.getAgentState();
      if (state === 'idle') return;
      // Faster polling during boot, slower once processing
      await this.sleep(state === 'not_loaded' ? 500 : 1000);
    }
    throw new Error(`Timeout waiting for agent idle after ${maxMs}ms`);
  }

  private async waitForAgentProcessing(maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      this.throwIfAborted();
      const state = await this.getAgentState();
      if (state === 'processing') return;
      await this.sleep(500);
    }
    throw new Error(`Timeout waiting for agent processing after ${maxMs}ms`);
  }

  // ---------------------------------------------------------------------------
  // Prompt submission
  //
  // Sets the textarea value via the native setter, dispatches an input event,
  // then clicks the send button.
  // Selectors: .chat__textarea, .chat__send-btn (from chat-panel.ts:348,353)
  // ---------------------------------------------------------------------------

  private async submitPrompt(text?: string): Promise<void> {
    const prompt = text ?? this.opts.scenario.prompt;
    const escaped = prompt.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');

    const result = await this.cdpEval(`
      (function() {
        var ta = document.querySelector('.chat__textarea');
        if (!ta) throw new Error('Chat textarea not found');

        var setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype, 'value'
        ).set;
        setter.call(ta, \`${escaped}\`);
        ta.dispatchEvent(new Event('input', { bubbles: true }));

        var btn = document.querySelector('.chat__send-btn');
        if (btn) { btn.click(); return 'sent_via_button'; }

        throw new Error('Send button not found');
      })()
    `);

    if (!result) {
      throw new Error('Prompt submission returned no result');
    }
  }

  // ---------------------------------------------------------------------------
  // VFS verification
  //
  // Uses window.__slicc_orchestrator.sharedFs (exposed in dev mode at
  // main.ts:1489) to read files from the VFS. Falls back to checking
  // the last assistant chat message for mentions of the expected file.
  // ---------------------------------------------------------------------------

  private async verifyFile(): Promise<boolean> {
    const filePath = this.opts.scenario.expectFile!;
    const expectContains = this.opts.scenario.expectContains;

    const result = (await this.cdpEval(`
      (async function() {
        try {
          var orch = window.__slicc_orchestrator;
          if (orch && orch.sharedFs) {
            var content = await orch.sharedFs.readFile(
              '${filePath}', { encoding: 'utf8' }
            );
            return { exists: true, content: String(content).slice(0, 2000) };
          }
          return { exists: false, error: 'No orchestrator on window' };
        } catch (e) {
          return { exists: false, error: e.message };
        }
      })()
    `)) as { exists: boolean; content?: string; error?: string } | undefined;

    if (!result?.exists) {
      this.log(`VFS verify failed: ${result?.error ?? 'unknown error'}`);
      return false;
    }
    if (expectContains && result.content) {
      return result.content.includes(expectContains);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  /** Capture a screenshot of the browser page and save to the output dir. */
  private async captureScreenshot(): Promise<void> {
    const outDir = resolve(__dirname, 'output');
    mkdirSync(outDir, { recursive: true });
    const ts = Date.now();
    const prefix = `screenshot-inst${this.opts.index}-port${this.opts.port}-${ts}`;

    // Side panel / main page screenshot
    if (this.cdpWs && this.cdpWs.readyState === WebSocket.OPEN) {
      try {
        const result = (await this.cdpSend('Page.captureScreenshot', {
          format: 'png',
        })) as { data?: string };
        if (result?.data) {
          const name = `${prefix}-panel.png`;
          writeFileSync(resolve(outDir, name), Buffer.from(result.data, 'base64'));
          this.log(`Screenshot saved: ${name}`);
        }
      } catch {
        this.log('Panel screenshot failed');
      }
    }

    // Extension mode: also capture the page target (full browser tab)
    if (this.opts.extensionPath && this.chromeCdpPort) {
      try {
        const targets = (await (
          await fetch(`http://127.0.0.1:${this.chromeCdpPort}/json`)
        ).json()) as Array<{
          type: string;
          url: string;
          webSocketDebuggerUrl?: string;
        }>;
        const page = targets.find(
          (t) =>
            t.type === 'page' &&
            !t.url.startsWith('chrome-extension://') &&
            !t.url.startsWith('chrome://')
        );
        if (page?.webSocketDebuggerUrl) {
          const pageWs = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise<void>((r, j) => {
            pageWs.on('open', () => r());
            pageWs.on('error', j);
            setTimeout(() => j(new Error('timeout')), 5000);
          });
          const result = await new Promise<string | null>((resolve) => {
            pageWs.send(
              JSON.stringify({
                id: 1,
                method: 'Page.captureScreenshot',
                params: { format: 'png' },
              })
            );
            const timer = setTimeout(() => {
              resolve(null);
            }, 10_000);
            pageWs.on('message', (raw) => {
              const msg = JSON.parse(String(raw)) as {
                id?: number;
                result?: { data?: string };
              };
              if (msg.id === 1) {
                clearTimeout(timer);
                resolve(msg.result?.data ?? null);
              }
            });
          });
          pageWs.close();
          if (result) {
            const name = `${prefix}-page.png`;
            writeFileSync(resolve(outDir, name), Buffer.from(result, 'base64'));
            this.log(`Page screenshot saved: ${name}`);
          }
        }
      } catch {
        this.log('Page screenshot failed');
      }
    }
  }

  async teardown(): Promise<void> {
    // Reject any in-flight CDP calls before closing the socket
    for (const cb of this.cdpCallbacks.values()) {
      cb.reject(new Error('Instance torn down'));
    }
    this.cdpCallbacks.clear();

    if (this.cdpWs) {
      try {
        this.cdpWs.close();
      } catch {
        /* ignore */
      }
      this.cdpWs = null;
    }

    // Close Chrome via CDP Browser.close to prevent orphan processes.
    // The server's SIGTERM handler may not fire when killed externally.
    if (this.chromeCdpPort) {
      try {
        const resp = await fetch(`http://127.0.0.1:${this.chromeCdpPort}/json/version`, {
          signal: AbortSignal.timeout(2000),
        });
        const { webSocketDebuggerUrl } = (await resp.json()) as {
          webSocketDebuggerUrl: string;
        };
        const ws = new WebSocket(webSocketDebuggerUrl);
        await new Promise<void>((resolve) => {
          ws.on('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
            resolve();
          });
          ws.on('error', () => resolve());
          setTimeout(resolve, 3000);
        });
      } catch {
        // Chrome may already be gone
      }
    }

    if (this.serverProcess && !this.serverProcess.killed) {
      this.serverProcess.kill('SIGTERM');
      await this.sleep(2000);
      if (!this.serverProcess.killed) {
        this.serverProcess.kill('SIGKILL');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private buildResult(result: InstanceResult['result'], error?: string): InstanceResult {
    const duration =
      this.promptSentAt && this.completedAt ? this.completedAt - this.promptSentAt : null;

    return {
      index: this.opts.index,
      port: this.opts.port,
      prompt: this.opts.scenario.prompt,
      result,
      durationMs: duration,
      error,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private throwIfAborted(): void {
    if (this.aborted) throw new Error('Instance aborted');
  }
}
