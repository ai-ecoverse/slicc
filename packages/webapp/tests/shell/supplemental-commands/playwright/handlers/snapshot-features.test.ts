/**
 * Tests for the official-CLI alignment features: snapshot --depth/--boxes,
 * find, screenshot --type/--hires, and open --mobile.
 */

import { describe, expect, it, vi } from 'vitest';
import type { BrowserAPI } from '../../../../../src/cdp/index.js';
import type { VirtualFS } from '../../../../../src/fs/index.js';
import {
  findHandler,
  screenshotHandler,
  snapshotHandler,
} from '../../../../../src/shell/supplemental-commands/playwright/handlers/snapshot.js';
import { openHandler } from '../../../../../src/shell/supplemental-commands/playwright/handlers/tabs.js';
import { takeSnapshot } from '../../../../../src/shell/supplemental-commands/playwright/snapshot.js';
import { createHandlerCtx, createPlaywrightState } from '../../../helpers/playwright-harness.js';

const SNAPSHOT_TEXT = [
  'Page URL: https://x',
  'Page Title: t',
  '',
  '- rootwebarea "t"',
  '  - navigation "Main"',
  '    - link "Home" [ref=e1]',
  '  - main',
  '    - button "Submit Order" [ref=e2]',
  '      - statictext "Submit Order"',
].join('\n');

vi.mock('../../../../../src/shell/supplemental-commands/playwright/snapshot.js', async () => ({
  ...(await vi.importActual(
    '../../../../../src/shell/supplemental-commands/playwright/snapshot.js'
  )),
  takeSnapshot: vi.fn(),
  resolveAppTabId: vi.fn(async () => null),
  getActionablePages: vi.fn(async () => []),
}));
vi.mock('../../../../../src/shell/supplemental-commands/playwright/session-log.js', () => ({
  ensureSessionDirs: vi.fn(async () => undefined),
}));

const TAB = 'tab-1';

function mockTakeSnapshot(refToBackendNodeId = new Map<string, number>()): void {
  vi.mocked(takeSnapshot).mockResolvedValue({
    snapshot: {
      url: 'https://x',
      title: 't',
      content: SNAPSHOT_TEXT,
      timestamp: 0,
      refToSelector: new Map(),
      refToBackendNodeId,
      refToFrameId: new Map(),
    },
    output: SNAPSHOT_TEXT,
  });
}

function makeBrowser(opts?: {
  evaluateResult?: unknown;
  transportSend?: (method: string, params?: Record<string, unknown>) => unknown;
}) {
  const screenshot = vi.fn(async () => btoa('img'));
  const evaluate = vi.fn(async () => opts?.evaluateResult ?? null);
  const createPage = vi.fn(async () => TAB);
  const setViewportOverride = vi.fn(async () => undefined);
  const navigate = vi.fn(async () => undefined);
  const transportSend = vi.fn(
    async (method: string, params?: Record<string, unknown>) =>
      (opts?.transportSend?.(method, params) as Record<string, unknown>) ?? {}
  );
  let tabLockHeldFor: string | null = null;
  const browser = {
    withTab: async <T>(t: string, fn: (sessionId: string) => Promise<T>) => {
      tabLockHeldFor = t;
      try {
        return await fn('session-1');
      } finally {
        tabLockHeldFor = null;
      }
    },
    getTransport: () => ({ send: transportSend }),
    getSessionId: () => 'session-1',
    screenshot,
    evaluate,
    createPage,
    setViewportOverride,
    navigate,
  } as unknown as BrowserAPI;
  return {
    browser,
    screenshot,
    evaluate,
    createPage,
    setViewportOverride,
    navigate,
    transportSend,
    lockHeldFor: () => tabLockHeldFor,
  };
}

const okFs = (): Partial<VirtualFS> => ({ writeFile: vi.fn(async () => undefined) });

