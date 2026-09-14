import { createLogger } from '../base/logger.js';
import type { BshDiscoveryFS, BshEntry } from './bsh-discovery.js';
import type { ScriptCatalog } from './script-catalog.js';
import { ESBUILD_VERSION } from './supplemental-commands/esbuild-wasm.js';

const log = createLogger('bsh-watchdog');

interface PageFrameNavigatedFrame {
  parentId?: string;
  url?: string;
}

interface PageFrameNavigatedParams {
  frame?: PageFrameNavigatedFrame;
  sessionId?: string;
}

interface RuntimeExceptionDetails {
  text: string;
  exception?: { description?: string };
}

interface RuntimeEvaluateParams {
  expression: string;
  awaitPromise?: boolean;
  returnByValue?: boolean;
}

interface RuntimeEnableParams {}

interface RuntimeEvaluateResult {
  exceptionDetails?: RuntimeExceptionDetails;
}

type FrameNavigatedListener = (params: PageFrameNavigatedParams) => void;

interface BshWatchdogTransport {
  on(event: 'Page.frameNavigated', listener: FrameNavigatedListener): void;
  off(event: 'Page.frameNavigated', listener: FrameNavigatedListener): void;
  send(
    method: string,
    params?: RuntimeEnableParams | RuntimeEvaluateParams,
    sessionId?: string
  ): Promise<RuntimeEvaluateResult>;
}

interface BshWatchdogBrowserAPI {
  getTransport(): BshWatchdogTransport;
  setSessionChangeCallback(
    cb: ((sessionId: string, transport: BshWatchdogTransport) => void) | undefined
  ): void;
}

const BSH_BUNDLE_HINT = `.bsh scripts must be pre-bundled. Install deps via \`ipk add <pkg>\`, then bootstrap esbuild via \`ipk add esbuild-wasm@${ESBUILD_VERSION}\` and bundle with \`esbuild --bundle <script>.bsh --outfile=<script>.bundled.bsh\`. Drop the bundled file in place. There is no runtime resolver in the target page.`;

export interface BshWatchdogOptions {
  transport?: BshWatchdogTransport;

  browserAPI?: BshWatchdogBrowserAPI;

  scriptCatalog: ScriptCatalog;

  fs: BshDiscoveryFS;
}

export class BshWatchdog {
  private transport: BshWatchdogTransport;
  private readonly browserAPI?: BshWatchdogBrowserAPI;
  private readonly fs: BshDiscoveryFS;
  private readonly scriptCatalog: ScriptCatalog;
  private running = false;

  private executing = new Set<string>();

