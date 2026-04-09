/**
 * High-level Playwright-inspired browser API built on CDPClient.
 *
 * Provides: connect, listPages, navigate, screenshot, evaluate,
 * click, type, waitForSelector, getAccessibilityTree.
 */

import { CDPClient } from './cdp-client.js';
import type { CDPTransport } from './transport.js';
import type {
  CDPConnectOptions,
  PageInfo,
  TargetInfo,
  EvaluateOptions,
  WaitForSelectorOptions,
  BoundingBox,
  AccessibilityNode,
} from './types.js';
import type { TrayTargetEntry } from '../scoops/tray-sync-protocol.js';
import { normalizeAccessibilityText } from './normalize-accessibility-text.js';
import { INJECTED_ARIA_SNAPSHOT_SCRIPT } from './injected-aria-snapshot.js';
import { createLogger } from '../core/logger.js';

/**
 * Provider of remote tray targets and transport factory.
 * Set via `setTrayTargetProvider()` to enable remote target support.
 */
export interface TrayTargetProvider {
  getTargets(): TrayTargetEntry[];
  createRemoteTransport?(runtimeId: string, localTargetId: string): CDPTransport;
  removeRemoteTransport?(runtimeId: string, localTargetId: string): void;
  /** Open a new tab on a remote runtime. Returns the composite targetId. */
  openRemoteTab?(runtimeId: string, url: string): Promise<string>;
}

const FALLBACK_CDP_URL = 'ws://localhost:5710/cdp';
const log = createLogger('browser-api');

