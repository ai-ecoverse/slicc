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

// Mock collectThemeCSS — avoid needing a real DOM with stylesheets
vi.mock('./sprinkle-renderer.js', () => ({
  collectThemeCSS: () => ':root { --s2-spacing-200: 12px; }',
}));

/**
 * Pretend the preview service worker is controlling the page so the
 * image-fetch branch goes through `fetch()` (which the tests stub) and
 * not the LightningFS fallback used by uncontrolled boots.
 */
function installFakeSWController(): () => void {
  const original = (navigator as Record<string, unknown>).serviceWorker;
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { controller: { scriptURL: 'http://localhost/preview-sw.js' } },
  });
  return () => {
    if (original === undefined) {
      delete (navigator as Record<string, unknown>).serviceWorker;
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
    // The pre element should be replaced with a div.msg__dip
    expect(container.querySelector('pre')).toBeNull();
    const wrapper = container.querySelector('.msg__dip');
    expect(wrapper).not.toBeNull();
    // Should contain an iframe
    const iframe = wrapper?.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');

    // Cleanup
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
    // Regular content should still be there
    expect(container.querySelectorAll('p')).toHaveLength(3);

    disposeDips(instances);
  });

  it('does not match non-shtml code blocks', () => {
    container.innerHTML = '<pre><code class="language-javascript">const x = 1;</code></pre>';

    const instances = hydrateDips(container, vi.fn());
    expect(instances).toEqual([]);
    // The code block should remain untouched
    expect(container.querySelector('code.language-javascript')).not.toBeNull();
  });

  it('returns a placeholder instance for img[src$=".shtml"] before the fetch resolves', () => {
    // Make fetch hang forever so we can observe the synchronous placeholder.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));

    container.innerHTML = '<img src="/shared/dips/welcome.shtml" alt="Welcome">';
    const instances = hydrateDips(container, vi.fn());

    expect(instances).toHaveLength(1);
    expect(typeof instances[0].dispose).toBe('function');
    // The img element is replaced with the wrapper synchronously.
    expect(container.querySelector('img')).toBeNull();
    const wrapper = container.querySelector<HTMLElement>('.msg__dip');
    expect(wrapper?.getAttribute('title')).toBe('Welcome');

    // Disposing the placeholder must abort the in-flight fetch.
    const callArgs = fetchSpy.mock.calls[0];
    const init = callArgs[1] as RequestInit | undefined;
    const signal = init?.signal as AbortSignal | undefined;
    expect(signal?.aborted).toBe(false);
    instances[0].dispose();
    expect(signal?.aborted).toBe(true);

    fetchSpy.mockRestore();
  });

  it('does not call mountDip if the placeholder is disposed before fetch resolves', async () => {
    // Resolve fetch on demand so we can interleave dispose + resolution.
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

    // Dispose BEFORE the fetch resolves.
    instances[0].dispose();

    // Now resolve the fetch; the .then() must skip mountDip and not throw.
    resolveFetch(new Response('<p>too late</p>', { status: 200 }));
    await new Promise((r) => setTimeout(r, 0));

    // No iframe should have been mounted because dispose ran first.
    expect(container.querySelector('iframe')).toBeNull();

    fetchSpy.mockRestore();
  });
});