  constructor(options: BshWatchdogOptions) {
    if (!options.transport && !options.browserAPI) {
      throw new Error('BshWatchdog requires either transport or browserAPI');
    }
    if (!options.scriptCatalog) {
      throw new Error('BshWatchdog requires a ScriptCatalog');
    }
    this.browserAPI = options.browserAPI;
    this.transport = options.transport ?? options.browserAPI!.getTransport();
    this.fs = options.fs;
    this.scriptCatalog = options.scriptCatalog;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.transport.on('Page.frameNavigated', this.onFrameNavigated);

    if (this.browserAPI) {
      this.browserAPI.setSessionChangeCallback((_sessionId, newTransport) => {
        if (newTransport !== this.transport) {
          this.setTransport(newTransport);
        }
      });
    }

    let scriptCount: number | undefined;
    try {
      scriptCount = (await this.scriptCatalog.getBshEntries()).length;
    } catch (err) {
      log.warn('BSH watchdog startup discovery failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    log.info('BSH watchdog started', scriptCount === undefined ? undefined : { scriptCount });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    this.transport.off('Page.frameNavigated', this.onFrameNavigated);

    if (this.browserAPI) {
      this.browserAPI.setSessionChangeCallback(undefined);
    }
    this.executing.clear();

    log.info('BSH watchdog stopped');
  }

  setTransport(newTransport: BshWatchdogTransport): void {
    if (newTransport === this.transport) return;
    this.transport.off('Page.frameNavigated', this.onFrameNavigated);
    this.transport = newTransport;
    if (this.running) {
      this.transport.on('Page.frameNavigated', this.onFrameNavigated);
    }
    log.info('BSH watchdog transport swapped');
  }

  async discover(): Promise<void> {
    this.scriptCatalog.invalidateBsh();
    await this.scriptCatalog.getBshEntries();
  }

  async getEntries(): Promise<readonly BshEntry[]> {
    return this.scriptCatalog.getBshEntries();
  }

  private readonly onFrameNavigated: FrameNavigatedListener = (params) => {
    const frame = params.frame;

    if (frame?.parentId || !frame?.url) return;

    const url = frame.url;
    const sessionId = params.sessionId;

    if (!url.startsWith('http://') && !url.startsWith('https://')) return;

    if (!sessionId) {
      log.warn('BSH watchdog: no sessionId in Page.frameNavigated params, skipping', { url });
      return;
    }

    void this.scriptCatalog
      .findMatchingBshScripts(url)
      .then((matches) => {
        if (matches.length === 0) return;

        for (const entry of matches) {
          const key = `${entry.path}::${url}`;
          if (this.executing.has(key)) continue;
          this.executing.add(key);

          log.info('BSH watchdog executing script', { script: entry.path, url });

          void this.executeInTargetPage(entry.path, url, sessionId)
            .then(() => {
              log.info('BSH script completed', { script: entry.path, url });
            })
            .catch((err) => {
              log.error('BSH script execution error', {
                script: entry.path,
                url,
                error: err instanceof Error ? err.message : String(err),
              });
            })
            .finally(() => {
              this.executing.delete(key);
            });
        }
      })
      .catch((err) => {
        log.error('BSH discovery failed', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };

  private async executeInTargetPage(
    scriptPath: string,
    url: string,
    sessionId: string
  ): Promise<void> {
    const content = await this.fs.readFile(scriptPath);
    const scriptContent = typeof content === 'string' ? content : new TextDecoder().decode(content);

    const wrappedScript = `(async () => {
  const __requireSpecifiers = (function() {
    const re = /require\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)/g;
    const code = ${JSON.stringify(scriptContent)};
    const specs = [];
    let m;
    while ((m = re.exec(code)) !== null) specs.push(m[1]);
    return [...new Set(specs)];
  })();
  const __NODE_BUILTINS_UNAVAILABLE = new Set([
    'http', 'https', 'net', 'tls', 'dgram', 'dns', 'cluster',
    'worker_threads', 'child_process', 'crypto', 'os', 'stream',
    'zlib', 'vm', 'v8', 'perf_hooks', 'readline', 'repl', 'tty', 'inspector',
    'fs'
  ]);
  const __NODE_NATIVE_PACKAGES = new Set([
    'bcrypt','better-sqlite3','canvas','cpu-features','fsevents','leveldown',
    'libxmljs','libxmljs2','node-gyp-build','node-sass','puppeteer','robotjs',
    'sass-embedded','sharp','snappy','sqlite3','tree-sitter','usb',
  ]);
  const __NATIVE_HINTS = {
    sharp: " Use the built-in 'convert' shell command for image work.",
    canvas: " Use the built-in 'convert' / OffscreenCanvas for image work.",
    'better-sqlite3': " Use the built-in 'sqlite3' shell command (sql.js WASM).",
    sqlite3: " Use the built-in 'sqlite3' shell command (sql.js WASM).",
    bcrypt: " Use crypto.subtle.digest() with PBKDF2 / Argon2 in pure JS.",
    puppeteer: " Use the built-in browser-automation shell commands.",
  };
  const __nativeError = (id, bareId) => new Error("require('" + id + "'): '" + bareId + "' is a Node native module (C++ bindings) — it cannot run in the browser sandbox." + (__NATIVE_HINTS[bareId] || ''));
  const __BUNDLE_HINT = ${JSON.stringify(BSH_BUNDLE_HINT)};
  // Pre-flight: any surviving bare-specifier require() means the script
  // was not bundled. Surface the error before evaluating so the failure
  // points the user at the bundle-first workflow instead of a generic
  // "require is not defined" at the first call site.
  const __unbundled = __requireSpecifiers.filter(id => {
    const bareId = id.startsWith('node:') ? id.slice(5) : id;
    if (bareId === 'buffer') return false;
    return true;
  });
  if (__unbundled.length > 0) {
    console.error("[bsh] unbundled require() specifiers in .bsh script: " + __unbundled.map(s => "'" + s + "'").join(', ') + ". " + __BUNDLE_HINT);
    return;
  }
  const require = (id) => {
    const bareId = id.startsWith('node:') ? id.slice(5) : id;
    if (bareId === 'buffer' && typeof Buffer !== 'undefined') return { Buffer };
    if (__NODE_BUILTINS_UNAVAILABLE.has(bareId)) {
      // Unlike the .jsh / node realm (where require('child_process') maps to the
      // exec shell bridge), a .bsh script runs in the target page via CDP and has
      // no shell bridge, so child_process is genuinely unavailable here.
      const __suggestions = { http: ' Use fetch() instead.', https: ' Use fetch() instead.', crypto: ' Use globalThis.crypto (Web Crypto API) instead.', child_process: ' .bsh scripts run in the target page and have no shell bridge; use exec() from a .jsh script instead.' };
      const __hint = __suggestions[bareId] || '';
      throw new Error("require('" + id + "'): Node built-in '" + bareId + "' is not available in the browser environment." + __hint);
    }
    if (__NODE_NATIVE_PACKAGES.has(bareId)) {
      throw __nativeError(id, bareId);
    }
    throw new Error("require('" + id + "'): bare specifier cannot be resolved at .bsh runtime. " + __BUNDLE_HINT);
  };
  try {
    ${scriptContent}
  } catch(e) { console.error('[bsh]', e); }
})()`;

    await this.transport.send('Runtime.enable', {}, sessionId);
    const result = await this.transport.send(
      'Runtime.evaluate',
      {
        expression: wrappedScript,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId
    );

    const exceptionDetails = result.exceptionDetails;
    if (exceptionDetails) {
      const msg = exceptionDetails.exception?.description ?? exceptionDetails.text;
      log.warn('BSH script evaluation error', { script: scriptPath, url, error: msg });
    }
  }
}