export function getDefaultCdpUrl(
  locationLike: Pick<Location, 'protocol' | 'host'> | null = typeof window !== 'undefined'
    ? window.location
    : null
): string {
  if (!locationLike?.host) return FALLBACK_CDP_URL;
  const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${locationLike.host}/cdp`;
}

export class BrowserAPI {
  private client: CDPTransport;
  private localClient: CDPTransport; // preserved original when using remote transport
  private sessionId: string | null = null;
  private attachedTargetId: string | null = null;
  private trayTargetProvider: TrayTargetProvider | null = null;
  private remoteTargetInfo: { runtimeId: string; localTargetId: string } | null = null;
  private _tabLock: Promise<void> = Promise.resolve();
  private _onSessionChange?: ((sessionId: string, transport: CDPTransport) => void) | undefined;
  private readonly handleJavaScriptDialogOpening = async (
    params: Record<string, unknown>
  ): Promise<void> => {
    const sessionId =
      typeof params['sessionId'] === 'string' ? (params['sessionId'] as string) : this.sessionId;
    if (!sessionId) return;

    try {
      await this.client.send('Page.handleJavaScriptDialog', { accept: false }, sessionId, 5000);
      log.warn('Auto-dismissed unexpected JavaScript dialog', {
        sessionId,
        type: params['type'],
        message: params['message'],
        url: params['url'],
      });
    } catch (error) {
      log.warn('Failed to auto-dismiss JavaScript dialog', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  constructor(client?: CDPTransport) {
    this.client = client ?? new CDPClient();
    this.localClient = this.client;
    this.addDialogListener(this.client);
  }

  /**
   * Get the underlying CDP transport.
   * Used by HarRecorder to subscribe to network events.
   */
  getTransport(): CDPTransport {
    return this.client;
  }

  /**
   * Register a callback invoked when a new CDP session is established via
   * `attachToPage()`.  The callback receives the CDP session ID and the
   * active transport, allowing subscribers (e.g. BshWatchdog) to track
   * transport swaps and know that `Page.enable` has already been sent.
   *
   * The callback is **not** invoked when `attachToPage()` returns early
   * because the requested target is already attached (no new session).
   *
   * Pass `undefined` to clear a previously registered callback.
   */
  setSessionChangeCallback(
    cb: ((sessionId: string, transport: CDPTransport) => void) | undefined
  ): void {
    this._onSessionChange = cb;
  }

  /**
   * Get the current session ID (if attached to a target).
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Get the currently attached target ID.
   */
  getAttachedTargetId(): string | null {
    return this.attachedTargetId;
  }

  /**
   * Execute an operation on a specific tab with exclusive access.
   * Serializes all tab operations — only one tab can be attached at a time.
   * Handles local and remote (tray) targets transparently.
   */
  async withTab<T>(targetId: string, fn: (sessionId: string) => Promise<T>): Promise<T> {
    let release: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this._tabLock;
    this._tabLock = next;
    await prev;
    try {
      const sessionId = await this.attachToPage(targetId);
      return await fn(sessionId);
    } finally {
      release!();
    }
  }

  /**
   * Set a provider of remote tray targets.
   * When set, listAllTargets() includes remote targets and attachToPage()
   * can attach to remote targets using the "{runtimeId}:{localTargetId}" format.
   */
  setTrayTargetProvider(provider: TrayTargetProvider | null): void {
    this.trayTargetProvider = provider;
  }

  /**
   * List all pages — local + remote tray targets.
   * Remote targets have targetId format "{runtimeId}:{localTargetId}".
   * Deduplicates leader-owned registry entries when they mirror a local page.
   */
  async listAllTargets(): Promise<PageInfo[]> {
    const local = await this.listPages();
    if (!this.trayTargetProvider) return local;

    const shouldDeduplicateLeaderTargets = !this.remoteTargetInfo;
    const localIds = new Set(local.map((p) => p.targetId));
    const remoteEntries = this.trayTargetProvider.getTargets();
    const remote: PageInfo[] = remoteEntries
      .filter(
        (t) =>
          !shouldDeduplicateLeaderTargets ||
          !(t.runtimeId === 'leader' && localIds.has(t.localTargetId))
      )
      .map((t) => ({
        targetId: t.targetId,
        title: t.title,
        url: t.url,
      }));

    return [...local, ...remote];
  }

  /**
   * Connect to the CDP proxy.
   * DebuggerClient (extension mode) accepts but ignores these options.
   */
  async connect(options?: Partial<CDPConnectOptions>): Promise<void> {
    await this.client.connect({
      url: options?.url ?? getDefaultCdpUrl(),
      timeout: options?.timeout,
    });
  }

  /**
   * Create a new browser tab/target.
   * Returns the targetId of the newly created tab.
   * The tab opens in the background by default.
   * Always creates on the local browser, even when currently attached to a remote target.
   */
  async createPage(url?: string): Promise<string> {
    await this.ensureConnected();
    await this.ensureLocalConnected();
    const result = await this.localClient.send('Target.createTarget', {
      url: url ?? 'about:blank',
      background: true,
    });
    return result['targetId'] as string;
  }

  /**
   * Create a new tab on a remote runtime within the tray.
   * Requires a tray target provider with openRemoteTab support.
   * Returns the composite targetId ("{runtimeId}:{localTargetId}").
   */
  async createRemotePage(runtimeId: string, url?: string): Promise<string> {
    if (!this.trayTargetProvider?.openRemoteTab) {
      throw new Error('Remote tab opening not available (no tray target provider)');
    }
    return this.trayTargetProvider.openRemoteTab(runtimeId, url ?? 'about:blank');
  }

  /**
   * Close a browser tab/target by its targetId.
   * Handles remote tray targets by routing through RemoteCDPTransport.
   */
  async closePage(targetId: string): Promise<void> {
    await this.ensureConnected();

    // Check if this is a remote tray target (format: "runtimeId:localTargetId")
    if (this.trayTargetProvider?.createRemoteTransport && targetId.includes(':')) {
      const colonIdx = targetId.indexOf(':');
      const runtimeId = targetId.substring(0, colonIdx);
      const localTargetId = targetId.substring(colonIdx + 1);

      // Trust the runtimeId:localTargetId format — don't require registry confirmation.
      {
        const remoteTransport = this.trayTargetProvider.createRemoteTransport(
          runtimeId,
          localTargetId
        );
        try {
          await remoteTransport.send('Target.closeTarget', { targetId: localTargetId });
        } finally {
          if (this.trayTargetProvider.removeRemoteTransport) {
            this.trayTargetProvider.removeRemoteTransport(runtimeId, localTargetId);
          }
        }

        // If we were attached to the target being closed, clean up
        if (this.attachedTargetId === targetId) {
          if (this.remoteTargetInfo) {
            this.setClient(this.localClient);
            this.remoteTargetInfo = null;
          }
          this.sessionId = null;
          this.attachedTargetId = null;
        }
        return;
      }
    }

    await this.localClient.send('Target.closeTarget', { targetId });

    // Clean up if we were attached to this target
    if (this.attachedTargetId === targetId) {
      this.sessionId = null;
      this.attachedTargetId = null;
    }
  }

  /**
   * Disconnect and clean up.
   */
  disconnect(): void {
    this.sessionId = null;
    this.attachedTargetId = null;
    this.client.disconnect();
  }

  /**
   * List all open pages (tabs).
   * Always queries the local browser, even when currently attached to a remote target.
   */
  async listPages(): Promise<PageInfo[]> {
    await this.ensureConnected();
    await this.ensureLocalConnected();
    const result = await this.localClient.send('Target.getTargets');
    const targets = (result['targetInfos'] as TargetInfo[]) ?? [];
    return targets
      .filter((t) => t.type === 'page')
      .map((t) => ({
        targetId: t.targetId,
        title: t.title,
        url: t.url,
        ...(t.active ? { active: true } : {}),
      }));
  }

  /**
   * Attach to a specific page target, enabling page-level commands.
   * Returns the CDP session ID for the attached target.
   *
   * If the targetId contains a colon (format "{runtimeId}:{localTargetId}"),
   * it's treated as a remote tray target and a RemoteCDPTransport is used.
   */
  async attachToPage(targetId: string): Promise<string> {
    await this.ensureConnected();
    // Skip if already attached to this target
    if (this.sessionId && this.attachedTargetId === targetId) {
      return this.sessionId;
    }
    // Don't detach from previous target — just attach to the new one.
    // Detaching then re-attaching causes Chrome to steal window focus.

    // Check if this is a remote tray target (format: "runtimeId:localTargetId")
    if (this.trayTargetProvider?.createRemoteTransport && targetId.includes(':')) {
      const colonIdx = targetId.indexOf(':');
      const runtimeId = targetId.substring(0, colonIdx);
      const localTargetId = targetId.substring(colonIdx + 1);

      // The runtimeId:localTargetId format is a strong signal this is remote.
      // Don't require registry confirmation — the target may have just been
      // created via createRemotePage() and not yet advertised.
      {
        const remoteTransport = this.trayTargetProvider.createRemoteTransport(
          runtimeId,
          localTargetId
        );
        this.setClient(remoteTransport);
        this.remoteTargetInfo = { runtimeId, localTargetId };

        // Send attachToTarget via the remote transport
        const result = await this.client.send('Target.attachToTarget', {
          targetId: localTargetId,
          flatten: true,
        });
        this.sessionId = result['sessionId'] as string;
        this.attachedTargetId = targetId;
        await this.client.send('Page.enable', {}, this.sessionId);
        this._onSessionChange?.(this.sessionId, this.client);
        return this.sessionId;
      }
    }

    const result = await this.client.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    this.sessionId = result['sessionId'] as string;
    this.attachedTargetId = targetId;
    // Keep Page events available so unexpected dialogs can be auto-dismissed
    // before they stall the current CDP command.
    await this.client.send('Page.enable', {}, this.sessionId);
    this._onSessionChange?.(this.sessionId, this.client);
    return this.sessionId;
  }

  /**
   * Detach from the currently attached target.
   * If attached to a remote target, restores the local transport.
   */
  async detach(): Promise<void> {
    if (this.sessionId) {
      try {
        await this.client.send('Target.detachFromTarget', {
          sessionId: this.sessionId,
        });
      } catch {
        // Target may already be detached
      }

      // Restore local transport if we were using a remote one
      if (this.remoteTargetInfo && this.trayTargetProvider?.removeRemoteTransport) {
        this.trayTargetProvider.removeRemoteTransport(
          this.remoteTargetInfo.runtimeId,
          this.remoteTargetInfo.localTargetId
        );
        this.setClient(this.localClient);
        this.remoteTargetInfo = null;
      }

      this.sessionId = null;
      this.attachedTargetId = null;
    }
  }

  /**
   * Navigate the attached page to a URL. Waits for the load event.
   */
  async navigate(url: string): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    // Enable Page domain for lifecycle events
    await this.client.send('Page.enable', {}, this.sessionId!);

    const loadPromise = this.client.once('Page.loadEventFired');

    await this.client.send('Page.navigate', { url }, this.sessionId!);

    await loadPromise;
  }

  /**
   * Take a screenshot of the attached page.
   * Returns a base64-encoded PNG string.
   */
  async screenshot(options?: {
    format?: 'png' | 'jpeg' | 'webp';
    quality?: number;
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number; scale?: number };
    maxWidth?: number;
  }): Promise<string> {
    await this.ensureConnected();
    this.ensureAttached();

    try {
      const params: Record<string, unknown> = {
        format: options?.format ?? 'png',
        captureBeyondViewport: true,
      };
      if (options?.quality !== undefined) params['quality'] = options.quality;

      if (options?.clip || options?.fullPage) {
        // Get CSS dimensions for full-page clip
        let cssWidth = 0;
        let cssScrollHeight = 0;
        try {
          await this.client.send('Runtime.enable', {}, this.sessionId!);
          const evalResult = await this.client.send(
            'Runtime.evaluate',
            {
              expression:
                'JSON.stringify({ w: window.innerWidth, h: document.documentElement.scrollHeight })',
              returnByValue: true,
            },
            this.sessionId!
          );
          const val = JSON.parse((evalResult['result'] as { value?: string })?.value ?? '{}');
          cssWidth = val.w ?? 0;
          cssScrollHeight = val.h ?? 0;
        } catch {
          // Best-effort
        }

        if (options?.clip) {
          params['clip'] = { ...options.clip, scale: options.clip.scale ?? 1 };
        } else {
          // Full-page: CSS viewport width + CSS scroll height
          params['clip'] = {
            x: 0,
            y: 0,
            width: cssWidth || 1280,
            height: cssScrollHeight || 800,
            scale: 1,
          };
        }
      }
      // No clip/fullPage = viewport screenshot (Chrome's default behavior)

      const result = await this.client.send('Page.captureScreenshot', params, this.sessionId!);
      let base64 = result['data'] as string;

      // Post-capture resize via ImageMagick WASM if image exceeds maxWidth.
      // Same engine as image-processor.ts for consistency.
      if (options?.maxWidth) {
        try {
          const { getMagick } = await import('../shell/supplemental-commands/magick-wasm.js');
          const magick = await getMagick();

          const binaryStr = atob(base64);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

          const MAX_DIM = 8000;
          let resized = false;
          await magick.ImageMagick.read(bytes, async (img) => {
            const targetWidth = Math.min(options.maxWidth!, MAX_DIM);
            const longEdge = Math.max(img.width, img.height);
            if (img.width > targetWidth || longEdge > MAX_DIM) {
              const scale = Math.min(targetWidth / img.width, MAX_DIM / longEdge);
              img.resize(Math.round(img.width * scale), Math.round(img.height * scale));
              resized = true;
            }
            if (resized) {
              img.write('PNG', (data: Uint8Array) => {
                let bin = '';
                for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
                base64 = btoa(bin);
              });
            }
          });
        } catch (resizeErr) {
          console.warn(
            '[browser-api] Screenshot maxWidth resize failed, returning original',
            resizeErr
          );
        }
      }

      return base64;
    } finally {
    }
  }

  /**
   * Evaluate a JavaScript expression in the attached page.
   * Returns the result value.
   */
  async evaluate(expression: string, options?: EvaluateOptions): Promise<unknown> {
    await this.ensureConnected();
    this.ensureAttached();

    await this.client.send('Runtime.enable', {}, this.sessionId!);

    const result = await this.client.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: options?.awaitPromise ?? true,
        returnByValue: options?.returnByValue ?? true,
      },
      this.sessionId!
    );

    const exceptionDetails = result['exceptionDetails'] as
      | { text: string; exception?: { description?: string } }
      | undefined;
    if (exceptionDetails) {
      const msg = exceptionDetails.exception?.description ?? exceptionDetails.text;
      throw new Error(`Evaluation failed: ${msg}`);
    }

    const remoteObj = result['result'] as {
      type: string;
      value?: unknown;
      description?: string;
    };
    return remoteObj.value;
  }

  /**
   * Click an element matching a CSS selector.
   */
  async click(selector: string): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    const box = await this.boundingBox(selector);
    if (!box) {
      throw new Error(`Element not found: ${selector}`);
    }

    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
      this.sessionId!
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
      this.sessionId!
    );
  }

  /**
   * Type text into the currently focused element.
   */
  async type(text: string): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    for (const char of text) {
      await this.client.send(
        'Input.dispatchKeyEvent',
        { type: 'keyDown', text: char },
        this.sessionId!
      );
      await this.client.send(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', text: char },
        this.sessionId!
      );
    }
  }

  /**
   * Wait for a CSS selector to appear in the DOM.
   */
  async waitForSelector(selector: string, options?: WaitForSelectorOptions): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    const timeout = options?.timeout ?? 30000;
    const interval = options?.interval ?? 100;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const found = await this.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (found) return;
      await new Promise((r) => setTimeout(r, interval));
    }

    throw new Error(`waitForSelector timed out after ${timeout}ms: ${selector}`);
  }

  /**
   * Get the accessibility tree of the attached page.
   *
   * Uses an injected JavaScript approach (ported from Playwright's
   * ariaSnapshot.ts) instead of CDP's Accessibility domain, so it
   * works on any browser engine (Chrome, WebKit, etc.).
   */
  async getAccessibilityTree(): Promise<AccessibilityNode> {
    await this.ensureConnected();
    this.ensureAttached();

    // Inject the aria snapshot script into the page via Runtime.evaluate.
    // This works on both CDP (Chrome) and WebKit Inspector Protocol.
    const rawResult = await this.evaluate(INJECTED_ARIA_SNAPSHOT_SCRIPT, {
      awaitPromise: false,
      returnByValue: true,
    });

    if (!rawResult || typeof rawResult !== 'object') {
      return { role: 'RootWebArea', name: '' };
    }

    // The injected script returns a tree already in AccessibilityNode format.
    // Normalize it to ensure all string fields are proper strings.
    return normalizeInjectedTree(rawResult as Record<string, unknown>);
  }

  /**
   * Click an element by its CDP backend node ID.
   * Uses DOM.resolveNode to get an objectId, then calls .click() on it.
   * Falls back to bounding-box click if .click() is not appropriate.
   */
  async clickByBackendNodeId(backendNodeId: number): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    await this.client.send('DOM.enable', {}, this.sessionId!);
    await this.client.send('Runtime.enable', {}, this.sessionId!);

    // Resolve backendNodeId to a remote object
    const resolveResult = await this.client.send(
      'DOM.resolveNode',
      { backendNodeId },
      this.sessionId!
    );
    const object = resolveResult['object'] as { objectId?: string } | undefined;
    if (!object?.objectId) {
      throw new Error(`Could not resolve backend node ${backendNodeId} to a DOM element`);
    }

    // Scroll into view and get bounding box via JS
    const boxResult = await this.client.send(
      'Runtime.callFunctionOn',
      {
        objectId: object.objectId,
        functionDeclaration: `function() {
          this.scrollIntoView({ block: 'center', inline: 'center' });
          const r = this.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }`,
        returnByValue: true,
      },
      this.sessionId!
    );

    const boxValue = (boxResult['result'] as { value?: BoundingBox })?.value;
    if (!boxValue || boxValue.width === 0 || boxValue.height === 0) {
      // Element has no dimensions — fall back to programmatic click
      await this.client.send(
        'Runtime.callFunctionOn',
        {
          objectId: object.objectId,
          functionDeclaration: 'function() { this.click(); }',
        },
        this.sessionId!
      );
      return;
    }

    // Click at center of the element's bounding box
    const x = boxValue.x + boxValue.width / 2;
    const y = boxValue.y + boxValue.height / 2;

    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
      this.sessionId!
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
      this.sessionId!
    );
  }

  /**
   * Double-click an element by its CDP backend node ID.
   */
  async dblclickByBackendNodeId(
    backendNodeId: number,
    button: 'left' | 'right' | 'middle' = 'left'
  ): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    const { x, y } = await this.resolveNodeCenter(backendNodeId);

    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button, clickCount: 1 },
      this.sessionId!
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button, clickCount: 1 },
      this.sessionId!
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button, clickCount: 2 },
      this.sessionId!
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button, clickCount: 2 },
      this.sessionId!
    );
  }

  /**
   * Hover over an element by its CDP backend node ID.
   */
  async hoverByBackendNodeId(backendNodeId: number): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    const { x, y } = await this.resolveNodeCenter(backendNodeId);

    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x, y },
      this.sessionId!
    );
  }

  /**
   * Select a value on a <select> element by its CDP backend node ID.
   */
  async selectByBackendNodeId(backendNodeId: number, value: string): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    const objectId = await this.resolveNodeObjectId(backendNodeId);

    await this.client.send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function(val) { this.value = val; this.dispatchEvent(new Event('change', { bubbles: true })); }`,
        arguments: [{ value }],
        returnByValue: true,
      },
      this.sessionId!
    );
  }

  /**
   * Check or uncheck a checkbox/radio element by its CDP backend node ID.
   * Only clicks if the current state differs from the desired state.
   * Returns the action taken.
   */
  async setCheckedByBackendNodeId(
    backendNodeId: number,
    checked: boolean
  ): Promise<'toggled' | 'already'> {
    await this.ensureConnected();
    this.ensureAttached();

    const objectId = await this.resolveNodeObjectId(backendNodeId);

    const stateResult = await this.client.send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function() { return this.checked; }`,
        returnByValue: true,
      },
      this.sessionId!
    );
    const currentChecked = (stateResult['result'] as { value?: boolean })?.value;

    if (currentChecked === checked) {
      return 'already';
    }

    // Click to toggle
    await this.clickByBackendNodeId(backendNodeId);
    return 'toggled';
  }

  /**
   * Drag from one element to another by their CDP backend node IDs.
   */
  async dragByBackendNodeIds(startBackendNodeId: number, endBackendNodeId: number): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    const start = await this.resolveNodeCenter(startBackendNodeId);
    const end = await this.resolveNodeCenter(endBackendNodeId);

    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1 },
      this.sessionId!
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: end.x, y: end.y },
      this.sessionId!
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', clickCount: 1 },
      this.sessionId!
    );
  }

  /**
   * Send a raw CDP command on the current session.
   * Used by playwright-cli for cookie operations via the Network domain.
   */
  async sendCDP(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    await this.ensureConnected();
    this.ensureAttached();
    return await this.client.send(method, params, this.sessionId!);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve a backend node ID to a remote object ID.
   */
  private async resolveNodeObjectId(backendNodeId: number): Promise<string> {
    await this.client.send('DOM.enable', {}, this.sessionId!);
    await this.client.send('Runtime.enable', {}, this.sessionId!);

    const resolveResult = await this.client.send(
      'DOM.resolveNode',
      { backendNodeId },
      this.sessionId!
    );
    const object = resolveResult['object'] as { objectId?: string } | undefined;
    if (!object?.objectId) {
      throw new Error(`Could not resolve backend node ${backendNodeId} to a DOM element`);
    }
    return object.objectId;
  }

  /**
   * Resolve a backend node ID to the center point of its bounding box.
   * Scrolls the element into view first.
   */
  private async resolveNodeCenter(backendNodeId: number): Promise<{ x: number; y: number }> {
    const objectId = await this.resolveNodeObjectId(backendNodeId);

    const boxResult = await this.client.send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function() {
          this.scrollIntoView({ block: 'center', inline: 'center' });
          const r = this.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }`,
        returnByValue: true,
      },
      this.sessionId!
    );

    const boxValue = (boxResult['result'] as { value?: BoundingBox })?.value;
    if (!boxValue || boxValue.width === 0 || boxValue.height === 0) {
      throw new Error(`Element with backend node ${backendNodeId} has no dimensions`);
    }

    return {
      x: boxValue.x + boxValue.width / 2,
      y: boxValue.y + boxValue.height / 2,
    };
  }

  /**
   * Lazily connect (or reconnect) to the CDP proxy.
   * Resets stale session/target state when reconnecting after a drop.
   * If the current client is a disconnected remote transport, restores the local transport.
   */
  private async ensureLocalConnected(): Promise<void> {
    if (this.localClient.state === 'disconnected') {
      await this.localClient.connect({ url: getDefaultCdpUrl() });
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.state === 'disconnected') {
      // If we were using a remote transport that got disconnected (follower went away),
      // restore the local transport and clear stale remote state.
      if (this.remoteTargetInfo && this.trayTargetProvider?.removeRemoteTransport) {
        this.trayTargetProvider.removeRemoteTransport(
          this.remoteTargetInfo.runtimeId,
          this.remoteTargetInfo.localTargetId
        );
        this.setClient(this.localClient);
        this.remoteTargetInfo = null;
      }
      // Previous session/target are no longer valid after reconnect
      this.sessionId = null;
      this.attachedTargetId = null;
      if (this.client.state === 'disconnected') {
        await this.connect();
      }
    }
  }

  private ensureAttached(): void {
    if (!this.sessionId) {
      throw new Error('Not attached to a page. Call attachToPage(targetId) first.');
    }
  }

  private addDialogListener(client: CDPTransport): void {
    client.on('Page.javascriptDialogOpening', this.handleJavaScriptDialogOpening);
  }

  private removeDialogListener(client: CDPTransport): void {
    client.off('Page.javascriptDialogOpening', this.handleJavaScriptDialogOpening);
  }

  private setClient(client: CDPTransport): void {
    if (this.client === client) {
      return;
    }

    this.removeDialogListener(this.client);
    this.client = client;
    this.addDialogListener(this.client);
  }

  /**
   * Get the bounding box of an element by CSS selector.
   */
  private async boundingBox(selector: string): Promise<BoundingBox | null> {
    await this.client.send('DOM.enable', {}, this.sessionId!);

    const docResult = await this.client.send('DOM.getDocument', { depth: 0 }, this.sessionId!);
    const rootNodeId = (docResult['root'] as { nodeId: number }).nodeId;

    let nodeId: number;
    try {
      const queryResult = await this.client.send(
        'DOM.querySelector',
        { nodeId: rootNodeId, selector },
        this.sessionId!
      );
      nodeId = queryResult['nodeId'] as number;
    } catch {
      return null;
    }

    if (!nodeId) return null;

    const boxModel = await this.client.send('DOM.getBoxModel', { nodeId }, this.sessionId!);
    const model = boxModel['model'] as {
      content: number[];
      width: number;
      height: number;
    };

    if (!model) return null;

    // content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
    const quad = model.content;
    return {
      x: quad[0],
      y: quad[1],
      width: model.width,
      height: model.height,
    };
  }
}

/**
 * Normalize the raw tree returned by the injected aria snapshot script
 * into the AccessibilityNode format expected by SLICC consumers.
 */
function normalizeInjectedTree(raw: Record<string, unknown>): AccessibilityNode {
  const role = normalizeAccessibilityText(raw.role, 'unknown');
  const name = normalizeAccessibilityText(raw.name);

  const node: AccessibilityNode = { role, name };

  const value = normalizeAccessibilityText(raw.value);
  if (value !== '') node.value = value;

  const description = normalizeAccessibilityText(raw.description);
  if (description !== '') node.description = description;

  if (Array.isArray(raw.children) && raw.children.length > 0) {
    node.children = (raw.children as Record<string, unknown>[])
      .map((child) => normalizeInjectedTree(child))
      .filter((c) => c.role !== 'unknown');
  }

  return node;
}
