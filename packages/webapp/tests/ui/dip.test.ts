// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DipInstance,
  disposeDips,
  extractShtmlBlocks,
  hydrateDips,
  mountDip,
  mountDraftDip,
  setDipExecHandler,
  splitContentSegments,
} from '../../src/ui/dip.js';

vi.mock('./sprinkle-renderer.js', () => ({
  collectThemeCSS: () => ':root { --s2-spacing-200: 12px; }',
}));

function installFakeSWController(): () => void {
  const original = (navigator as unknown as Record<string, unknown>).serviceWorker;
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { controller: { scriptURL: 'http://localhost/preview-sw.js' } },
  });
  return () => {
    if (original === undefined) {
      delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    } else {
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: original,
      });
    }
  };
}

describe('hydrateDips', () => {
  let container: HTMLElement;
  let restoreSW: (() => void) | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    restoreSW = installFakeSWController();
  });

  afterEach(() => {
    container.remove();
    restoreSW?.();
    restoreSW = null;
  });

  it('returns empty array when no shtml blocks present', () => {
    container.innerHTML = '<p>Hello world</p>';
    const instances = hydrateDips(container, vi.fn());
    expect(instances).toEqual([]);
  });

  it('finds and replaces code.language-shtml elements', () => {
    container.innerHTML =
      '<pre><code class="language-shtml">&lt;button onclick="slicc.lick(\'ok\')"&gt;OK&lt;/button&gt;</code></pre>';

    const onLick = vi.fn();
    const instances = hydrateDips(container, onLick);

    expect(instances).toHaveLength(1);

    expect(container.querySelector('pre')).toBeNull();
    const wrapper = container.querySelector('.msg__dip');
    expect(wrapper).not.toBeNull();

    const iframe = wrapper?.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');

    disposeDips(instances);
  });

  it('handles multiple shtml blocks in one container', () => {
    container.innerHTML =
      '<p>Text before</p>' +
      '<pre><code class="language-shtml">&lt;p&gt;Card 1&lt;/p&gt;</code></pre>' +
      '<p>Text between</p>' +
      '<pre><code class="language-shtml">&lt;p&gt;Card 2&lt;/p&gt;</code></pre>' +
      '<p>Text after</p>';

    const instances = hydrateDips(container, vi.fn());
    expect(instances).toHaveLength(2);

    const wrappers = container.querySelectorAll('.msg__dip');
    expect(wrappers).toHaveLength(2);

    expect(container.querySelectorAll('p')).toHaveLength(3);

    disposeDips(instances);
  });

  it('does not match non-shtml code blocks', () => {
    container.innerHTML = '<pre><code class="language-javascript">const x = 1;</code></pre>';

    const instances = hydrateDips(container, vi.fn());
    expect(instances).toEqual([]);

    expect(container.querySelector('code.language-javascript')).not.toBeNull();
  });

  it('returns a placeholder instance for img[src$=".shtml"] before the fetch resolves', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));

    container.innerHTML = '<img src="/shared/dips/welcome.shtml" alt="Welcome">';
    const instances = hydrateDips(container, vi.fn());

    expect(instances).toHaveLength(1);
    expect(typeof instances[0].dispose).toBe('function');

    expect(container.querySelector('img')).toBeNull();
    const wrapper = container.querySelector<HTMLElement>('.msg__dip');
    expect(wrapper?.getAttribute('title')).toBe('Welcome');

    const callArgs = fetchSpy.mock.calls[0];
    const init = callArgs[1] as RequestInit | undefined;
    const signal = init?.signal as AbortSignal | undefined;
    expect(signal?.aborted).toBe(false);
    instances[0].dispose();
    expect(signal?.aborted).toBe(true);

    fetchSpy.mockRestore();
  });

  it('does not call mountDip if the placeholder is disposed before fetch resolves', async () => {
    let resolveFetch!: (resp: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );

    container.innerHTML = '<img src="/shared/dips/welcome.shtml">';
    const instances = hydrateDips(container, vi.fn());
    expect(instances).toHaveLength(1);

    instances[0].dispose();

    resolveFetch(new Response('<p>too late</p>', { status: 200 }));
    await new Promise((r) => setTimeout(r, 0));

    expect(container.querySelector('iframe')).toBeNull();

    fetchSpy.mockRestore();
  });
});

