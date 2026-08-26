import { describe, expect, it, vi } from 'vitest';
import type { BrowserAPI } from '../../../../../src/cdp/index.js';
import type { VirtualFS } from '../../../../../src/fs/index.js';
import {
  framesHandler,
  pdfHandler,
  screenshotHandler,
  snapshotHandler,
} from '../../../../../src/shell/supplemental-commands/playwright/handlers/snapshot.js';
import { buildSnapshot } from '../../../../../src/shell/supplemental-commands/playwright/snapshot.js';
import type { TabSnapshot } from '../../../../../src/shell/supplemental-commands/playwright/types.js';
import { createHandlerCtx, createPlaywrightState } from '../../../helpers/playwright-harness.js';

vi.mock('../../../../../src/shell/supplemental-commands/playwright/snapshot.js', async () => ({
  ...(await vi.importActual(
    '../../../../../src/shell/supplemental-commands/playwright/snapshot.js'
  )),
  takeSnapshot: vi.fn(async () => ({ output: 'SNAPSHOT-TEXT' })),
}));
vi.mock('../../../../../src/shell/supplemental-commands/playwright/session-log.js', () => ({
  ensureSessionDirs: vi.fn(async () => undefined),
}));

const TAB = 'tab-1';

type SendImpl = (method: string, params?: Record<string, unknown>) => unknown;

/** A browser with the snapshot/frames/screenshot surface, all spied. */
function makeBrowser(opts?: {
  sendImpl?: SendImpl;
  frames?: Array<{ frameId: string; parentFrameId?: string; url: string }>;
  frameTree?: { role: string; name: string; children?: unknown[] };
  screenshotB64?: string;
  evaluateResult?: unknown;
}) {
  const send = vi.fn(
    async (m: string, p?: Record<string, unknown>) =>
      (opts?.sendImpl?.(m, p) as Record<string, unknown>) ?? {}
  );
  const screenshot = vi.fn(async () => opts?.screenshotB64 ?? btoa('img'));
  const evaluate = vi.fn(async () => opts?.evaluateResult ?? null);
  const getFrameTree = vi.fn(async () => opts?.frames ?? []);
  const getAccessibilityTreeForFrame = vi.fn(async () =>
    opts?.frameTree ? opts.frameTree : { role: 'RootWebArea', name: '' }
  );
  const browser = {
    withTab: async <T>(_t: string, fn: (sessionId: string) => Promise<T>) => fn('session-1'),
    getTransport: () => ({ send }),
    getSessionId: () => 'session-1',
    screenshot,
    evaluate,
    getFrameTree,
    getAccessibilityTreeForFrame,
  } as unknown as BrowserAPI;
  return { browser, send, screenshot, evaluate, getFrameTree, getAccessibilityTreeForFrame };
}

function makeSnapshot(over: Partial<TabSnapshot> = {}): TabSnapshot {
  return {
    url: 'https://x',
    title: 't',
    content: '',
    timestamp: 0,
    refToSelector: new Map(),
    refToBackendNodeId: new Map(),
    refToFrameId: new Map(),
    ...over,
  };
}

const okFs = (): Partial<VirtualFS> => ({ writeFile: vi.fn(async () => undefined) });

