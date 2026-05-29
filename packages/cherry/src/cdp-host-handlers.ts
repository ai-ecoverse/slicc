/**
 * Host-realm execution of the synthetic CDP subset Cherry supports.
 * Runs on the third-party host page inside @slicc/cherry.
 */

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

type Handler = (
  method: string,
  params: Record<string, unknown>
) => Promise<Record<string, unknown>>;

export function createCdpHostHandler(opts: CdpHostHandlerOptions): Handler {
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

  const toRemoteObject = (value: unknown): Record<string, unknown> => {
    const type = typeof value;
    if (value === null) return { type: 'object', subtype: 'null', value: null };
    if (type === 'undefined') return { type: 'undefined' };
    if (type === 'number' || type === 'boolean' || type === 'string') {
      return { type, value };
    }
    return { type: 'object', description: String(value) };
  };

  // Host-CSP-governs-eval invariant: we delegate to the page realm's own
  // evaluator via indirect eval. Aliasing `eval` to a variable and calling
  // through that alias is an *indirect* eval — it runs in global scope, not a
  // direct call site — so it is governed entirely by the host page's CSP. If
  // the host CSP forbids dynamic eval, this throws natively and we surface it
  // as exceptionDetails — Cherry adds no escape hatch of its own.
  const indirectEval: typeof eval = eval;
  const evalInRealm = indirectEval as (src: string) => unknown;

  return async function handle(method, params) {
    switch (method) {
      case 'Runtime.evaluate': {
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
      case 'DOM.getDocument': {
        return { root: { nodeId: idFor(document), nodeName: '#document', childNodeCount: 1 } };
      }
      case 'DOM.querySelector': {
        const root = nodesById.get(Number(params.nodeId)) ?? document;
        const sel = String(params.selector ?? '');
        const el = (root as ParentNode).querySelector?.(sel) ?? null;
        return { nodeId: el ? idFor(el) : 0 };
      }
      case 'DOM.getBoxModel': {
        const node = nodesById.get(Number(params.nodeId));
        const el = node as Element | undefined;
        const r = el?.getBoundingClientRect?.();
        if (!r) throw new CherryUnsupportedError('DOM.getBoxModel(no-rect)');
        const quad = [r.left, r.top, r.right, r.top, r.right, r.bottom, r.left, r.bottom];
        return { model: { content: quad, width: r.width, height: r.height } };
      }
      case 'Input.dispatchMouseEvent': {
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
      case 'Input.dispatchKeyEvent': {
        const active = document.activeElement as HTMLElement | null;
        if (active && params.type === 'keyDown' && typeof params.key === 'string') {
          active.dispatchEvent(new KeyboardEvent('keydown', { key: params.key, bubbles: true }));
        }
        return {};
      }
      case 'Page.captureScreenshot': {
        if (opts.capabilities.screenshot !== 'html2canvas') {
          throw new CherryUnsupportedError('Page.captureScreenshot');
        }
        const { default: html2canvas } = await import('html2canvas');
        const canvas = await html2canvas(document.body);
        const data = canvas.toDataURL('image/png').split(',')[1] ?? '';
        return { data };
      }
      case 'Page.navigate': {
        if (!opts.capabilities.navigate) throw new CherryUnsupportedError('Page.navigate');
        const url = String(params.url ?? '');
        location.assign(url);
        return { frameId: 'cherry-frame', loaderId: 'cherry-loader' };
      }
      case 'Target.createTarget': {
        if (!opts.capabilities.openUrl) throw new CherryUnsupportedError('Target.createTarget');
        const url = String(params.url ?? '');
        opts.onOpenUrl?.(url);
        return { targetId: 'cherry-opened' };
      }
      default:
        throw new CherryUnsupportedError(method);
    }
  };
}
