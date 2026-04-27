/**
 * WebKit CDP Adapter — translates Chrome DevTools Protocol to WebKit Inspector Protocol.
 *
 * Implements CDPTransport so all existing BrowserAPI code works unchanged.
 * Internally communicates with Playwright's patched WebKit binary over pipe
 * (fd 3 write / fd 4 read) using null-byte delimited JSON messages.
 *
 * Three-layer protocol:
 *   1. Playwright domain (top-level): enable, createContext, createPage, navigate
 *   2. Target routing: sendMessageToTarget / dispatchMessageFromTarget with pageProxyId
 *   3. Inner WIP domains: Runtime, Page, DOM, Input, Network (similar to CDP)
 */

import type { CDPTransport } from './transport.js';
import type { CDPConnectOptions, CDPEventListener, ConnectionState } from './types.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('webkit-cdp-adapter');

// ---------------------------------------------------------------------------
// Types for WIP messages
// ---------------------------------------------------------------------------

/** Writable stream interface for the pipe to WebKit (fd 3). */
export interface WebKitWritable {
  write(data: string | Uint8Array): void;
}

/** Readable stream interface for the pipe from WebKit (fd 4). */
export interface WebKitReadable {
  on(event: 'data', cb: (chunk: Buffer | Uint8Array) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

/** Options to construct WebKitCDPAdapter. */
export interface WebKitCDPAdapterOptions {
  /** Writable pipe (fd 3) to send messages to WebKit. */
  writable: WebKitWritable;
  /** Readable pipe (fd 4) to receive messages from WebKit. */
  readable: WebKitReadable;
}

/** Internal tracking for a page proxy (WebKit's equivalent of a target). */
interface PageProxy {
  pageProxyId: string;
  browserContextId: string;
  targetId: string; // inner target ID from Target.targetCreated
  url: string;
  title: string;
  resumed: boolean;
}

// ---------------------------------------------------------------------------
// Null-byte pipe transport
// ---------------------------------------------------------------------------

/**
 * Low-level pipe transport: writes null-byte terminated JSON to a writable
 * stream and reads null-byte delimited JSON from a readable stream.
 */
class WebKitPipeTransport {
  // Buffer raw bytes (not strings) so multi-byte UTF-8 sequences split across
  // pipe reads don't introduce U+FFFD replacement characters before we've seen
  // the terminating 0x00 delimiter. We split on 0x00 byte-wise then decode each
  // complete frame as UTF-8.
  private buffer: Uint8Array = new Uint8Array(0);
  private onMessage: ((msg: Record<string, unknown>) => void) | null = null;
  private onClose: (() => void) | null = null;
  private decoder = new TextDecoder('utf-8');

  constructor(
    private writable: WebKitWritable,
    private readable: WebKitReadable
  ) {}

  /** Start reading from the pipe. */
  start(onMessage: (msg: Record<string, unknown>) => void, onClose: () => void): void {
    this.onMessage = onMessage;
    this.onClose = onClose;

    this.readable.on('data', (chunk: Buffer | Uint8Array) => {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      this.appendBytes(bytes);
      this.processBuffer();
    });

    this.readable.on('close', () => {
      this.onClose?.();
    });

    this.readable.on('error', (err: Error) => {
      log.error('Pipe read error', err);
      this.onClose?.();
    });
  }

  /** Send a JSON message with null-byte terminator. */
  send(msg: Record<string, unknown>): void {
    const json = JSON.stringify(msg);
    this.writable.write(json + '\0');
  }

  private appendBytes(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
  }

  private processBuffer(): void {
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i] !== 0) continue;
      if (i > start) {
        const frame = this.buffer.subarray(start, i);
        const raw = this.decoder.decode(frame);
        if (raw.length > 0) {
          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            this.onMessage?.(parsed);
          } catch {
            log.warn('Failed to parse WIP message', { raw: raw.slice(0, 200) });
          }
        }
      }
      start = i + 1;
    }
    this.buffer = start === 0 ? this.buffer : this.buffer.subarray(start);
  }
}