describe('buildSnapshot', () => {
  it('stitches unnamed iframe content beneath its placeholder', async () => {
    const frameUrl = 'https://app.example.com/frame';
    const getAccessibilityTreeForFrame = vi.fn(async () => ({
      role: 'RootWebArea',
      name: 'Frame Content',
      children: [{ role: 'button', name: 'Frame Button', backendNodeId: 7, children: [] }],
    }));
    const browser = {
      evaluate: vi.fn(async () =>
        JSON.stringify({ url: 'https://example.com', title: 'Test Page' })
      ),
      getAccessibilityTree: vi.fn(async () => ({
        role: 'RootWebArea',
        name: 'Test Page',
        children: [
          { role: 'link', name: 'iframe docs', value: frameUrl, children: [] },
          { role: 'iframe', name: '', value: frameUrl, children: [] },
        ],
      })),
      getFrameTree: vi.fn(async () => [
        { frameId: 'main', url: 'https://example.com' },
        { frameId: 'frame-1', parentFrameId: 'main', url: frameUrl },
      ]),
      getAccessibilityTreeForFrame,
    } as unknown as BrowserAPI;

    const result = await buildSnapshot(browser);

    expect(result.text).toContain(
      `  - link "iframe docs" [ref=e1]: "${frameUrl}"\n` +
        `  - iframe: "${frameUrl}"\n` +
        '    - rootwebarea "Frame Content"\n' +
        '      - button "Frame Button" [ref=f1e1]'
    );
    expect(getAccessibilityTreeForFrame).toHaveBeenCalledOnce();
    expect(result.refToFrameId.get('f1e1')).toBe('frame-1');
  });
});

describe('snapshotHandler', () => {
  it('requires a --tab flag', async () => {
    const r = await snapshotHandler(createHandlerCtx());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('--tab');
  });

  it('prints the snapshot text', async () => {
    const { browser } = makeBrowser();
    const r = await snapshotHandler(createHandlerCtx({ browser, flags: { tab: TAB } }));
    expect(r.stdout).toBe('SNAPSHOT-TEXT\n');
  });

  it('saves the snapshot to a file', async () => {
    const { browser } = makeBrowser();
    const writeFile = vi.fn(async () => undefined);
    const r = await snapshotHandler(
      createHandlerCtx({
        browser,
        flags: { tab: TAB, filename: '/snap.txt' },
        fs: { writeFile: writeFile as unknown as VirtualFS['writeFile'] },
      })
    );
    expect(r.stdout).toBe('Snapshot saved to /snap.txt\n');
    expect(writeFile).toHaveBeenCalledWith('/snap.txt', 'SNAPSHOT-TEXT');
  });

  it('prints only the selected frame subtree and records frame refs', async () => {
    const { browser, getAccessibilityTreeForFrame } = makeBrowser({
      frames: [
        { frameId: 'main', url: 'https://x' },
        { frameId: 'frame-1', parentFrameId: 'main', url: 'https://x/frame' },
      ],
      frameTree: {
        role: 'RootWebArea',
        name: 'Frame Content',
        children: [{ role: 'button', name: 'Frame Button', backendNodeId: 7, children: [] }],
      },
    });
    const state = createPlaywrightState();

    const r = await snapshotHandler(
      createHandlerCtx({ browser, state, flags: { tab: TAB, frame: 'frame-1' } })
    );

    expect(r.stdout).toContain('- rootwebarea "Frame Content"');
    expect(r.stdout).toContain('- button "Frame Button" [ref=f1e1]');
    expect(r.stdout).not.toContain('SNAPSHOT-TEXT');
    expect(getAccessibilityTreeForFrame).toHaveBeenCalledWith('frame-1');
    expect(state.snapshots.get(TAB)?.refToFrameId.get('f1e1')).toBe('frame-1');
  });

  it('rejects an unknown --frame with an actionable frames command', async () => {
    const { browser } = makeBrowser({ frames: [{ frameId: 'main', url: 'https://x' }] });
    await expect(
      snapshotHandler(createHandlerCtx({ browser, flags: { tab: TAB, frame: 'missing-frame' } }))
    ).rejects.toThrow('playwright-cli frames --tab=tab-1');
  });
});

describe('framesHandler', () => {
  it('requires a --tab flag', async () => {
    const r = await framesHandler(createHandlerCtx());
    expect(r.exitCode).toBe(1);
  });

  it('lists the main frame and child frames', async () => {
    const { browser } = makeBrowser({
      frames: [
        { frameId: 'F1', url: 'https://x' },
        { frameId: 'F2', parentFrameId: 'F1', url: 'https://x/iframe' },
      ],
    });
    const r = await framesHandler(createHandlerCtx({ browser, flags: { tab: TAB } }));
    expect(r.stdout).toContain('use with --frame, never --tab');
    expect(r.stdout).toContain('[main] frameId=F1');
    expect(r.stdout).toContain('[child] frameId=F2 parentFrameId=F1');
  });
});

