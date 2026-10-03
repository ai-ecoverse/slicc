import { CherryUnsupportedError } from './cdp-errors.js';

export { CherryUnsupportedError };

export interface CdpHostHandlerOptions {
  capabilities: { navigate: boolean; screenshot: 'html2canvas' | 'none'; openUrl: boolean };
  onOpenUrl?: (url: string) => void;
}

// biome-ignore lint/plugin: CDP params/result are per-method and open-ended; Cherry relays them without validating the full CDP schema, so there is no narrower shape to name here.
export type CdpPayload = Record<string, unknown>;

export type RemoteObject =
  | { type: 'object'; subtype: 'null'; value: null }
  | { type: 'undefined' }
  | { type: 'number' | 'boolean' | 'string'; value: number | boolean | string }
  | { type: 'object'; subtype: 'error' }
  | { type: 'object'; description: string };

type Handler = (method: string, params: CdpPayload) => Promise<CdpPayload>;

type MethodHandler = (params: CdpPayload) => Promise<CdpPayload>;

function toRemoteObject(value: unknown): RemoteObject {
  if (value === null) return { type: 'object', subtype: 'null', value: null };
  if (typeof value === 'undefined') return { type: 'undefined' };
  if (typeof value === 'number') return { type: 'number', value };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value === 'string') return { type: 'string', value };
  return { type: 'object', description: String(value) };
}

function createNodeIdMaps(): {
  idFor: (node: Node) => number;
  nodesById: Map<number, Node>;
} {
  const nodeIds = new WeakMap<Node, number>();

  const nodesById = new Map<number, Node>();
  let nextNodeId = 1;

  const idFor = (node: Node): number => {
    let id = nodeIds.get(node);
    if (id === undefined) {
      id = nextNodeId++;
      nodeIds.set(node, id);
      nodesById.set(id, node);
    }
    return id;
  };

  return { idFor, nodesById };
}

async function handleRuntimeEvaluate(
  params: CdpPayload,
  evalInRealm: (src: string) => unknown
): Promise<CdpPayload> {
  const expression = String(params.expression ?? '');
  try {
    const value = evalInRealm(expression);
    const resolved = value instanceof Promise ? await value : value;
    return { result: toRemoteObject(resolved) };
  } catch (err) {
    return {
      result: { type: 'object', subtype: 'error' },
      exceptionDetails: {
        text: err instanceof Error ? err.message : String(err),
        exception: { type: 'object', description: String(err) },
      },
    };
  }
}

function handleDomQuerySelector(
  params: CdpPayload,
  nodesById: Map<number, Node>,
  idFor: (node: Node) => number
): CdpPayload {
  const root = nodesById.get(Number(params.nodeId)) ?? document;
  const sel = String(params.selector ?? '');
  const el = (root as ParentNode).querySelector?.(sel) ?? null;
  return { nodeId: el ? idFor(el) : 0 };
}

function handleDomGetBoxModel(params: CdpPayload, nodesById: Map<number, Node>): CdpPayload {
  const node = nodesById.get(Number(params.nodeId));
  const el = node as Element | undefined;
  const r = el?.getBoundingClientRect?.();
  if (!r) throw new CherryUnsupportedError('DOM.getBoxModel(no-rect)');
  const quad = [r.left, r.top, r.right, r.top, r.right, r.bottom, r.left, r.bottom];
  return { model: { content: quad, width: r.width, height: r.height } };
}

function handleDispatchMouseEvent(params: CdpPayload): CdpPayload {
  const x = Number(params.x ?? 0);
  const y = Number(params.y ?? 0);
  const target = document.elementFromPoint(x, y);
  if (target && params.type === 'mousePressed') {
    (target as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y })
    );
  }
  return {};
}

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numericParam(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function keyCodeFromParams(params: CdpPayload): number {
  const vk =
    numericParam(params.windowsVirtualKeyCode) ?? numericParam(params.nativeVirtualKeyCode);
  if (vk !== undefined) return vk;
  const key = stringParam(params.key);
  const text = stringParam(params.text);
  if (key === 'Enter' || text === '\r') return 13;
  if (key && key.length === 1) return key.charCodeAt(0);
  return 0;
}

function keypressCharCode(params: CdpPayload, keyCode: number): number {
  const text = stringParam(params.text);
  if (text !== undefined && text !== '') return text.charCodeAt(0);
  return keyCode;
}

function createSyntheticKeyboardEvent(
  type: 'keydown' | 'keyup' | 'keypress',
  params: CdpPayload
): KeyboardEvent {
  const key = stringParam(params.key) ?? '';
  const code = stringParam(params.code) ?? key;
  const keyCode = keyCodeFromParams(params);
  const charCode = type === 'keypress' ? keypressCharCode(params, keyCode) : 0;
  const event = new KeyboardEvent(type, {
    key,
    code,
    bubbles: true,
    cancelable: true,
    composed: true,
  });

  Object.defineProperties(event, {
    keyCode: { configurable: true, enumerable: true, get: () => keyCode },
    which: { configurable: true, enumerable: true, get: () => keyCode },
    charCode: { configurable: true, enumerable: true, get: () => charCode },
  });
  return event;
}

function dispatchSyntheticKey(
  target: EventTarget,
  type: 'keydown' | 'keyup' | 'keypress',
  params: CdpPayload
): boolean {
  return target.dispatchEvent(createSyntheticKeyboardEvent(type, params));
}

const IMPLICIT_SUBMIT_INPUT_TYPES = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'date',
  'month',
  'week',
  'time',
  'datetime-local',
  'number',
]);