describe('hydrateDips — carrying dips across re-renders', () => {
  const card = '<pre><code class="language-shtml">&lt;p&gt;Card&lt;/p&gt;</code></pre>';
  let root: HTMLElement;
  let restoreSW: (() => void) | null = null;

  const nativeMoveBefore = Object.getOwnPropertyDescriptor(Element.prototype, 'moveBefore');

  function render(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    root.prepend(host);
    return host;
  }

  function installMoveBefore(): void {
    Object.defineProperty(Element.prototype, 'moveBefore', {
      configurable: true,
      value(this: Element, node: Node, child: Node | null) {
        this.insertBefore(node, child);
      },
    });
  }

  beforeEach(() => {
    Reflect.deleteProperty(Element.prototype, 'moveBefore');
    root = document.createElement('div');
    document.body.appendChild(root);
    restoreSW = installFakeSWController();
  });

  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, 'moveBefore');
    if (nativeMoveBefore) Object.defineProperty(Element.prototype, 'moveBefore', nativeMoveBefore);
    root.remove();
    restoreSW?.();
    restoreSW = null;
  });

  it('moves an unchanged dip into the new render instead of remounting it', () => {
    installMoveBefore();
    const first = render(card);
    const previous = hydrateDips(first, vi.fn());
    const iframe = first.querySelector('iframe');

    const second = render(`<p>more text</p>${card}`);
    const next = hydrateDips(second, vi.fn(), { previous, streaming: true });
    first.remove();

    expect(next).toEqual(previous);
    expect(second.querySelector('iframe')).toBe(iframe);
    expect(second.querySelector('pre')).toBeNull();
  });

  it('remounts a dip whose source changed and disposes the old one', () => {
    installMoveBefore();
    const first = render(card);
    const previous = hydrateDips(first, vi.fn());
    const dispose = vi.spyOn(previous[0]!, 'dispose');

    const second = render(
      '<pre><code class="language-shtml">&lt;p&gt;Other&lt;/p&gt;</code></pre>'
    );
    const next = hydrateDips(second, vi.fn(), { previous });

    expect(next).toHaveLength(1);
    expect(next[0]).not.toBe(previous[0]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(second.querySelector('iframe')).not.toBeNull();
  });

  it('carries repeated identical dips in document order', () => {
    installMoveBefore();
    const first = render(card + card);
    const previous = hydrateDips(first, vi.fn());
    const iframes = [...first.querySelectorAll('iframe')];

    const second = render(card + card);
    const next = hydrateDips(second, vi.fn(), { previous });

    expect(next).toEqual(previous);
    expect([...second.querySelectorAll('iframe')]).toEqual(iframes);
  });

  it('keeps an image dip across renders without fetching it again', () => {
    installMoveBefore();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    const img = '<img src="/shared/dips/welcome.shtml">';
    const previous = hydrateDips(render(img), vi.fn());
    const second = render(img);
    const next = hydrateDips(second, vi.fn(), { previous });
    try {
      expect(next).toEqual(previous);
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(second.querySelector('img')).toBeNull();
    } finally {
      disposeDips([...previous, ...next]);
      fetchSpy.mockRestore();
    }
  });

  it('shows the pending card mid-stream when the browser cannot move iframes intact', () => {
    const host = render(card);
    const instances = hydrateDips(host, vi.fn(), { streaming: true });

    expect(instances).toEqual([]);
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.querySelector('.msg__dip-pending')).not.toBeNull();
  });

  it('remounts on the final render when the browser cannot move iframes intact', () => {
    const first = render(card);
    const previous = hydrateDips(first, vi.fn());
    const dispose = vi.spyOn(previous[0]!, 'dispose');

    const second = render(card);
    const next = hydrateDips(second, vi.fn(), { previous });

    expect(next[0]).not.toBe(previous[0]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(second.querySelector('iframe')).not.toBeNull();
  });
});

