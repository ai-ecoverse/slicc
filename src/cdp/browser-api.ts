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

const DEFAULT_CDP_URL = 'ws://localhost:3000/cdp';

export class BrowserAPI {
  private client: CDPTransport;
  private sessionId: string | null = null;
  private attachedTargetId: string | null = null;

  constructor(client?: CDPTransport) {
    this.client = client ?? new CDPClient();
  }

  /**
   * Connect to the CDP proxy.
   * DebuggerClient (extension mode) accepts but ignores these options.
   */
  async connect(options?: Partial<CDPConnectOptions>): Promise<void> {
    await this.client.connect({
      url: options?.url ?? DEFAULT_CDP_URL,
      timeout: options?.timeout,
    });
  }

  /**
   * Create a new browser tab/target.
   * Returns the targetId of the newly created tab.
   */
  async createPage(url?: string): Promise<string> {
    await this.ensureConnected();
    const result = await this.client.send('Target.createTarget', {
      url: url ?? 'about:blank',
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
  }): Promise<string> {
    await this.ensureConnected();
    this.ensureAttached();

    const params: Record<string, unknown> = {
      format: options?.format ?? 'png',
    };
    if (options?.quality !== undefined) params['quality'] = options.quality;
    if (options?.fullPage) {
      // Get full page metrics for a full-page screenshot
      const metrics = await this.client.send(
        'Page.getLayoutMetrics',
        {},
        this.sessionId!,
      );
      const contentSize = metrics['contentSize'] as {
        width: number;
        height: number;
      };
      params['clip'] = {
        x: 0,
        y: 0,
        width: contentSize.width,
        height: contentSize.height,
        scale: 1,
      };
      params['captureBeyondViewport'] = true;
    }

    const result = await this.client.send(
      'Page.captureScreenshot',
      params,
      this.sessionId!,
    );
    return result['data'] as string;
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
      role: { value: string };
      name: { value: string };
      description?: { value: string };
      value?: { value: string };
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
      const node: AccessibilityNode & { childIds?: string[] } = {
        role: n.role?.value ?? 'unknown',
        name: n.name?.value ?? '',
      };
      if (n.value?.value) node.value = n.value.value;
      if (n.description?.value) node.description = n.description.value;
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

      if (node.childIds && node.childIds.length > 0) {
        result.children = node.childIds
          .map((cid) => buildTree(cid))
          .filter((c) => c.role !== 'unknown');
      }

      return result;
    }

    return rootId ? buildTree(rootId) : { role: 'RootWebArea', name: '' };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

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