describe('snapshot --depth', () => {
  it('elides nodes at or below the depth cap with a note', async () => {
    mockTakeSnapshot();
    const { browser } = makeBrowser();
    const result = await snapshotHandler(
      createHandlerCtx({ browser, flags: { tab: TAB, depth: '2' } })
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('- navigation "Main"');
    expect(result.stdout).not.toContain('link "Home"');
    expect(result.stdout).not.toContain('statictext');
    expect(result.stdout).toContain('below depth 2 elided');
    // Headers always survive depth-limiting.
    expect(result.stdout).toContain('Page URL: https://x');
  });

  it('rejects a non-integer depth, including trailing garbage parseInt would eat', async () => {
    mockTakeSnapshot();
    const { browser } = makeBrowser();
    for (const bad of ['nope', '2abc', '0', '-1', '2.5']) {
      const result = await snapshotHandler(
        createHandlerCtx({ browser, flags: { tab: TAB, depth: bad } })
      );
      expect(result.exitCode, `--depth=${bad}`).toBe(1);
      expect(result.stderr).toContain('--depth must be a positive integer');
    }
  });
});

describe('snapshot --boxes', () => {
  it('resolves rects through backendNodeIds so text-labelled and duplicate-name elements work', async () => {
    // Two elements whose reconstructed CSS selectors would collide or miss —
    // identity comes from the snapshot's backendNodeIds instead.
    mockTakeSnapshot(
      new Map([
        ['e1', 101],
        ['e2', 102],
      ])
    );
    const rects: Record<number, number[]> = {
      101: [0, 0, 50, 20],
      102: [10, 20, 120, 40],
    };
    let resolvedBackendId = 0;
    const { browser, transportSend } = makeBrowser({
      transportSend: (method, params) => {
        if (method === 'DOM.resolveNode') {
          resolvedBackendId = params?.['backendNodeId'] as number;
          // e1's node has detached — no objectId, so its line stays bare.
          return resolvedBackendId === 101
            ? {}
            : { object: { objectId: `obj-${resolvedBackendId}` } };
        }
        if (method === 'Runtime.callFunctionOn') {
          return { result: { value: rects[resolvedBackendId] } };
        }
        return {};
      },
    });
    const result = await snapshotHandler(
      createHandlerCtx({ browser, flags: { tab: TAB, boxes: 'true' } })
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[ref=e2] [box=10,20,120,40]');
    // e1 did not resolve — its line stays unannotated rather than lying.
    expect(result.stdout).toContain('[ref=e1]\n');
    expect(transportSend).toHaveBeenCalledWith(
      'DOM.resolveNode',
      { backendNodeId: 102 },
      'session-1'
    );
  });

  it('rejects --boxes with --frame', async () => {
    mockTakeSnapshot();
    const { browser } = makeBrowser();
    const result = await snapshotHandler(
      createHandlerCtx({ browser, flags: { tab: TAB, boxes: 'true', frame: 'F1' } })
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--boxes is not supported with --frame');
  });
});

describe('find', () => {
  it('returns matching lines with surrounding context', async () => {
    mockTakeSnapshot();
    const { browser } = makeBrowser();
    const result = await findHandler(
      createHandlerCtx({ browser, positional: ['submit', 'order'], flags: { tab: TAB } })
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('matching line(s)');
    expect(result.stdout).toContain('button "Submit Order" [ref=e2]');
    expect(result.stdout).toContain('- main'); // context line above the match
  });

  it('merges overlapping context windows into one region', async () => {
    mockTakeSnapshot();
    const { browser } = makeBrowser();
    // "Submit Order" appears on the button line AND its statictext child —
    // adjacent matches must render one merged block, not two near-duplicates.
    const result = await findHandler(
      createHandlerCtx({ browser, positional: ['submit order'], flags: { tab: TAB } })
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('2 matching line(s) in 1 region(s)');
    expect(result.stdout).not.toContain('---');
    const occurrences = result.stdout.split('button "Submit Order"').length - 1;
    expect(occurrences).toBe(1);
  });

  it('supports --regex', async () => {
    mockTakeSnapshot();
    const { browser } = makeBrowser();
    const result = await findHandler(
      createHandlerCtx({ browser, flags: { tab: TAB, regex: 'submit\\s+order' } })
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[ref=e2]');
  });

  it('rejects text and --regex together, and neither', async () => {
    mockTakeSnapshot();
    const { browser } = makeBrowser();
    const both = await findHandler(
      createHandlerCtx({ browser, positional: ['x'], flags: { tab: TAB, regex: 'y' } })
    );
    expect(both.exitCode).toBe(1);
    const neither = await findHandler(createHandlerCtx({ browser, flags: { tab: TAB } }));
    expect(neither.exitCode).toBe(1);
  });

  it('rejects an invalid --regex', async () => {
    mockTakeSnapshot();
    const { browser } = makeBrowser();
    const result = await findHandler(
      createHandlerCtx({ browser, flags: { tab: TAB, regex: '(' } })
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid --regex');
  });

  it('reports no matches with exit 0', async () => {
    mockTakeSnapshot();
    const { browser } = makeBrowser();
    const result = await findHandler(
      createHandlerCtx({ browser, positional: ['zebra'], flags: { tab: TAB } })
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No matches');
  });
});

describe('screenshot --type / --hires', () => {
  it('passes an explicit --type to the capture and names the file to match', async () => {
    const { browser, screenshot } = makeBrowser();
    const result = await screenshotHandler(
      createHandlerCtx({ browser, fs: okFs(), flags: { tab: TAB, type: 'jpeg' } })
    );
    expect(result.exitCode).toBe(0);
    expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ format: 'jpeg' }));
    expect(result.stdout).toMatch(/\.jpg /);
  });

  it('infers the format from the --filename extension', async () => {
    const { browser, screenshot } = makeBrowser();
    await screenshotHandler(
      createHandlerCtx({ browser, fs: okFs(), flags: { tab: TAB, filename: '/tmp/shot.webp' } })
    );
    expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ format: 'webp' }));
  });

  it('rejects --max-width with non-PNG output', async () => {
    const { browser, screenshot } = makeBrowser();
    const result = await screenshotHandler(
      createHandlerCtx({
        browser,
        fs: okFs(),
        flags: { tab: TAB, type: 'jpeg', 'max-width': '800' },
      })
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--max-width requires png output');
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('rejects an unknown --type', async () => {
    const { browser, screenshot } = makeBrowser();
    const result = await screenshotHandler(
      createHandlerCtx({ browser, fs: okFs(), flags: { tab: TAB, type: 'bmp' } })
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--type must be png, jpeg, or webp');
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('--hires captures the viewport as a clip scaled by the device pixel ratio', async () => {
    const { browser, screenshot } = makeBrowser({
      evaluateResult: JSON.stringify({ dpr: 2, w: 1280, h: 800, sh: 4000 }),
    });
    const result = await screenshotHandler(
      createHandlerCtx({ browser, fs: okFs(), flags: { tab: TAB, hires: 'true' } })
    );
    expect(result.exitCode).toBe(0);
    expect(screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ clip: { x: 0, y: 0, width: 1280, height: 800, scale: 2 } })
    );
  });

  it('--hires with --fullPage scales the full scroll height', async () => {
    const { browser, screenshot } = makeBrowser({
      evaluateResult: JSON.stringify({ dpr: 2, w: 1280, h: 800, sh: 4000 }),
    });
    await screenshotHandler(
      createHandlerCtx({
        browser,
        fs: okFs(),
        flags: { tab: TAB, hires: 'true', fullPage: 'true' },
      })
    );
    expect(screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ clip: expect.objectContaining({ height: 4000, scale: 2 }) })
    );
  });
});

describe('open --mobile', () => {
  it('creates the tab blank, applies the mobile identity, then navigates — all under the tab lock', async () => {
    const harness = makeBrowser();
    const { browser, createPage, navigate } = harness;
    const lockDuringOverride: Array<string | null> = [];
    const lockDuringNavigate: Array<string | null> = [];
    harness.setViewportOverride.mockImplementation(async () => {
      lockDuringOverride.push(harness.lockHeldFor());
    });
    navigate.mockImplementation(async () => {
      lockDuringNavigate.push(harness.lockHeldFor());
    });
    const result = await openHandler(
      createHandlerCtx({
        browser,
        state: createPlaywrightState(),
        positional: ['https://example.com'],
        flags: { mobile: 'true' },
      })
    );
    expect(result.exitCode).toBe(0);
    // The first document request must already carry the mobile UA — creating
    // the tab directly on the URL would fetch it with the desktop identity.
    expect(createPage).toHaveBeenCalledWith('about:blank');
    expect(harness.setViewportOverride).toHaveBeenCalledWith(
      TAB,
      412,
      915,
      expect.objectContaining({
        mobile: true,
        deviceScaleFactor: 2.625,
        userAgent: expect.stringContaining('Mobile Safari'),
      })
    );
    expect(navigate).toHaveBeenCalledWith('https://example.com');
    // Both the attach-heavy override and the navigation must happen while the
    // tab lock is held — attaching outside it can steal a concurrent
    // command's session onto this tab.
    expect(lockDuringOverride).toEqual([TAB]);
    expect(lockDuringNavigate).toEqual([TAB]);
    const overrideOrder = harness.setViewportOverride.mock.invocationCallOrder[0];
    const navigateOrder = navigate.mock.invocationCallOrder[0];
    expect(overrideOrder).toBeLessThan(navigateOrder);
  });

  it('does not navigate a --mobile tab opened on about:blank', async () => {
    const { browser, setViewportOverride, navigate } = makeBrowser();
    const result = await openHandler(
      createHandlerCtx({ browser, state: createPlaywrightState(), flags: { mobile: 'true' } })
    );
    expect(result.exitCode).toBe(0);
    expect(setViewportOverride).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not apply emulation without --mobile', async () => {
    const { browser, setViewportOverride, createPage, navigate } = makeBrowser();
    await openHandler(
      createHandlerCtx({
        browser,
        state: createPlaywrightState(),
        positional: ['https://example.com'],
        flags: {},
      })
    );
    expect(createPage).toHaveBeenCalledWith('https://example.com');
    expect(setViewportOverride).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