describe('hydrateDips — preview-vfs bridge fallback for uncontrolled boots', () => {
  let container: HTMLElement;
  let responderChannel: BroadcastChannel | null = null;
  let responderListener: ((ev: MessageEvent) => void) | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { controller: null },
    });
  });

  afterEach(() => {
    container.remove();
    if (responderListener && responderChannel) {
      responderChannel.removeEventListener('message', responderListener);
    }
    responderChannel?.close();
    responderChannel = null;
    responderListener = null;
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  });

  it('reads .shtml content via the preview-vfs BroadcastChannel bridge when SW is not controlling, bypassing fetch entirely', async () => {
    const shtml = '<button onclick="slicc.lick(\'go\')">Go</button>';
    const files = new Map<string, string>([['/shared/sprinkles/welcome/welcome.shtml', shtml]]);
    responderChannel = new BroadcastChannel('preview-vfs');
    responderListener = (ev: MessageEvent) => {
      const data = ev.data as
        | { type: string; id: string; path: string; asText: boolean }
        | undefined;
      if (data?.type !== 'preview-vfs-read') return;
      const content = files.get(data.path);
      if (content === undefined) {
        responderChannel?.postMessage({
          type: 'preview-vfs-response',
          id: data.id,
          error: `ENOENT: ${data.path}`,
        });
        return;
      }
      responderChannel?.postMessage({
        type: 'preview-vfs-response',
        id: data.id,
        content,
      });
    };
    responderChannel.addEventListener('message', responderListener);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.reject(new Error('fetch should not be called')));

    container.innerHTML = '<img src="/shared/sprinkles/welcome/welcome.shtml" alt="Welcome">';
    const instances = hydrateDips(container, vi.fn());
    expect(instances).toHaveLength(1);

    const wrapper = container.querySelector<HTMLElement>('.msg__dip')!;
    let iframe: HTMLIFrameElement | null = null;
    for (let i = 0; i < 100; i++) {
      iframe = wrapper.querySelector('iframe');
      if (iframe || wrapper.textContent?.includes('Failed to load dip')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(wrapper.textContent).not.toContain('Failed to load dip');
    expect(iframe).not.toBeNull();

    expect(fetchSpy).not.toHaveBeenCalled();

    disposeDips(instances);
    fetchSpy.mockRestore();
  });
});

describe('disposeDips', () => {
  it('calls dispose on each instance and clears the array', () => {
    const disposeFn1 = vi.fn();
    const disposeFn2 = vi.fn();
    const instances: DipInstance[] = [{ dispose: disposeFn1 }, { dispose: disposeFn2 }];
    disposeDips(instances);
    expect(disposeFn1).toHaveBeenCalledOnce();
    expect(disposeFn2).toHaveBeenCalledOnce();
    expect(instances).toHaveLength(0);
  });
});

describe('extractShtmlBlocks', () => {
  it('returns an empty array when there are no shtml fences', () => {
    expect(extractShtmlBlocks('just prose, no fences')).toEqual([]);
  });

  it('captures a single closed shtml block', () => {
    const out = extractShtmlBlocks('Sure:\n\n```shtml\n<div>x</div>\n```\n');
    expect(out).toEqual(['<div>x</div>']);
  });

  it('captures the trailing unclosed block while streaming', () => {
    const out = extractShtmlBlocks('Sure:\n\n```shtml\n<div>partial');
    expect(out).toEqual(['<div>partial']);
  });

  it('captures multiple blocks in order', () => {
    const out = extractShtmlBlocks(
      '```shtml\n<div>a</div>\n```\n\nand\n\n```shtml\n<div>b</div>\n```'
    );
    expect(out).toEqual(['<div>a</div>', '<div>b</div>']);
  });

  it('captures an empty open block (just the language identifier typed)', () => {
    expect(extractShtmlBlocks('```shtml\n')).toEqual(['']);
  });

  it('ignores fenced code blocks of other languages', () => {
    expect(extractShtmlBlocks('```js\nconst x = 1;\n```')).toEqual([]);
  });
});

