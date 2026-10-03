/**
 * Host-realm execution of the synthetic CDP subset Cherry supports.
 * Runs on the third-party host page inside @ai-ecoverse/cherry.
 */

import { CherryUnsupportedError } from './cdp-errors.js';

export { CherryUnsupportedError };

export interface CdpHostHandlerOptions {
  capabilities: { navigate: boolean; screenshot: 'html2canvas' | 'none'; openUrl: boolean };
  onOpenUrl?: (url: string) => void;
}

/**
 * Open-ended CDP method params / results. Per-method shapes are probed at the
 * call site; Cherry does not validate the full CDP schema.
 */
// biome-ignore lint/plugin: CDP params/result are per-method and open-ended; Cherry relays them without validating the full CDP schema, so there is no narrower shape to name here.
export type CdpPayload = Record<string, unknown>;

/** CDP Runtime.RemoteObject-shaped value returned by Runtime.evaluate. */
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
  // Strong node ref by id: unbounded by design for the session lifetime. A very
  // long-lived host session pins every queried node; acceptable for typical
  // short embed sessions. A prune/LRU is a future option if sessions grow long.
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

/**
 * DOM `keyCode`/`which` for a CDP key payload. Blink ignores a bare
 * `{ key: 'Enter' }` (keyCode stays 0) and never implicit-submits; #3768
 * leaders send `windowsVirtualKeyCode: 13` + `text: '\r'`.
 */
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
  // Blink/WebKit ignore `keyCode`/`which` in KeyboardEventInit; host pages
  // that still gate on `e.keyCode === 13` need the legacy fields patched.
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

/** Input types that implicit-submit a form on Enter (HTML spec, minus textarea). */
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
  // Use the maintained `html2canvas-pro` fork (drop-in API): the original
  // `html2canvas@1.4.1` predates CSS Color 4 and throws on modern color
  // syntax ("unsupported color function 'color'") — common on real host
  // pages. The capability value stays `'html2canvas'` (the rasterization
  // strategy), only the implementation lib differs.
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

  // Host-CSP-governs-eval invariant: we delegate to the page realm's own
  // evaluator via indirect eval. Aliasing `eval` to a variable and calling
  // through that alias is an *indirect* eval — it runs in global scope, not a
  // direct call site — so it is governed entirely by the host page's CSP. If
  // the host CSP forbids dynamic eval, this throws natively and we surface it
  // as exceptionDetails — Cherry adds no escape hatch of its own.
  // biome-ignore lint/security/noGlobalEval: intentional indirect eval — runs in the host page's global scope and is governed entirely by the host's own CSP (see comment above).
  const indirectEval: typeof eval = eval;
  const evalInRealm = indirectEval as (src: string) => unknown;

  // Two-tier gating model (by design, not an oversight):
  //  - The `capabilities` booleans gate side effects that ESCAPE the page
  //    sandbox — navigate (top-level navigation), screenshot (screen capture),
  //    openUrl (new window/tab). These are checked here and fail closed.
  //  - DOM read/query and Input (clicking/typing WITHIN the embedded page) are
  //    the baseline driveable-CDP-target contract the host opted into by
  //    calling mountSlicc. Per-domain authorization (including denying the
  //    whole Input/DOM domain) is enforced UPSTREAM via onPermissionRequest at
  //    the mount layer, so we intentionally do not re-gate them here.
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
    // Own-property check only: the CDP protocol accepts arbitrary method
    // strings, so an unimplemented method matching an `Object.prototype` key
    // (`toString`, `constructor`, `__proto__`, …) must still fail closed with
    // CherryUnsupportedError/-32601 rather than resolve an inherited member.
    const runner = Object.hasOwn(methods, method) ? methods[method] : undefined;
    if (!runner) throw new CherryUnsupportedError(method);
    return runner(params);
  };
}
