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
import { normalizeAccessibilityText } from './normalize-accessibility-text.js';
import { createLogger } from '../core/logger.js';

const FALLBACK_CDP_URL = 'ws://localhost:3000/cdp';
const log = createLogger('browser-api');

export function getDefaultCdpUrl(
  locationLike: Pick<Location, 'protocol' | 'host'> | null = typeof window !== 'undefined'
    ? window.location
    : null,
): string {
  if (!locationLike?.host) return FALLBACK_CDP_URL;
  const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${locationLike.host}/cdp`;
}

export class BrowserAPI {
  private client: CDPTransport;
  private sessionId: string | null = null;
  private attachedTargetId: string | null = null;
  private readonly handleJavaScriptDialogOpening = async (
    params: Record<string, unknown>,
  ): Promise<void> => {
    const sessionId = typeof params['sessionId'] === 'string'
      ? params['sessionId'] as string
      : this.sessionId;
    if (!sessionId) return;

    try {
      await this.client.send(
        'Page.handleJavaScriptDialog',
        { accept: false },
        sessionId,
        5000,
      );
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
    this.client.on('Page.javascriptDialogOpening', this.handleJavaScriptDialogOpening);
  }

  /**
   * Get the underlying CDP transport.
   * Used by HarRecorder to subscribe to network events.
   */
  getTransport(): CDPTransport {
    return this.client;
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
   */
  async createPage(url?: string): Promise<string> {
    await this.ensureConnected();
    const result = await this.client.send('Target.createTarget', {
      url: url ?? 'about:blank',
      background: true,
    });
    return result['targetId'] as string;
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
   */
  async listPages(): Promise<PageInfo[]> {
    await this.ensureConnected();
    const result = await this.client.send('Target.getTargets');
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
   */
  async attachToPage(targetId: string): Promise<string> {
    await this.ensureConnected();
    // Detach from previous target if needed
    if (this.sessionId && this.attachedTargetId !== targetId) {
      await this.detach();
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
    return this.sessionId;
  }

  /**
   * Detach from the currently attached target.
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
              expression: 'JSON.stringify({ w: window.innerWidth, h: document.documentElement.scrollHeight })',
              returnByValue: true,
            },
            this.sessionId!,
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

      const result = await this.client.send(
        'Page.captureScreenshot',
        params,
        this.sessionId!,
      );
      let base64 = result['data'] as string;

      // Post-capture resize: downscale if image exceeds maxWidth.
      // Uses OffscreenCanvas (available in Chrome workers and pages).
      if (options?.maxWidth && typeof OffscreenCanvas !== 'undefined') {
        try {
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const blob = new Blob([bytes], { type: 'image/png' });
          const bitmap = await createImageBitmap(blob);

          if (bitmap.width > options.maxWidth) {
            const ratio = options.maxWidth / bitmap.width;
            const targetW = Math.round(bitmap.width * ratio);
            const targetH = Math.round(bitmap.height * ratio);
            const canvas = new OffscreenCanvas(targetW, targetH);
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(bitmap, 0, 0, targetW, targetH);
            const outBlob = await canvas.convertToBlob({ type: 'image/png' });
            const buffer = await outBlob.arrayBuffer();
            const outBytes = new Uint8Array(buffer);
            let outBinary = '';
            for (let i = 0; i < outBytes.length; i++) outBinary += String.fromCharCode(outBytes[i]);
            base64 = btoa(outBinary);
          }
          bitmap.close();
        } catch {
          // Best-effort — return original if resize fails
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
  async evaluate(
    expression: string,
    options?: EvaluateOptions,
  ): Promise<unknown> {
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
      this.sessionId!,
    );

    const exceptionDetails = result['exceptionDetails'] as
      | { text: string; exception?: { description?: string } }
      | undefined;
    if (exceptionDetails) {
      const msg =
        exceptionDetails.exception?.description ?? exceptionDetails.text;
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
      this.sessionId!,
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
      this.sessionId!,
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
        this.sessionId!,
      );
      await this.client.send(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', text: char },
        this.sessionId!,
      );
    }
  }

  /**
   * Wait for a CSS selector to appear in the DOM.
   */
  async waitForSelector(
    selector: string,
    options?: WaitForSelectorOptions,
  ): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    const timeout = options?.timeout ?? 30000;
    const interval = options?.interval ?? 100;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const found = await this.evaluate(
        `!!document.querySelector(${JSON.stringify(selector)})`,
      );
      if (found) return;
      await new Promise((r) => setTimeout(r, interval));
    }

    throw new Error(
      `waitForSelector timed out after ${timeout}ms: ${selector}`,
    );
  }

  /**
   * Get the accessibility tree of the attached page.
   */
  async getAccessibilityTree(): Promise<AccessibilityNode> {
    await this.ensureConnected();
    this.ensureAttached();

    await this.client.send('Accessibility.enable', {}, this.sessionId!);

    const result = await this.client.send(
      'Accessibility.getFullAXTree',
      {},
      this.sessionId!,
    );

    const nodes = result['nodes'] as Array<{
      nodeId: string;
      backendDOMNodeId?: number;
      role: { value: unknown };
      name: { value: unknown };
      description?: { value: unknown };
      value?: { value: unknown };
      parentId?: string;
      childIds?: string[];
    }>;

    if (!nodes || nodes.length === 0) {
      return { role: 'RootWebArea', name: '' };
    }

    // Build a map of nodeId → node
    const nodeMap = new Map<string, AccessibilityNode & { childIds?: string[] }>();
    let rootId: string | undefined;

    for (const n of nodes) {
      const value = normalizeAccessibilityText(n.value?.value);
      const description = normalizeAccessibilityText(n.description?.value);
      const node: AccessibilityNode & { childIds?: string[] } = {
        role: normalizeAccessibilityText(n.role?.value, 'unknown'),
        name: normalizeAccessibilityText(n.name?.value),
      };
      if (value !== '') node.value = value;
      if (description !== '') node.description = description;
      if (n.backendDOMNodeId) node.backendNodeId = n.backendDOMNodeId;
      if (n.childIds) node.childIds = n.childIds;
      nodeMap.set(n.nodeId, node);

      if (!n.parentId) rootId = n.nodeId;
    }

    // Build tree recursively
    function buildTree(id: string): AccessibilityNode {
      const node = nodeMap.get(id);
      if (!node) return { role: 'unknown', name: '' };

      const result: AccessibilityNode = {
        role: node.role,
        name: node.name,
      };
      if (node.value) result.value = node.value;
      if (node.description) result.description = node.description;
      if (node.backendNodeId) result.backendNodeId = node.backendNodeId;

      if (node.childIds && node.childIds.length > 0) {
        result.children = node.childIds
          .map((cid) => buildTree(cid))
          .filter((c) => c.role !== 'unknown');
      }

      return result;
    }

    return rootId ? buildTree(rootId) : { role: 'RootWebArea', name: '' };
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
      this.sessionId!,
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
      this.sessionId!,
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
        this.sessionId!,
      );
      return;
    }

    // Click at center of the element's bounding box
    const x = boxValue.x + boxValue.width / 2;
    const y = boxValue.y + boxValue.height / 2;

    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
      this.sessionId!,
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
      this.sessionId!,
    );
  }

  /**
   * Double-click an element by its CDP backend node ID.
   */
  async dblclickByBackendNodeId(backendNodeId: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    const { x, y } = await this.resolveNodeCenter(backendNodeId);

    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button, clickCount: 1 },
      this.sessionId!,
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button, clickCount: 1 },
      this.sessionId!,
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button, clickCount: 2 },
      this.sessionId!,
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button, clickCount: 2 },
      this.sessionId!,
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
      this.sessionId!,
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
      this.sessionId!,
    );
  }

  /**
   * Check or uncheck a checkbox/radio element by its CDP backend node ID.
   * Only clicks if the current state differs from the desired state.
   * Returns the action taken.
   */
  async setCheckedByBackendNodeId(backendNodeId: number, checked: boolean): Promise<'toggled' | 'already'> {
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
      this.sessionId!,
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
      this.sessionId!,
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: end.x, y: end.y },
      this.sessionId!,
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', clickCount: 1 },
      this.sessionId!,
    );
  }

  /**
   * Send a raw CDP command on the current session.
   * Used by playwright-cli for cookie operations via the Network domain.
   */
  async sendCDP(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
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
      this.sessionId!,
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
      this.sessionId!,
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
   */
  private async ensureConnected(): Promise<void> {
    if (this.client.state === 'disconnected') {
      // Previous session/target are no longer valid after reconnect
      this.sessionId = null;
      this.attachedTargetId = null;
      await this.connect();
    }
  }

  private ensureAttached(): void {
    if (!this.sessionId) {
      throw new Error(
        'Not attached to a page. Call attachToPage(targetId) first.',
      );
    }
  }

  /**
   * Get the bounding box of an element by CSS selector.
   */
  private async boundingBox(selector: string): Promise<BoundingBox | null> {
    await this.client.send('DOM.enable', {}, this.sessionId!);

    const docResult = await this.client.send(
      'DOM.getDocument',
      { depth: 0 },
      this.sessionId!,
    );
    const rootNodeId = (docResult['root'] as { nodeId: number }).nodeId;

    let nodeId: number;
    try {
      const queryResult = await this.client.send(
        'DOM.querySelector',
        { nodeId: rootNodeId, selector },
        this.sessionId!,
      );
      nodeId = queryResult['nodeId'] as number;
    } catch {
      return null;
    }

    if (!nodeId) return null;

    const boxModel = await this.client.send(
      'DOM.getBoxModel',
      { nodeId },
      this.sessionId!,
    );
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