describe('splitContentSegments', () => {
  it('returns a single prose segment for plain text', () => {
    expect(splitContentSegments('Hello world')).toEqual([{ kind: 'prose', text: 'Hello world' }]);
  });

  it('emits prose + open shtml for a streaming-in-progress block', () => {
    expect(splitContentSegments('Sure:\n\n```shtml\n<div>partial')).toEqual([
      { kind: 'prose', text: 'Sure:\n\n' },
      { kind: 'shtml', body: '<div>partial', closed: false },
    ]);
  });

  it('emits a closed shtml segment when the closing fence has arrived', () => {
    expect(splitContentSegments('```shtml\n<div>x</div>\n```')).toEqual([
      { kind: 'shtml', body: '<div>x</div>', closed: true },
    ]);
  });

  it('emits prose between two closed shtml blocks', () => {
    const segs = splitContentSegments('```shtml\n<a/>\n```\n\nbetween\n\n```shtml\n<b/>\n```');
    expect(segs).toEqual([
      { kind: 'shtml', body: '<a/>', closed: true },
      { kind: 'prose', text: '\n\nbetween\n\n' },
      { kind: 'shtml', body: '<b/>', closed: true },
    ]);
  });

  it('emits trailing prose after a closed shtml block', () => {
    const segs = splitContentSegments('```shtml\n<x/>\n```\n\nDone.');
    expect(segs).toEqual([
      { kind: 'shtml', body: '<x/>', closed: true },
      { kind: 'prose', text: '\n\nDone.' },
    ]);
  });

  it('handles an empty open block (just the language identifier typed)', () => {
    expect(splitContentSegments('```shtml\n')).toEqual([
      { kind: 'shtml', body: '', closed: false },
    ]);
  });

  it('does not split on non-shtml fenced code blocks', () => {
    const segs = splitContentSegments('```js\nconst x = 1;\n```');
    expect(segs).toHaveLength(1);
    expect(segs[0]?.kind).toBe('prose');
  });
});

describe('mountDraftDip', () => {
  it('returns an instance with a detached iframe element in CLI mode', () => {
    const draft = mountDraftDip(vi.fn());
    expect(draft.element.tagName).toBe('IFRAME');
    expect(draft.element.parentElement).toBeNull();
    expect(typeof draft.update).toBe('function');
    expect(typeof draft.dispose).toBe('function');
    draft.dispose();
  });

  it('disables pointer events on the iframe so partial UI is not clickable', () => {
    const draft = mountDraftDip(vi.fn());
    expect(draft.element.style.pointerEvents).toBe('none');
    draft.dispose();
  });

  it('queues the first update before iframe load and posts after', async () => {
    const draft = mountDraftDip(vi.fn());
    const iframe = draft.element;
    document.body.appendChild(iframe);

    const postSpy = vi.fn();
    Object.defineProperty(iframe.contentWindow, 'postMessage', {
      configurable: true,
      value: postSpy,
    });

    draft.update('<div>hi</div>');
    expect(postSpy).not.toHaveBeenCalled();

    iframe.dispatchEvent(new Event('load'));
    expect(postSpy).toHaveBeenCalledWith(
      { type: 'dip-draft-update', content: '<div>hi</div>' },
      '*'
    );

    draft.dispose();
    iframe.remove();
  });

  it('skips redundant updates with identical content', async () => {
    const draft = mountDraftDip(vi.fn());
    const iframe = draft.element;
    document.body.appendChild(iframe);
    const postSpy = vi.fn();
    Object.defineProperty(iframe.contentWindow, 'postMessage', {
      configurable: true,
      value: postSpy,
    });

    iframe.dispatchEvent(new Event('load'));

    postSpy.mockClear();

    draft.update('<div>same</div>');
    draft.update('<div>same</div>');
    draft.update('<div>same</div>');
    expect(postSpy).toHaveBeenCalledTimes(1);

    draft.update('<div>changed</div>');
    expect(postSpy).toHaveBeenCalledTimes(2);

    draft.dispose();
    iframe.remove();
  });

  it('removes the iframe and detaches its message listener on dispose', () => {
    const draft = mountDraftDip(vi.fn());
    const iframe = draft.element;
    document.body.appendChild(iframe);
    expect(iframe.isConnected).toBe(true);
    draft.dispose();
    expect(iframe.isConnected).toBe(false);
  });
});

