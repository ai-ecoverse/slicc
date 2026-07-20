import { describe, expect, it, vi } from 'vitest';
import type { BrowserAPI } from '../../../../../src/cdp/index.js';
import type { VirtualFS } from '../../../../../src/fs/index.js';
import {
  framesHandler,
  pdfHandler,
  screenshotHandler,
  snapshotHandler,
} from '../../../../../src/shell/supplemental-commands/playwright/handlers/snapshot.js';
import type { TabSnapshot } from '../../../../../src/shell/supplemental-commands/playwright/types.js';
import { createHandlerCtx, createPlaywrightState } from '../../../helpers/playwright-harness.js';

vi.mock('../../../../../src/shell/supplemental-commands/playwright/snapshot.js', () => ({
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
  const browser = {
    withTab: async <T>(_t: string, fn: (sessionId: string) => Promise<T>) => fn('session-1'),
    getTransport: () => ({ send }),
    getSessionId: () => 'session-1',
    screenshot,
    evaluate,
    getFrameTree,
  } as unknown as BrowserAPI;
  return { browser, send, screenshot, evaluate, getFrameTree };
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
    expect(r.stdout).toContain('[main] F1');
    expect(r.stdout).toContain('[child] F2 (parent: F1)');
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

  it('warns when the element clip cannot be resolved', async () => {
    const { browser } = makeBrowser({ evaluateResult: null });
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeSnapshot({ refToSelector: new Map([['e5', '#a']]) }));
    const r = await screenshotHandler(
      createHandlerCtx({ browser, state, positional: ['e5'], flags: { tab: TAB }, fs: okFs() })
    );
    expect(r.stderr).toContain('could not clip to element e5');
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