describe('pdfHandler', () => {
  it('saves a PDF to the default path', async () => {
    const { browser } = makeBrowser({
      sendImpl: (m) => (m === 'Page.printToPDF' ? { data: btoa('pdf') } : {}),
    });
    const writeFile = vi.fn(async () => undefined);
    const r = await pdfHandler(
      createHandlerCtx({
        browser,
        flags: { tab: TAB },
        fs: { writeFile: writeFile as unknown as VirtualFS['writeFile'] },
      })
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Saved PDF to /tmp/page-');
    expect(writeFile).toHaveBeenCalledWith(expect.stringContaining('.pdf'), expect.any(Uint8Array));
  });

  it('surfaces a print failure', async () => {
    const { browser } = makeBrowser({
      sendImpl: (m) => {
        if (m === 'Page.printToPDF') throw new Error('no printer');
        return {};
      },
    });
    const r = await pdfHandler(createHandlerCtx({ browser, flags: { tab: TAB }, fs: okFs() }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('pdf: no printer');
  });
});

describe('screenshotHandler', () => {
  it('captures the viewport and saves to the default path', async () => {
    const { browser, screenshot } = makeBrowser();
    const writeFile = vi.fn(async () => undefined);
    const r = await screenshotHandler(
      createHandlerCtx({
        browser,
        flags: { tab: TAB },
        fs: { writeFile: writeFile as unknown as VirtualFS['writeFile'] },
      })
    );
    expect(r.stdout).toContain('Screenshot saved to /tmp/screenshot-');
    expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ fullPage: false }));
  });

  it('clips to an element resolved by backendNodeId', async () => {
    const { browser, screenshot } = makeBrowser({
      sendImpl: (m) => {
        if (m === 'DOM.resolveNode') return { object: { objectId: 'o1' } };
        if (m === 'Runtime.callFunctionOn') {
          return { result: { value: { x: 1, y: 2, width: 3, height: 4 } } };
        }
        return {};
      },
    });
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeSnapshot({ refToBackendNodeId: new Map([['e5', 9]]) }));
    const r = await screenshotHandler(
      createHandlerCtx({ browser, state, positional: ['e5'], flags: { tab: TAB }, fs: okFs() })
    );
    expect(r.exitCode).toBe(0);
    expect(screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ clip: { x: 1, y: 2, width: 3, height: 4 } })
    );
  });

  it('fails loudly when the element clip cannot be resolved — never a silent viewport frame', async () => {
    const { browser, screenshot } = makeBrowser({ evaluateResult: null });
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeSnapshot({ refToSelector: new Map([['e5', '#a']]) }));
    const r = await screenshotHandler(
      createHandlerCtx({ browser, state, positional: ['e5'], flags: { tab: TAB }, fs: okFs() })
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('could not resolve element e5');
    expect(r.stderr).toContain('snapshot');
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('fails loudly when the resolved element box has zero size', async () => {
    const { browser, screenshot } = makeBrowser({
      sendImpl: (m) => {
        if (m === 'DOM.resolveNode') return { object: { objectId: 'o1' } };
        if (m === 'Runtime.callFunctionOn') {
          return { result: { value: { x: 1, y: 2, width: 0, height: 0 } } };
        }
        return {};
      },
    });
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeSnapshot({ refToBackendNodeId: new Map([['e5', 9]]) }));
    const r = await screenshotHandler(
      createHandlerCtx({ browser, state, positional: ['e5'], flags: { tab: TAB }, fs: okFs() })
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('could not resolve element e5');
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('throws when a ref screenshot has no snapshot', async () => {
    const { browser } = makeBrowser();
    await expect(
      screenshotHandler(
        createHandlerCtx({
          browser,
          state: createPlaywrightState(),
          positional: ['e5'],
          flags: { tab: TAB },
          fs: okFs(),
        })
      )
    ).rejects.toThrow('No snapshot');
  });
});
