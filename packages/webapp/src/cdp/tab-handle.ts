import { createLogger } from '../base/logger.js';
import { abortableDelay, abortWaiter, throwIfAborted } from './command-abort.js';
import { INJECTED_ARIA_SNAPSHOT_SCRIPT } from './injected-aria-snapshot.js';
import { normalizeAccessibilityText } from './normalize-accessibility-text.js';
import { type AbortWaiter, waitForEvent } from './pending-request-table.js';
import type { CDPTransport } from './transport.js';
import type {
  AccessibilityNode,
  BoundingBox,
  EvaluateOptions,
  FrameEvaluateOptions,
  FrameInfo,
  WaitForSelectorOptions,
} from './types.js';

const log = createLogger('tab-handle');

export type CdpPayload = { [key: string]: unknown };

const NAVIGATE_LOAD_TIMEOUT_MS = 30000;

export interface ViewportOverride {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;

  userAgent?: string;
}

export type ExecutionWorld = 'main' | 'isolated';

export interface TabHost {
  runGlobal<T>(targetId: string, fn: () => Promise<T>): Promise<T>;

  wakeCapture(tab: TabHandle, params: CdpPayload): Promise<CdpPayload>;

  viewportOverride(targetId: string): ViewportOverride | undefined;

  recordViewportOverride(targetId: string, vp: ViewportOverride): void;

  frameContexts(sessionId: string, world: ExecutionWorld): Map<string, number>;
}

function pngWidth(base64: string): number {
  try {
    const bin = atob(base64.slice(0, 48));
    if (!bin.startsWith('\x89PNG\r\n\x1a\n')) return 0;
    return (
      ((bin.charCodeAt(16) << 24) |
        (bin.charCodeAt(17) << 16) |
        (bin.charCodeAt(18) << 8) |
        bin.charCodeAt(19)) >>>
      0
    );
  } catch {
    return 0;
  }
}

export function onceForSession(
  transport: CDPTransport,
  event: string,
  sessionId: string,
  timeoutMs: number,
  abort?: AbortWaiter
): Promise<CdpPayload> {
  return waitForEvent<CdpPayload>(
    (deliver) => {
      const listener = (params: CdpPayload): void => {
        const eventSession = params['sessionId'];
        if (typeof eventSession === 'string' && eventSession !== sessionId) return;
        deliver(params);
      };
      transport.on(event, listener);
      return () => transport.off(event, listener);
    },
    timeoutMs,
    `Timed out waiting for event: ${event}`,
    abort
  );
}

export interface ScreenshotOptions {
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number; scale?: number };
  maxWidth?: number;

  foregroundFallback?: boolean;
}

export interface ViewportOptions {
  deviceScaleFactor?: number;
  mobile?: boolean;
  userAgent?: string;
}

export type TabPage = { [K in keyof TabHandle]: TabHandle[K] };

export class TabHandle {
  constructor(
    private readonly host: TabHost,

    readonly targetId: string,

    readonly sessionId: string,

    readonly transport: CDPTransport,

    private readonly signal?: AbortSignal | undefined
  ) {}

  send(method: string, params: CdpPayload = {}): Promise<CdpPayload> {
    throwIfAborted(this.signal, `about to send ${method}`);
    return this.transport.send(method, params, this.sessionId);
  }

  async navigate(url: string): Promise<void> {
    await this.send('Page.enable');

    const loadPromise = onceForSession(
      this.transport,
      'Page.loadEventFired',
      this.sessionId,
      NAVIGATE_LOAD_TIMEOUT_MS,

      abortWaiter(this.signal, `waiting for ${url} to fire its load event`)
    );

    void loadPromise.catch(() => undefined);

    await this.send('Page.navigate', { url });
    await loadPromise;
  }

  async bringToFront(): Promise<void> {
    await this.host.runGlobal(this.targetId, async () => {
      await this.send('Page.bringToFront');
    });
  }