describe('stacked action-card spacing', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('guards programmatic focus before the authored content runs', () => {
    mountDip(container, '<input autofocus id="dip-field">', vi.fn());
    const srcdoc = container.querySelector('iframe')!.srcdoc;
    expect(srcdoc).toContain('_focusAllowed');
    expect(srcdoc.indexOf('_focusAllowed')).toBeLessThan(srcdoc.indexOf('id="dip-field"'));
  });

  it('host sheet gaps adjacent action cards without margining the single-card case', () => {
    const inst = mountDip(container, '<div class="sprinkle-action-card">x</div>', vi.fn());
    const iframe = container.querySelector('iframe')!;
    const srcdoc = iframe.srcdoc;

    expect(srcdoc).toContain('.sprinkle-inline .sprinkle-action-card{margin:0;width:100%}');

    expect(srcdoc).toContain(
      '.sprinkle-inline .sprinkle-action-card + .sprinkle-action-card{margin-top:12px}'
    );
    inst.dispose();
  });
});

describe('dip exec/agent trust gating', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();

    setDipExecHandler(undefined);
  });

  function postFromDip(iframe: HTMLIFrameElement, data: Record<string, unknown>): void {
    window.dispatchEvent(
      new MessageEvent('message', { source: iframe.contentWindow as Window, data })
    );
  }

  it('untrusted dips do NOT expose exec/agent/jsh in the bridge', () => {
    const inst = mountDip(container, '<button>x</button>', vi.fn(), false);
    const iframe = container.querySelector('iframe')!;
    expect(iframe.srcdoc).not.toContain('agent: function');
    expect(iframe.srcdoc).not.toContain('dip-exec');
    expect(iframe.srcdoc).not.toContain('dip-jsh');
    inst.dispose();
  });

  it('trusted dips DO expose exec/agent + the Tier 1 jsh globals in the bridge', () => {
    const inst = mountDip(container, '<button>x</button>', vi.fn(), true);
    const iframe = container.querySelector('iframe')!;
    expect(iframe.srcdoc).toContain('exec: Object.assign(function');
    expect(iframe.srcdoc).toContain('agent: function');

    expect(iframe.srcdoc).toContain('dip-jsh');
    expect(iframe.srcdoc).toContain("op: 'fetch'");
    expect(iframe.srcdoc).toContain("op: 'browser'");
    inst.dispose();
  });

  it('routes a trusted dip dip-exec request to the registered handler', async () => {
    const handler = vi.fn().mockResolvedValue({ stdout: 'out', stderr: '', exitCode: 0 });
    setDipExecHandler(handler);
    const inst = mountDip(container, '<button>x</button>', vi.fn(), true);
    const iframe = container.querySelector('iframe')!;
    const postSpy = vi.fn();
    Object.defineProperty(iframe.contentWindow!, 'postMessage', {
      configurable: true,
      value: postSpy,
    });

    postFromDip(iframe, { type: 'dip-exec', id: 7, cmd: 'echo hi' });
    await new Promise((r) => setTimeout(r, 0));

    expect(handler).toHaveBeenCalledWith('echo hi');
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'dip-exec-response',
        id: 7,
        result: { stdout: 'out', stderr: '', exitCode: 0 },
      }),
      '*'
    );
    inst.dispose();
  });

  it('builds the agent command from prompt + opts and folds stderr into stdout', async () => {
    const handler = vi.fn().mockResolvedValue({ stdout: 'done', stderr: '', exitCode: 0 });
    setDipExecHandler(handler);
    const inst = mountDip(container, '<button>x</button>', vi.fn(), true);
    const iframe = container.querySelector('iframe')!;
    const postSpy = vi.fn();
    Object.defineProperty(iframe.contentWindow!, 'postMessage', {
      configurable: true,
      value: postSpy,
    });

    postFromDip(iframe, {
      type: 'dip-agent',
      id: 9,
      prompt: 'hello',
      opts: { model: 'claude-opus-4-6' },
    });
    await new Promise((r) => setTimeout(r, 0));

    const cmd = handler.mock.calls[0]?.[0] as string;
    expect(cmd).toContain('agent');
    expect(cmd).toContain("--model 'claude-opus-4-6'");
    expect(cmd).toContain("'hello'");
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'dip-agent-response',
        id: 9,
        result: { stdout: 'done', exitCode: 0 },
      }),
      '*'
    );
    inst.dispose();
  });

  it('surfaces a clean 127 result for trusted exec when no handler is wired', async () => {
    setDipExecHandler(undefined);
    const inst = mountDip(container, '<button>x</button>', vi.fn(), true);
    const iframe = container.querySelector('iframe')!;
    const postSpy = vi.fn();
    Object.defineProperty(iframe.contentWindow!, 'postMessage', {
      configurable: true,
      value: postSpy,
    });

    postFromDip(iframe, { type: 'dip-exec', id: 1, cmd: 'x' });
    await new Promise((r) => setTimeout(r, 0));

    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'dip-exec-response',
        id: 1,
        result: { stdout: '', stderr: 'exec: shell bridge not available\n', exitCode: 127 },
      }),
      '*'
    );
    inst.dispose();
  });

  it('rejects exec from an untrusted dip even if the message is spoofed', async () => {
    const handler = vi.fn();
    setDipExecHandler(handler);
    const inst = mountDip(container, '<button>x</button>', vi.fn(), false);
    const iframe = container.querySelector('iframe')!;
    const postSpy = vi.fn();
    Object.defineProperty(iframe.contentWindow!, 'postMessage', {
      configurable: true,
      value: postSpy,
    });

    postFromDip(iframe, { type: 'dip-exec', id: 3, cmd: 'x' });
    await new Promise((r) => setTimeout(r, 0));

    expect(handler).not.toHaveBeenCalled();
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'dip-exec-response',
        id: 3,
        error: 'exec not allowed for this dip',
      }),
      '*'
    );
    inst.dispose();
  });
});

