export class CherryUnsupportedError extends Error {
  readonly code = -32601;
  constructor(method: string) {
    super(`Cherry: unsupported CDP method '${method}'`);
    this.name = 'CherryUnsupportedError';
  }
}

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

function handleDispatchKeyEvent(params: CdpPayload): CdpPayload {
  const active = document.activeElement as HTMLElement | null;
  if (active && params.type === 'keyDown' && typeof params.key === 'string') {
    active.dispatchEvent(new KeyboardEvent('keydown', { key: params.key, bubbles: true }));
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