  async screenshot(options?: ScreenshotOptions): Promise<string> {
    const params: CdpPayload = {
      format: options?.format ?? 'png',

      captureBeyondViewport: !!(options?.clip || options?.fullPage),
    };
    if (options?.quality !== undefined) params['quality'] = options.quality;
    if (options?.clip || options?.fullPage) {
      params['clip'] = await this.captureClip(options);
    }

    let result: CdpPayload;
    try {
      result = await this.send('Page.captureScreenshot', params);
    } catch (err: unknown) {
      if (options?.foregroundFallback === false) throw err;
      result = await this.host.wakeCapture(this, params);
    }
    const base64 = result['data'] as string;
    if (options?.maxWidth) return await this.applyMaxWidth(base64, options.maxWidth, params);
    return base64;
  }

  private async captureClip(
    options: ScreenshotOptions
  ): Promise<{ x: number; y: number; width: number; height: number; scale: number }> {
    if (options.clip) return { ...options.clip, scale: options.clip.scale ?? 1 };

    let cssWidth = 0;
    let cssScrollHeight = 0;
    try {
      await this.send('Runtime.enable');
      const evalResult = await this.send('Runtime.evaluate', {
        expression:
          'JSON.stringify({ w: window.innerWidth, h: document.documentElement.scrollHeight })',
        returnByValue: true,
      });
      const val = JSON.parse((evalResult['result'] as { value?: string })?.value ?? '{}');
      cssWidth = val.w ?? 0;
      cssScrollHeight = val.h ?? 0;
    } catch (e) {
      log.warn('fullPage: failed to evaluate scroll dimensions, falling back to viewport', e);
    }
    return { x: 0, y: 0, width: cssWidth || 1280, height: cssScrollHeight || 800, scale: 1 };
  }

  private async applyMaxWidth(
    base64: string,
    maxWidth: number,
    params: CdpPayload
  ): Promise<string> {
    const peekWidth = pngWidth(base64);
    if (!peekWidth || peekWidth <= maxWidth) return base64;

    const scale = maxWidth / peekWidth;
    const existingClip = params['clip'] as
      | { x: number; y: number; width: number; height: number; scale?: number }
      | undefined;

    if (existingClip) {
      existingClip.scale = (existingClip.scale ?? 1) * scale;
    } else {
      let vw = 1280;
      let vh = 800;
      try {
        await this.send('Runtime.enable');
        const dim = await this.send('Runtime.evaluate', {
          expression: 'JSON.stringify({w:window.innerWidth,h:window.innerHeight})',
          returnByValue: true,
        });
        const v = JSON.parse((dim['result'] as { value?: string })?.value ?? '{}');
        vw = v.w || 1280;
        vh = v.h || 800;
      } catch {}
      params['clip'] = { x: 0, y: 0, width: vw, height: vh, scale };
    }
    params['captureBeyondViewport'] = true;

    try {
      const resized = await this.send('Page.captureScreenshot', params);
      return resized['data'] as string;
    } catch (err) {
      log.warn('maxWidth re-capture failed, returning original', err);
      return base64;
    }
  }

  async setViewportOverride(
    width: number,
    height: number,
    options?: ViewportOptions
  ): Promise<void> {
    const prev = this.host.viewportOverride(this.targetId);
    const vp: ViewportOverride = {
      width,
      height,
      deviceScaleFactor: options?.deviceScaleFactor ?? prev?.deviceScaleFactor ?? 1,
      mobile: options?.mobile ?? prev?.mobile ?? false,
      ...((options?.userAgent ?? prev?.userAgent) !== undefined && {
        userAgent: options?.userAgent ?? prev?.userAgent,
      }),
    };
    await this.applyViewportOverride(vp);
    this.host.recordViewportOverride(this.targetId, vp);
  }