describe('cherry iframe repaint workaround', () => {
  it('nudges repaint on load and re-nudges on visibility transitions without infinite loop', () => {
    const dom = globalThis as { window?: { self?: object; top?: object } };
    const origSelf = dom.window?.self;
    const origTop = dom.window?.top;
    (dom.window as any).self = {};

    const rafCallbacks: Array<() => void> = [];
    const originalRaf = globalThis.requestAnimationFrame;
    (globalThis as any).requestAnimationFrame = (cb: () => void) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    };

    let observerCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();
    const unobserve = vi.fn();
    const originalIO = (globalThis as any).IntersectionObserver;
    class FakeIntersectionObserver {
      constructor(cb: typeof observerCallback) {
        observerCallback = cb;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = unobserve;
    }
    (globalThis as any).IntersectionObserver = FakeIntersectionObserver;

    try {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const onLick = vi.fn();
      const inst = mountDip(container, '<p>hello</p>', onLick);

      const iframe = container.querySelector('iframe')!;
      iframe.dispatchEvent(new Event('load'));
      expect(rafCallbacks.length).toBe(1);
      rafCallbacks.shift()!();
      rafCallbacks.shift()!();
      rafCallbacks.length = 0;

      expect(observe).toHaveBeenCalled();

      observerCallback!([{ isIntersecting: true }]);
      expect(rafCallbacks.length).toBe(1);
      expect(unobserve).toHaveBeenCalledTimes(1);

      rafCallbacks.shift()!();
      rafCallbacks.shift()!();
      rafCallbacks.length = 0;
      expect(observe).toHaveBeenCalledTimes(2);

      observerCallback!([{ isIntersecting: true }]);
      expect(rafCallbacks.length).toBe(0);

      observerCallback!([{ isIntersecting: false }]);
      observerCallback!([{ isIntersecting: true }]);
      expect(rafCallbacks.length).toBe(1);

      inst.dispose();
      expect(disconnect).toHaveBeenCalled();

      container.remove();
    } finally {
      (globalThis as any).requestAnimationFrame = originalRaf;
      (globalThis as any).IntersectionObserver = originalIO;
      if (origSelf !== undefined) (dom.window as any).self = origSelf;
      if (origTop !== undefined) (dom.window as any).top = origTop;
    }
  });
});