// ---------------------------------------------------------------------------
// WebKitCDPAdapter — implements CDPTransport
// ---------------------------------------------------------------------------

/**
 * Adapter that implements the CDPTransport interface but internally speaks
 * WebKit Inspector Protocol (WIP) over a pipe to Playwright's WebKit binary.
 *
 * Usage:
 * ```ts
 * const adapter = new WebKitCDPAdapter({
 *   writable: childProcess.stdio[3],
 *   readable: childProcess.stdio[4],
 * });
 * await adapter.connect();
 * const browserApi = new BrowserAPI(adapter);
 * ```
 */
export class WebKitCDPAdapter implements CDPTransport {
  private pipe: WebKitPipeTransport;
  private _state: ConnectionState = 'disconnected';
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (result: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }
  >();
  private listeners = new Map<string, Set<CDPEventListener>>();

  // WIP state tracking
  private browserContextId: string | null = null;
  /** All known page proxies, keyed by pageProxyId. Includes proxies that
   *  have not yet been attached to via Target.attachToTarget. This is the
   *  authoritative target list — `sessions` only tracks attached proxies. */
  private pageProxies = new Map<string, PageProxy>();
  /** Map from CDP sessionId → PageProxy info (only populated after attach). */
  private sessions = new Map<string, PageProxy>();
  /** Map from pageProxyId → CDP sessionId (only for attached proxies). */
  private proxyToSession = new Map<string, string>();
  /** Map from inner target command id → { outerResolve, outerReject, sessionId } */
  private innerPending = new Map<
    number,
    {
      resolve: (result: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      sessionId: string;
    }
  >();
  private nextInnerId = 1;
  /** Page proxies waiting for target info (targetId not yet known). */
  private pendingProxies = new Map<
    string,
    { pageProxyId: string; browserContextId: string; resolve: (proxy: PageProxy) => void }
  >();

  constructor(private options: WebKitCDPAdapterOptions) {
    this.pipe = new WebKitPipeTransport(options.writable, options.readable);
  }

  get state(): ConnectionState {
    return this._state;
  }

  // -------------------------------------------------------------------------
  // CDPTransport interface
  // -------------------------------------------------------------------------

  async connect(_options?: CDPConnectOptions): Promise<void> {
    if (this._state !== 'disconnected') {
      throw new Error(`Cannot connect: state is ${this._state}`);
    }
    this._state = 'connecting';

    this.pipe.start(
      (msg) => this.handleWipMessage(msg),
      () => this.handleClose()
    );

    // Initialize Playwright protocol
    await this.sendWip('Playwright.enable', {});
    const ctx = await this.sendWip('Playwright.createContext', {});
    this.browserContextId = ctx['browserContextId'] as string;

    this._state = 'connected';
    log.info('WebKit adapter connected', { browserContextId: this.browserContextId });
  }

  disconnect(): void {
    // Attempt graceful shutdown
    try {
      this.pipe.send({ id: this.nextId++, method: 'Playwright.close', params: {} });
    } catch {
      // Best effort
    }
    this.cleanup();
    log.info('WebKit adapter disconnected');
  }

  async send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeout = 30000
  ): Promise<Record<string, unknown>> {
    if (this._state !== 'connected') {
      throw new Error('WebKit adapter is not connected');
    }

    // Route to the appropriate translator
    return this.translateAndSend(method, params ?? {}, sessionId, timeout);
  }