  async applyViewportOverride(vp: ViewportOverride): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.deviceScaleFactor,
      mobile: vp.mobile,
    });
    if (vp.mobile) {
      await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    if (vp.userAgent !== undefined) {
      await this.send('Emulation.setUserAgentOverride', { userAgent: vp.userAgent });
    }
  }

  async evaluate(expression: string, options?: EvaluateOptions): Promise<unknown> {
    await this.send('Runtime.enable');
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: options?.awaitPromise ?? true,
      returnByValue: options?.returnByValue ?? true,
    });
    return readEvaluateResult(result, 'Evaluation failed');
  }

  async evaluateInFrame(
    frameId: string,
    expression: string,
    options?: FrameEvaluateOptions
  ): Promise<unknown> {
    const world: ExecutionWorld = options?.world === 'main' ? 'main' : 'isolated';

    let contextId: number;
    try {
      contextId = await this.resolveFrameContext(frameId, world);
    } catch (err) {
      const label = world === 'main' ? 'main world' : 'isolated world';
      throw new Error(
        `Failed to resolve ${label} for frame ${frameId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (world === 'isolated') await this.send('Runtime.enable');

    const evaluateParams = {
      expression,
      contextId,
      awaitPromise: options?.awaitPromise ?? true,
      returnByValue: options?.returnByValue ?? true,
    };

    let result: CdpPayload;
    try {
      result = await this.send('Runtime.evaluate', evaluateParams);
    } catch (err) {
      if (!isDestroyedContextError(err)) throw err;
      this.host.frameContexts(this.sessionId, world).delete(frameId);
      contextId = await this.resolveFrameContext(frameId, world);
      result = await this.send('Runtime.evaluate', { ...evaluateParams, contextId });
    }

    const failure = evaluationFailure(result);
    if (failure === null) return (result['result'] as { value?: unknown })?.value;

    this.host.frameContexts(this.sessionId, world).delete(frameId);
    if (!isDestroyedContextError(new Error(failure))) {
      throw new Error(`Evaluation in frame ${frameId} failed: ${failure}`);
    }
    contextId = await this.resolveFrameContext(frameId, world);
    const retry = await this.send('Runtime.evaluate', { ...evaluateParams, contextId });
    const retryFailure = evaluationFailure(retry);
    if (retryFailure !== null) {
      throw new Error(`Evaluation in frame ${frameId} failed: ${retryFailure}`);
    }
    return (retry['result'] as { value?: unknown })?.value;
  }

  private async resolveFrameContext(frameId: string, world: ExecutionWorld): Promise<number> {
    const cache = this.host.frameContexts(this.sessionId, world);
    const cached = cache.get(frameId);
    if (cached !== undefined) return cached;

    if (world === 'isolated') {
      const worldResult = await this.send('Page.createIsolatedWorld', {
        frameId,
        worldName: '__slicc_iframe',
      });
      const id = worldResult['executionContextId'] as number;
      cache.set(frameId, id);
      return id;
    }

    await this.send('Runtime.enable');
    let id = cache.get(frameId);
    if (id === undefined) {
      await this.send('Runtime.disable');
      await this.send('Runtime.enable');
      id = cache.get(frameId);
    }
    if (id === undefined) {
      throw new Error(`Failed to find main world execution context for frame ${frameId}`);
    }
    return id;
  }

  async click(selector: string, modifiers = 0): Promise<void> {
    const box = await this.boundingBox(selector);
    if (!box) throw new Error(`Element not found: ${selector}`);
    await this.clickAt(box.x + box.width / 2, box.y + box.height / 2, modifiers);
  }

  async type(text: string): Promise<void> {
    for (const char of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', text: char });
    }
  }

  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
  }

  async waitForSelector(selector: string, options?: WaitForSelectorOptions): Promise<void> {
    const timeout = options?.timeout ?? 30000;
    const interval = options?.interval ?? 100;
    const start = Date.now();
    const step = `polling for selector ${selector}`;

    while (Date.now() - start < timeout) {
      throwIfAborted(this.signal, step);
      const found = await this.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (found) return;

      await abortableDelay(interval, this.signal, step);
    }

    throw new Error(`waitForSelector timed out after ${timeout}ms: ${selector}`);
  }

  async clickByBackendNodeId(backendNodeId: number, modifiers = 0): Promise<void> {
    const objectId = await this.resolveNodeObjectId(backendNodeId);
    const box = await this.nodeBox(objectId);
    if (!box || box.width === 0 || box.height === 0) {
      await this.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function() { this.click(); }',
      });
      return;
    }
    await this.clickAt(box.x + box.width / 2, box.y + box.height / 2, modifiers);
  }

  async dblclickByBackendNodeId(
    backendNodeId: number,
    button: 'left' | 'right' | 'middle' = 'left',
    modifiers = 0
  ): Promise<void> {
    const { x, y } = await this.resolveNodeCenter(backendNodeId);
    for (const clickCount of [1, 2]) {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button,
        clickCount,
        modifiers,
      });
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button,
        clickCount,
        modifiers,
      });
    }
  }

  async hoverByBackendNodeId(backendNodeId: number): Promise<void> {
    const { x, y } = await this.resolveNodeCenter(backendNodeId);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  }

  async selectByBackendNodeId(backendNodeId: number, value: string): Promise<void> {
    const objectId = await this.resolveNodeObjectId(backendNodeId);
    await this.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(val) { this.value = val; this.dispatchEvent(new Event('change', { bubbles: true })); }`,
      arguments: [{ value }],
      returnByValue: true,
    });
  }

  async setCheckedByBackendNodeId(
    backendNodeId: number,
    checked: boolean
  ): Promise<'toggled' | 'already'> {
    const objectId = await this.resolveNodeObjectId(backendNodeId);
    const stateResult = await this.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() { return this.checked; }`,
      returnByValue: true,
    });
    if ((stateResult['result'] as { value?: boolean })?.value === checked) return 'already';
    await this.clickByBackendNodeId(backendNodeId);
    return 'toggled';
  }

  async dragByBackendNodeIds(startBackendNodeId: number, endBackendNodeId: number): Promise<void> {
    const start = await this.resolveNodeCenter(startBackendNodeId);
    const end = await this.resolveNodeCenter(endBackendNodeId);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: start.x,
      y: start.y,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: end.x, y: end.y });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: end.x,
      y: end.y,
      button: 'left',
      clickCount: 1,
    });
  }

  async getFrameTree(): Promise<FrameInfo[]> {
    await this.send('Page.enable');
    const result = await this.send('Page.getFrameTree');
    const frames: FrameInfo[] = [];
    flattenFrameTree(result['frameTree'] as CdpFrameTreeNode, frames);
    return frames;
  }

  async getAccessibilityTree(): Promise<AccessibilityNode> {
    const rawResult = await this.evaluate(INJECTED_ARIA_SNAPSHOT_SCRIPT, {
      awaitPromise: false,
      returnByValue: true,
    });
    if (!rawResult || typeof rawResult !== 'object') return { role: 'RootWebArea', name: '' };

    const tree = normalizeInjectedTree(rawResult as CdpPayload);

    try {
      const axResult = await this.send('Accessibility.getFullAXTree');
      const nodes = axResult['nodes'] as Array<CdpPayload> | undefined;
      if (Array.isArray(nodes)) annotateTreeWithBackendNodeIds(tree, buildAxNodeIndex(nodes));
    } catch {}

    return tree;
  }

  async getAccessibilityTreeForFrame(frameId?: string): Promise<AccessibilityNode> {
    if (!frameId) return this.getAccessibilityTree();
    const rawResult = await this.evaluateInFrame(frameId, INJECTED_ARIA_SNAPSHOT_SCRIPT, {
      awaitPromise: false,
      returnByValue: true,
    });
    if (!rawResult || typeof rawResult !== 'object') return { role: 'RootWebArea', name: '' };
    return normalizeInjectedTree(rawResult as CdpPayload);
  }

  private async clickAt(x: number, y: number, modifiers: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
      modifiers,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
      modifiers,
    });
  }

  private async resolveNodeObjectId(backendNodeId: number): Promise<string> {
    await this.send('DOM.enable');
    await this.send('Runtime.enable');
    const resolveResult = await this.send('DOM.resolveNode', { backendNodeId });
    const object = resolveResult['object'] as { objectId?: string } | undefined;
    if (!object?.objectId) {
      throw new Error(`Could not resolve backend node ${backendNodeId} to a DOM element`);
    }
    return object.objectId;
  }

  private async nodeBox(objectId: string): Promise<BoundingBox | undefined> {
    const boxResult = await this.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
          this.scrollIntoView({ block: 'center', inline: 'center' });
          const r = this.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }`,
      returnByValue: true,
    });
    return (boxResult['result'] as { value?: BoundingBox })?.value;
  }

  private async resolveNodeCenter(backendNodeId: number): Promise<{ x: number; y: number }> {
    const objectId = await this.resolveNodeObjectId(backendNodeId);
    const box = await this.nodeBox(objectId);
    if (!box || box.width === 0 || box.height === 0) {
      throw new Error(`Element with backend node ${backendNodeId} has no dimensions`);
    }
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  private async boundingBox(selector: string): Promise<BoundingBox | null> {
    await this.send('DOM.enable');
    const docResult = await this.send('DOM.getDocument', { depth: 0 });
    const rootNodeId = (docResult['root'] as { nodeId: number }).nodeId;

    let nodeId: number;
    try {
      const queryResult = await this.send('DOM.querySelector', { nodeId: rootNodeId, selector });
      nodeId = queryResult['nodeId'] as number;
    } catch {
      return null;
    }
    if (!nodeId) return null;

    const boxModel = await this.send('DOM.getBoxModel', { nodeId });
    const model = boxModel['model'] as { content: number[]; width: number; height: number };
    if (!model) return null;

    const quad = model.content;
    return { x: quad[0], y: quad[1], width: model.width, height: model.height };
  }
}