describe('dip host action-card spacing', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function hostSheetFromSrcdoc(srcdoc: string): string {
    const sheets = [...srcdoc.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? '');
    const host = sheets.find((s) => s.includes('.sprinkle-inline .sprinkle-action-card'));
    expect(host).toBeDefined();
    return host ?? '';
  }

  function stackedCardFixture(hostCss: string, extraCss: string, html: string) {
    const style = document.createElement('style');
    style.textContent = `${hostCss}\n${extraCss}`;
    document.head.appendChild(style);
    const wrap = document.createElement('div');
    wrap.style.width = '320px';
    wrap.innerHTML = html;
    document.body.appendChild(wrap);
    return {
      cards: [...wrap.querySelectorAll<HTMLElement>('.sprinkle-action-card')],
      cleanup() {
        style.remove();
        wrap.remove();
      },
    };
  }

  it('injects a sibling gap in the host sheet while keeping the single-card reset', () => {
    const inst = mountDip(container, '<div class="sprinkle-action-card">one</div>', vi.fn());
    const host = hostSheetFromSrcdoc(container.querySelector('iframe')!.srcdoc);
    expect(host).toMatch(/\.sprinkle-inline \.sprinkle-action-card\{margin:0;width:100%\}/);
    expect(host).toMatch(
      /\.sprinkle-inline \.sprinkle-action-card\s*\+\s*\.sprinkle-action-card\{margin-top:12px\}/
    );
    inst.dispose();
  });

  it('keeps a single card full-width with no extra top margin on the first card', () => {
    const inst = mountDip(container, '<div class="sprinkle-action-card">one</div>', vi.fn());
    const host = hostSheetFromSrcdoc(container.querySelector('iframe')!.srcdoc);
    const { cards, cleanup } = stackedCardFixture(
      host,
      '',
      '<div class="sprinkle-inline"><div class="sprinkle-action-card">one</div></div>'
    );
    try {
      expect(cards).toHaveLength(1);
      expect(getComputedStyle(cards[0]!).marginTop).toBe('0px');
      expect(getComputedStyle(cards[0]!).width).toBe('100%');
    } finally {
      cleanup();
      inst.dispose();
    }
  });

  it('shows a non-zero gap between stacked action cards', () => {
    const inst = mountDip(
      container,
      '<div class="sprinkle-action-card">a</div><div class="sprinkle-action-card">b</div><div class="sprinkle-action-card">c</div>',
      vi.fn()
    );
    const host = hostSheetFromSrcdoc(container.querySelector('iframe')!.srcdoc);
    const { cards, cleanup } = stackedCardFixture(
      host,
      '',
      `<div class="sprinkle-inline">
        <div class="sprinkle-action-card">a</div>
        <div class="sprinkle-action-card">b</div>
        <div class="sprinkle-action-card">c</div>
      </div>`
    );
    try {
      expect(cards).toHaveLength(3);
      expect(getComputedStyle(cards[0]!).marginTop).toBe('0px');
      expect(getComputedStyle(cards[1]!).marginTop).toBe('12px');
      expect(getComputedStyle(cards[2]!).marginTop).toBe('12px');
      for (const card of cards) {
        expect(getComputedStyle(card).width).toBe('100%');
      }
    } finally {
      cleanup();
      inst.dispose();
    }
  });

  it('host sibling gap outranks an authored card class margin-top', () => {
    const inst = mountDip(container, '<div class="sprinkle-action-card">one</div>', vi.fn());
    const host = hostSheetFromSrcdoc(container.querySelector('iframe')!.srcdoc);
    const { cards, cleanup } = stackedCardFixture(
      host,
      '.my-card{margin-top:12px}',
      `<div class="sprinkle-inline">
        <div class="sprinkle-action-card my-card">a</div>
        <div class="sprinkle-action-card my-card">b</div>
      </div>`
    );
    try {
      expect(getComputedStyle(cards[0]!).marginTop).toBe('0px');
      expect(getComputedStyle(cards[1]!).marginTop).toBe('12px');
    } finally {
      cleanup();
      inst.dispose();
    }
  });
});