  on(event: string, listener: CDPEventListener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  off(event: string, listener: CDPEventListener): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(event);
    }
  }

  once(event: string, timeout = 30000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(new Error(`Timed out waiting for event: ${event}`));
      }, timeout);

      const handler: CDPEventListener = (params) => {
        clearTimeout(timer);
        this.off(event, handler);
        resolve(params);
      };

      this.on(event, handler);
    });
  }

  // -------------------------------------------------------------------------
  // CDP → WIP translation
  // -------------------------------------------------------------------------

  private async translateAndSend(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
    timeout: number
  ): Promise<Record<string, unknown>> {
    // Browser-level commands (no session)
    if (!sessionId) {
      return this.translateBrowserCommand(method, params, timeout);
    }

    // Per-target commands routed through Target.sendMessageToTarget
    const proxy = this.sessions.get(sessionId);
    if (!proxy) {
      throw new Error(`No WebKit session for CDP sessionId: ${sessionId}`);
    }

    return this.translateTargetCommand(method, params, proxy, timeout);
  }

  /**
   * Translate browser-level CDP commands to WIP equivalents.
   */
  private async translateBrowserCommand(
    method: string,
    params: Record<string, unknown>,
    timeout: number
  ): Promise<Record<string, unknown>> {
    switch (method) {
      case 'Target.getTargets': {
        // Return all known page proxies (attached or not) as CDP TargetInfo[].
        // Listing flows shouldn't depend on whether a proxy has been attached.
        const targetInfos = Array.from(this.pageProxies.values()).map((p) => ({
          targetId: p.pageProxyId,
          type: 'page',
          title: p.title,
          url: p.url,
          attached: p.resumed,
          browserContextId: p.browserContextId,
        }));
        return { targetInfos };
      }

      case 'Target.createTarget': {
        const url = (params['url'] as string) ?? 'about:blank';
        const proxy = await this.createPageProxy(url, timeout);
        return { targetId: proxy.pageProxyId };
      }

      case 'Target.attachToTarget': {
        const targetId = params['targetId'] as string;
        const proxy = this.findProxyByTargetId(targetId);
        if (!proxy) {
          throw new Error(`No WebKit page proxy for targetId: ${targetId}`);
        }

        // Resume the target if not already resumed
        if (!proxy.resumed) {
          await this.sendWip('Target.resume', { targetId: proxy.targetId }, proxy.pageProxyId);
          proxy.resumed = true;
        }

        // Generate a synthetic CDP sessionId
        const cdpSessionId = `webkit-session-${proxy.pageProxyId}`;
        this.sessions.set(cdpSessionId, proxy);
        this.proxyToSession.set(proxy.pageProxyId, cdpSessionId);

        return { sessionId: cdpSessionId };
      }

      case 'Target.detachFromTarget': {
        const sid = params['sessionId'] as string;
        const proxy = this.sessions.get(sid);
        if (proxy) {
          this.proxyToSession.delete(proxy.pageProxyId);
        }
        this.sessions.delete(sid);
        return {};
      }

      case 'Target.closeTarget': {
        const targetId = params['targetId'] as string;
        const proxy = this.findProxyByTargetId(targetId);
        if (proxy) {
          // Close only this specific page proxy. The browser context is
          // shared across all pages (created once in connect()), so deleting
          // it here would tear down every other tab. Use Playwright.closePage
          // to close just the requested page.
          try {
            await this.sendWip('Playwright.closePage', {
              pageProxyId: proxy.pageProxyId,
            });
          } catch (err) {
            log.warn('Playwright.closePage failed', {
              pageProxyId: proxy.pageProxyId,
              error: String(err),
            });
          }
          // Clean up session maps; the rest is finalized by
          // Playwright.pageProxyDestroyed when WebKit confirms the close.
          const sid = this.proxyToSession.get(proxy.pageProxyId);
          if (sid) {
            this.sessions.delete(sid);
            this.proxyToSession.delete(proxy.pageProxyId);
          }
          this.pageProxies.delete(proxy.pageProxyId);
        }
        return {};
      }

      default:
        log.warn('Unhandled browser-level CDP method, passing through', { method });
        return this.sendWip(method, params);
    }
  }

  /**
   * Translate per-target CDP commands. Some need special handling,
   * most pass through as inner WIP messages via Target.sendMessageToTarget.
   */
  private async translateTargetCommand(
    method: string,
    params: Record<string, unknown>,
    proxy: PageProxy,
    timeout: number
  ): Promise<Record<string, unknown>> {
    // Commands that need translation
    switch (method) {
      case 'Page.navigate': {
        // Navigation in WIP is top-level via Playwright.navigate
        const url = params['url'] as string;
        const result = await this.sendWip('Playwright.navigate', {
          url,
          pageProxyId: proxy.pageProxyId,
        });
        return { frameId: proxy.targetId, loaderId: result['loaderId'] ?? '' };
      }

      case 'Page.captureScreenshot': {
        // WIP uses Page.snapshotRect instead of Page.captureScreenshot
        const clip = params['clip'] as
          | { x: number; y: number; width: number; height: number }
          | undefined;
        const snapshotParams: Record<string, unknown> = {
          x: clip?.x ?? 0,
          y: clip?.y ?? 0,
          width: clip?.width ?? 1280,
          height: clip?.height ?? 800,
          coordinateSystem: 'Viewport',
        };
        const result = await this.sendInnerCommand(
          'Page.snapshotRect',
          snapshotParams,
          proxy,
          timeout
        );
        // WIP returns { dataURL: "data:image/png;base64,..." }
        // CDP expects { data: "<base64>" }
        let dataURL = result['dataURL'] as string;
        if (dataURL && dataURL.includes(',')) {
          dataURL = dataURL.split(',')[1];
        }
        return { data: dataURL ?? '' };
      }

      case 'Page.handleJavaScriptDialog': {
        // WIP uses Dialog.handleJavaScriptDialog
        return this.sendInnerCommand('Dialog.handleJavaScriptDialog', params, proxy, timeout);
      }

      case 'DOM.getBoxModel': {
        // WIP doesn't have getBoxModel; use getContentQuads
        const nodeId = params['nodeId'] as number;
        const result = await this.sendInnerCommand(
          'DOM.getContentQuads',
          { nodeId },
          proxy,
          timeout
        );
        const quads = result['quads'] as number[][] | undefined;
        if (quads && quads.length > 0) {
          const quad = quads[0];
          // quad is [x1,y1, x2,y2, x3,y3, x4,y4]
          const xs = [quad[0], quad[2], quad[4], quad[6]];
          const ys = [quad[1], quad[3], quad[5], quad[7]];
          const minX = Math.min(...xs);
          const minY = Math.min(...ys);
          const maxX = Math.max(...xs);
          const maxY = Math.max(...ys);
          return {
            model: {
              content: quad,
              width: maxX - minX,
              height: maxY - minY,
            },
          };
        }
        return { model: null };
      }

      case 'Runtime.evaluate': {
        const result = await this.sendInnerCommand(method, params, proxy, timeout);
        return this.translateRuntimeResult(result);
      }

      case 'Runtime.callFunctionOn': {
        const result = await this.sendInnerCommand(method, params, proxy, timeout);
        return this.translateRuntimeResult(result);
      }

      default:
        // Pass through: Runtime.enable, DOM.enable, DOM.getDocument,
        // DOM.querySelector, DOM.resolveNode, Input.*, Network.*, Page.enable, etc.
        return this.sendInnerCommand(method, params, proxy, timeout);
    }
  }

  // -------------------------------------------------------------------------
  // WIP transport helpers
  // -------------------------------------------------------------------------

  /**
   * Send a top-level WIP command and wait for response.
   */
  private sendWip(
    method: string,
    params: Record<string, unknown>,
    pageProxyId?: string,
    timeout = 30000
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method, params };
    if (pageProxyId) msg['pageProxyId'] = pageProxyId;

    log.debug('WIP send', { method, id, pageProxyId });

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`WIP command timed out after ${timeout}ms: ${method}`));
      }, timeout);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.pipe.send(msg);
    });
  }

  /**
   * Send a command to an inner target via Target.sendMessageToTarget.
   */
  private sendInnerCommand(
    method: string,
    params: Record<string, unknown>,
    proxy: PageProxy,
    timeout = 30000
  ): Promise<Record<string, unknown>> {
    const innerId = this.nextInnerId++;
    const innerMessage = JSON.stringify({ id: innerId, method, params });

    log.debug('WIP inner send', { method, innerId, targetId: proxy.targetId });

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.innerPending.delete(innerId);
        reject(new Error(`Inner WIP command timed out after ${timeout}ms: ${method}`));
      }, timeout);

      const sessionId = this.proxyToSession.get(proxy.pageProxyId) ?? '';
      this.innerPending.set(innerId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        sessionId,
      });

      // Send via top-level Target.sendMessageToTarget
      this.pipe.send({
        id: this.nextId++,
        method: 'Target.sendMessageToTarget',
        params: {
          targetId: proxy.targetId,
          message: innerMessage,
        },
        pageProxyId: proxy.pageProxyId,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Incoming WIP message handling
  // -------------------------------------------------------------------------

  private handleWipMessage(msg: Record<string, unknown>): void {
    // Response to a top-level command
    if ('id' in msg && typeof msg['id'] === 'number') {
      const id = msg['id'] as number;
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        if (msg['error']) {
          const err = msg['error'] as { message: string; code?: number };
          p.reject(new Error(`WIP error: ${err.message} (${err.code ?? 0})`));
        } else {
          p.resolve((msg['result'] as Record<string, unknown>) ?? {});
        }
        return;
      }
      // Response to a Target.sendMessageToTarget — ignore (actual response
      // comes via Target.dispatchMessageFromTarget)
      return;
    }

    // Event notification
    const method = msg['method'] as string | undefined;
    if (!method) return;

    const params = (msg['params'] as Record<string, unknown>) ?? {};
    const pageProxyId = msg['pageProxyId'] as string | undefined;

    switch (method) {
      case 'Playwright.pageProxyCreated':
        this.handlePageProxyCreated(params);
        break;

      case 'Playwright.pageProxyDestroyed':
        this.handlePageProxyDestroyed(params);
        break;

      case 'Target.targetCreated':
        this.handleTargetCreated(params, pageProxyId);
        break;

      case 'Target.dispatchMessageFromTarget':
        this.handleDispatchFromTarget(params, pageProxyId);
        break;

      case 'Target.targetDestroyed':
        // Target within a page proxy was destroyed
        break;

      case 'Target.didCommitProvisionalTarget':
        this.handleProvisionalTarget(params, pageProxyId);
        break;

      default:
        // Pass through any other events as CDP events
        log.debug('WIP event (unhandled)', { method });
        break;
    }
  }

  private handlePageProxyCreated(params: Record<string, unknown>): void {
    const pageProxyInfo = params['pageProxyInfo'] as {
      pageProxyId: string;
      browserContextId: string;
    };
    if (!pageProxyInfo) return;
    log.debug('Page proxy created', { pageProxyId: pageProxyInfo.pageProxyId });
    // Track the proxy, but we still need Target.targetCreated for the targetId
  }

  private handlePageProxyDestroyed(params: Record<string, unknown>): void {
    const pageProxyId = params['pageProxyId'] as string;
    if (!pageProxyId) return;
    log.debug('Page proxy destroyed', { pageProxyId });

    const sessionId = this.proxyToSession.get(pageProxyId);
    if (sessionId) {
      this.sessions.delete(sessionId);
      this.proxyToSession.delete(pageProxyId);
      // Emit a CDP-style Target.detachedFromTarget event
      this.emit('Target.detachedFromTarget', { sessionId });
    }
    this.pageProxies.delete(pageProxyId);
  }

  private handleTargetCreated(
    params: Record<string, unknown>,
    pageProxyId: string | undefined
  ): void {
    const targetInfo = params['targetInfo'] as {
      targetId: string;
      type: string;
      url?: string;
      title?: string;
    };
    if (!targetInfo || !pageProxyId) return;
    log.debug('Target created', { targetId: targetInfo.targetId, pageProxyId });

    // Resolve any pending createPageProxy waiting for this target
    const pending = this.pendingProxies.get(pageProxyId);
    if (pending) {
      this.pendingProxies.delete(pageProxyId);
      const proxy: PageProxy = {
        pageProxyId,
        browserContextId: pending.browserContextId,
        targetId: targetInfo.targetId,
        url: targetInfo.url ?? '',
        title: targetInfo.title ?? '',
        resumed: false,
      };
      // Track the proxy in the authoritative map so attach/getTargets find it.
      this.pageProxies.set(pageProxyId, proxy);
      pending.resolve(proxy);
    } else {
      // Target created externally (e.g. window.open in WebKit); record it so
      // listing/attach flows can see it without a corresponding createTarget.
      const existing = this.pageProxies.get(pageProxyId);
      if (existing) {
        existing.targetId = targetInfo.targetId;
        existing.url = targetInfo.url ?? existing.url;
        existing.title = targetInfo.title ?? existing.title;
      } else if (this.browserContextId) {
        this.pageProxies.set(pageProxyId, {
          pageProxyId,
          browserContextId: this.browserContextId,
          targetId: targetInfo.targetId,
          url: targetInfo.url ?? '',
          title: targetInfo.title ?? '',
          resumed: false,
        });
      }
    }
  }

  private handleDispatchFromTarget(
    params: Record<string, unknown>,
    pageProxyId: string | undefined
  ): void {
    const messageStr = params['message'] as string;
    if (!messageStr) return;

    let innerMsg: Record<string, unknown>;
    try {
      innerMsg = JSON.parse(messageStr) as Record<string, unknown>;
    } catch {
      return;
    }

    // Inner response (has id)
    if ('id' in innerMsg && typeof innerMsg['id'] === 'number') {
      const innerId = innerMsg['id'] as number;
      const p = this.innerPending.get(innerId);
      if (p) {
        this.innerPending.delete(innerId);
        if (innerMsg['error']) {
          const err = innerMsg['error'] as { message: string; code?: number };
          p.reject(new Error(`WIP target error: ${err.message} (${err.code ?? 0})`));
        } else {
          p.resolve((innerMsg['result'] as Record<string, unknown>) ?? {});
        }
      }
      return;
    }

    // Inner event — translate to CDP event with sessionId
    const innerMethod = innerMsg['method'] as string | undefined;
    if (!innerMethod || !pageProxyId) return;
    const innerParams = (innerMsg['params'] as Record<string, unknown>) ?? {};

    const sessionId = this.proxyToSession.get(pageProxyId);

    // Translate WIP event names to CDP equivalents
    const cdpEvent = this.translateEventName(innerMethod);
    const cdpParams = this.translateEventParams(innerMethod, innerParams);

    if (sessionId) {
      cdpParams['sessionId'] = sessionId;
    }
    this.emit(cdpEvent, cdpParams);
  }

  /**
   * Handle provisional target commit (navigation within page creates new target).
   */
  private handleProvisionalTarget(
    params: Record<string, unknown>,
    pageProxyId: string | undefined
  ): void {
    const oldTargetId = params['oldTargetId'] as string | undefined;
    const newTargetId = params['newTargetId'] as string | undefined;
    if (!oldTargetId || !newTargetId || !pageProxyId) return;

    log.debug('Provisional target committed', { oldTargetId, newTargetId, pageProxyId });

    // Update session to point to the new target
    const sessionId = this.proxyToSession.get(pageProxyId);
    if (sessionId) {
      const proxy = this.sessions.get(sessionId);
      if (proxy) {
        proxy.targetId = newTargetId;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Page proxy lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create a new page proxy: createPage + wait for targetCreated + navigate.
   */
  private async createPageProxy(url: string, timeout: number): Promise<PageProxy> {
    if (!this.browserContextId) {
      throw new Error('No browser context — call connect() first');
    }

    // Create the page — this triggers pageProxyCreated + targetCreated events
    const createResult = await this.sendWip('Playwright.createPage', {
      browserContextId: this.browserContextId,
    });
    const pageProxyId = createResult['pageProxyId'] as string;

    // Wait for Target.targetCreated event for this pageProxy
    const proxy = await new Promise<PageProxy>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingProxies.delete(pageProxyId);
        reject(new Error(`Timed out waiting for target in page proxy ${pageProxyId}`));
      }, timeout);

      this.pendingProxies.set(pageProxyId, {
        pageProxyId,
        browserContextId: this.browserContextId!,
        resolve: (p) => {
          clearTimeout(timer);
          resolve(p);
        },
      });
    });

    // Navigate if url is not about:blank
    if (url && url !== 'about:blank') {
      await this.sendWip('Playwright.navigate', { url, pageProxyId });
      proxy.url = url;
    }

    return proxy;
  }

  // -------------------------------------------------------------------------
  // Translation helpers
  // -------------------------------------------------------------------------

  /**
   * Translate WIP Runtime result shape to CDP's exceptionDetails format.
   */
  private translateRuntimeResult(result: Record<string, unknown>): Record<string, unknown> {
    // WIP uses `wasThrown` instead of CDP's `exceptionDetails`
    if (result['wasThrown']) {
      const remoteObj = result['result'] as { description?: string; value?: unknown } | undefined;
      return {
        ...result,
        exceptionDetails: {
          text: 'Evaluation failed',
          exception: {
            description: remoteObj?.description ?? String(remoteObj?.value ?? 'Unknown error'),
          },
        },
      };
    }
    return result;
  }

  /**
   * Translate WIP event names to CDP equivalents.
   * Most are identical; a few differ.
   */
  private translateEventName(wipMethod: string): string {
    // Dialog events use a different domain in WIP
    if (wipMethod === 'Dialog.javascriptDialogOpening') {
      return 'Page.javascriptDialogOpening';
    }
    return wipMethod;
  }

  /**
   * Translate WIP event params to CDP format if needed.
   */
  private translateEventParams(
    _wipMethod: string,
    params: Record<string, unknown>
  ): Record<string, unknown> {
    // Most params pass through unchanged. Add specific translations here as needed.
    return { ...params };
  }

  /**
   * Find a PageProxy by its pageProxyId (used as CDP targetId).
   * Searches the authoritative `pageProxies` map so freshly-created targets
   * (not yet attached) are discoverable.
   */
  private findProxyByTargetId(targetId: string): PageProxy | undefined {
    // targetId in CDP maps to pageProxyId in WIP
    return this.pageProxies.get(targetId);
  }

  /**
   * Emit a CDP-style event to registered listeners.
   */
  private emit(event: string, params: Record<string, unknown>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(params);
      } catch {
        // Don't let one listener break others
      }
    }
  }

  private handleClose(): void {
    log.error('WebKit pipe closed unexpectedly', {
      pendingCommands: this.pending.size,
      innerPendingCommands: this.innerPending.size,
    });
    for (const [, p] of this.pending) {
      p.reject(new Error('WebKit pipe closed'));
    }
    for (const [, p] of this.innerPending) {
      p.reject(new Error('WebKit pipe closed'));
    }
    this.cleanup();
  }

  private cleanup(): void {
    this._state = 'disconnected';
    this.pending.clear();
    this.innerPending.clear();
    this.sessions.clear();
    this.proxyToSession.clear();
    this.pageProxies.clear();
    this.pendingProxies.clear();
    this.browserContextId = null;
  }
}