function isSubmitButton(el: EventTarget): el is HTMLButtonElement | HTMLInputElement {
  if (el instanceof HTMLButtonElement) return el.type === 'submit';
  if (el instanceof HTMLInputElement) return el.type === 'submit' || el.type === 'image';
  return false;
}

function defaultSubmitter(form: HTMLFormElement): HTMLButtonElement | HTMLInputElement | undefined {
  for (const el of form.elements) {
    if (isSubmitButton(el) && !el.disabled) return el;
  }
  return undefined;
}

function maybeImplicitSubmit(target: EventTarget): void {
  if (isSubmitButton(target)) {
    target.click();
    return;
  }
  if (!(target instanceof HTMLInputElement) || !IMPLICIT_SUBMIT_INPUT_TYPES.has(target.type)) {
    return;
  }
  const form = target.form;
  if (!form) return;
  const submitter = defaultSubmitter(form);
  if (typeof form.requestSubmit === 'function') {
    if (submitter) form.requestSubmit(submitter);
    else form.requestSubmit();
    return;
  }
  if (submitter) {
    submitter.click();
    return;
  }
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function handleDispatchKeyEvent(params: CdpPayload): CdpPayload {
  const active = (document.activeElement as HTMLElement | null) ?? document.body;
  if (!active) return {};

  const type = stringParam(params.type) ?? '';
  const isDown = type === 'keyDown' || type === 'rawKeyDown';
  const isUp = type === 'keyUp';
  const isChar = type === 'char';
  if (!isDown && !isUp && !isChar) return {};

  const key = stringParam(params.key) ?? '';
  const text = stringParam(params.text);
  const isEnter = key === 'Enter' || text === '\r' || keyCodeFromParams(params) === 13;

  if (isChar) {
    dispatchSyntheticKey(active, 'keypress', params);
    return {};
  }

  if (isUp) {
    dispatchSyntheticKey(active, 'keyup', params);
    return {};
  }

  const downAllowed = dispatchSyntheticKey(active, 'keydown', params);
  let pressAllowed = true;
  if (downAllowed && text !== undefined && text !== '') {
    pressAllowed = dispatchSyntheticKey(active, 'keypress', params);
  }
  if (downAllowed && pressAllowed && isEnter) {
    maybeImplicitSubmit(active);
  }
  return {};
}

async function handleCaptureScreenshot(
  capabilities: CdpHostHandlerOptions['capabilities']
): Promise<CdpPayload> {
  if (capabilities.screenshot !== 'html2canvas') {
    throw new CherryUnsupportedError('Page.captureScreenshot');
  }

  const { default: html2canvas } = await import('html2canvas-pro');
  const canvas = await html2canvas(document.body);
  const data = canvas.toDataURL('image/png').split(',')[1] ?? '';
  return { data };
}

function handlePageNavigate(
  params: CdpPayload,
  capabilities: CdpHostHandlerOptions['capabilities']
): CdpPayload {
  if (!capabilities.navigate) throw new CherryUnsupportedError('Page.navigate');
  const url = String(params.url ?? '');
  location.assign(url);
  return { frameId: 'cherry-frame', loaderId: 'cherry-loader' };
}

function handleCreateTarget(params: CdpPayload, opts: CdpHostHandlerOptions): CdpPayload {
  if (!opts.capabilities.openUrl) throw new CherryUnsupportedError('Target.createTarget');
  const url = String(params.url ?? '');
  opts.onOpenUrl?.(url);
  return { targetId: 'cherry-opened' };
}

export function createCdpHostHandler(opts: CdpHostHandlerOptions): Handler {
  const { idFor, nodesById } = createNodeIdMaps();

  // biome-ignore lint/security/noGlobalEval: intentional indirect eval — runs in the host page's global scope and is governed entirely by the host's own CSP (see comment above).
  const indirectEval: typeof eval = eval;
  const evalInRealm = indirectEval as (src: string) => unknown;

  const methods: { [method: string]: MethodHandler } = {
    'Runtime.evaluate': (params) => handleRuntimeEvaluate(params, evalInRealm),
    'DOM.getDocument': async () => ({
      root: { nodeId: idFor(document), nodeName: '#document', childNodeCount: 1 },
    }),
    'DOM.querySelector': async (params) => handleDomQuerySelector(params, nodesById, idFor),
    'DOM.getBoxModel': async (params) => handleDomGetBoxModel(params, nodesById),
    'Input.dispatchMouseEvent': async (params) => handleDispatchMouseEvent(params),
    'Input.dispatchKeyEvent': async (params) => handleDispatchKeyEvent(params),
    'Page.captureScreenshot': async () => handleCaptureScreenshot(opts.capabilities),
    'Page.navigate': async (params) => handlePageNavigate(params, opts.capabilities),
    'Target.createTarget': async (params) => handleCreateTarget(params, opts),
  };

  return async function handle(method, params) {
    const runner = Object.hasOwn(methods, method) ? methods[method] : undefined;
    if (!runner) throw new CherryUnsupportedError(method);
    return runner(params);
  };
}