describe('hydrateDips — preview-vfs bridge fallback for uncontrolled boots', () => {
  let container: HTMLElement;
  let responderChannel: BroadcastChannel | null = null;
  let responderListener: ((ev: MessageEvent) => void) | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    // Force "no controller" — this is the realistic state on the very
    // first boot before the SW claims the page. dip.ts then routes
    // .shtml reads through the `preview-vfs` BroadcastChannel bridge
    // (the replacement for the legacy direct LightningFS read).
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
    delete (navigator as Record<string, unknown>).serviceWorker;
  });

  it('reads .shtml content via the preview-vfs BroadcastChannel bridge when SW is not controlling, bypassing fetch entirely', async () => {
    // Stand up an in-process `preview-vfs` responder. This is the same
    // wire contract `installPreviewVfsResponder` implements in the
    // page-side host — `preview-vfs-read` in, `preview-vfs-response`
    // out, correlated by `id`.
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

    // Tripwire: if the code mistakenly calls fetch, fail loudly.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.reject(new Error('fetch should not be called')));

    container.innerHTML = '<img src="/shared/sprinkles/welcome/welcome.shtml" alt="Welcome">';
    const instances = hydrateDips(container, vi.fn());
    expect(instances).toHaveLength(1);

    // Poll for the async bridge round-trip + mountDip — BroadcastChannel
    // dispatch is async (microtask + structured clone), so a single
    // setTimeout(0) can race ahead of the resolveContent → mountDip chain.
    const wrapper = container.querySelector<HTMLElement>('.msg__dip')!;
    let iframe: HTMLIFrameElement | null = null;
    for (let i = 0; i < 100; i++) {
      iframe = wrapper.querySelector('iframe');
      if (iframe || wrapper.textContent?.includes('Failed to load dip')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(wrapper.textContent).not.toContain('Failed to load dip');
    expect(iframe).not.toBeNull();

    // fetch was not called.
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

    // Spy on the contentWindow's postMessage; jsdom srcdoc creates a
    // contentWindow synchronously so the call after dispatching `load`
    // exercises the post-load path. The pre-load path is exercised
    // simply by the `update()` call queueing into `pendingContent`.
    const postSpy = vi.fn();
    Object.defineProperty(iframe.contentWindow, 'postMessage', {
      configurable: true,
      value: postSpy,
    });

    draft.update('<div>hi</div>');
    expect(postSpy).not.toHaveBeenCalled(); // queued, not yet sent

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

describe('dip exec/agent trust gating', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    // Clear the module-level handler so tests don't leak into each other.
    setDipExecHandler(undefined);
  });

  /** Dispatch a window `message` whose source is the dip's contentWindow. */
  function postFromDip(iframe: HTMLIFrameElement, data: Record<string, unknown>): void {
    window.dispatchEvent(
      new MessageEvent('message', { source: iframe.contentWindow as Window, data })
    );
  }

  it('untrusted dips do NOT expose exec/agent/jsh in the bridge', () => {
    const inst = mountDip(container, '<button>x</button>', vi.fn(), /* trusted */ false);
    const iframe = container.querySelector('iframe')!;
    expect(iframe.srcdoc).not.toContain('agent: function');
    expect(iframe.srcdoc).not.toContain('dip-exec');
    expect(iframe.srcdoc).not.toContain('dip-jsh');
    inst.dispose();
  });

  it('trusted dips DO expose exec/agent + the Tier 1 jsh globals in the bridge', () => {
    const inst = mountDip(container, '<button>x</button>', vi.fn(), /* trusted */ true);
    const iframe = container.querySelector('iframe')!;
    expect(iframe.srcdoc).toContain('exec: Object.assign(function');
    expect(iframe.srcdoc).toContain('agent: function');
    // Tier 1 jsh surface routes through a single `dip-jsh` round-trip.
    expect(iframe.srcdoc).toContain('dip-jsh');
    expect(iframe.srcdoc).toContain("op: 'fetch'");
    expect(iframe.srcdoc).toContain("op: 'browser'");
    inst.dispose();
  });

  it('routes a trusted dip dip-exec request to the registered handler', async () => {
    const handler = vi.fn().mockResolvedValue({ stdout: 'out', stderr: '', exitCode: 0 });
    setDipExecHandler(handler);
    const inst = mountDip(container, '<button>x</button>', vi.fn(), /* trusted */ true);
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
    const inst = mountDip(container, '<button>x</button>', vi.fn(), /* trusted */ true);
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
    const inst = mountDip(container, '<button>x</button>', vi.fn(), /* trusted */ true);
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
    const inst = mountDip(container, '<button>x</button>', vi.fn(), /* trusted */ false);
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