interface CdpFrameTreeNode {
  frame: { id: string; parentId?: string; url: string; name?: string; securityOrigin?: string };
  childFrames?: unknown[];
}

function flattenFrameTree(node: CdpFrameTreeNode, out: FrameInfo[]): void {
  out.push({
    frameId: node.frame.id,
    parentFrameId: node.frame.parentId,
    url: node.frame.url,
    name: node.frame.name ?? '',
    securityOrigin: node.frame.securityOrigin,
  });
  if (!Array.isArray(node.childFrames)) return;
  for (const child of node.childFrames) flattenFrameTree(child as CdpFrameTreeNode, out);
}

function evaluationFailure(result: CdpPayload): string | null {
  const details = result['exceptionDetails'] as
    | { text: string; exception?: { description?: string } }
    | undefined;
  if (!details) return null;
  return details.exception?.description ?? details.text;
}

function readEvaluateResult(result: CdpPayload, label: string): unknown {
  const failure = evaluationFailure(result);
  if (failure !== null) throw new Error(`${label}: ${failure}`);
  return (result['result'] as { value?: unknown })?.value;
}

function isDestroyedContextError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('Cannot find context with specified id') ||
    message.includes('Execution context was destroyed')
  );
}

function buildAxNodeIndex(nodes: Array<CdpPayload>): Map<string, number> {
  const index = new Map<string, number>();
  for (const n of nodes) {
    const backendNodeId = typeof n['backendDOMNodeId'] === 'number' ? n['backendDOMNodeId'] : null;
    if (backendNodeId === null) continue;
    const roleObj = n['role'] as CdpPayload | undefined;
    const nameObj = n['name'] as CdpPayload | undefined;
    const role = typeof roleObj?.['value'] === 'string' ? roleObj['value'].toLowerCase() : '';
    const name = typeof nameObj?.['value'] === 'string' ? nameObj['value'] : '';
    if (!role) continue;
    const key = `${role}|${name}`;
    if (!index.has(key)) index.set(key, backendNodeId);
  }
  return index;
}

function annotateTreeWithBackendNodeIds(node: AccessibilityNode, index: Map<string, number>): void {
  const key = `${node.role.toLowerCase()}|${node.name}`;
  const id = index.get(key);
  if (id !== undefined) node.backendNodeId = id;
  if (node.children) {
    for (const child of node.children) annotateTreeWithBackendNodeIds(child, index);
  }
}

function normalizeInjectedTree(raw: CdpPayload): AccessibilityNode {
  const role = normalizeAccessibilityText(raw.role, 'unknown');
  const name = normalizeAccessibilityText(raw.name);

  const node: AccessibilityNode = { role, name };

  const value = normalizeAccessibilityText(raw.value);
  if (value !== '') node.value = value;

  const description = normalizeAccessibilityText(raw.description);
  if (description !== '') node.description = description;

  if (Array.isArray(raw.children) && raw.children.length > 0) {
    node.children = (raw.children as CdpPayload[])
      .map((child) => normalizeInjectedTree(child))
      .filter((c) => c.role !== 'unknown');
  }

  return node;
}
