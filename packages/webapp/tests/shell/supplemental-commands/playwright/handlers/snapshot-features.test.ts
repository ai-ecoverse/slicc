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

function mockTakeSnapshot(refToSelector = new Map<string, string>()): void {
  vi.mocked(takeSnapshot).mockResolvedValue({
    snapshot: {
      url: 'https://x',
      title: 't',
      content: SNAPSHOT_TEXT,
      timestamp: 0,
      refToSelector,
      refToBackendNodeId: new Map(),
      refToFrameId: new Map(),
    },
    output: SNAPSHOT_TEXT,
  });
}

function makeBrowser(opts?: { evaluateResult?: unknown }) {
  const screenshot = vi.fn(async () => btoa('img'));
  const evaluate = vi.fn(async () => opts?.evaluateResult ?? null);
  const createPage = vi.fn(async () => TAB);
  const setViewportOverride = vi.fn(async () => undefined);
  const browser = {
    withTab: async <T>(_t: string, fn: (sessionId: string) => Promise<T>) => fn('session-1'),
    getTransport: () => ({ send: vi.fn(async () => ({})) }),
    getSessionId: () => 'session-1',
    screenshot,
    evaluate,
    createPage,
    setViewportOverride,
  } as unknown as BrowserAPI;
  return { browser, screenshot, evaluate, createPage, setViewportOverride };
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

  it('rejects a non-integer depth', async () => {
    mockTakeSnapshot();
    const { browser } = makeBrowser();
    const result = await snapshotHandler(
      createHandlerCtx({ browser, flags: { tab: TAB, depth: 'nope' } })
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--depth must be a positive integer');
  });
});

describe('snapshot --boxes', () => {
  it('appends [box=…] to refs resolved in one page evaluation', async () => {
    mockTakeSnapshot(
      new Map([
        ['e1', 'a[href]'],
        ['e2', 'button'],
      ])
    );
    const { browser, evaluate } = makeBrowser({
      evaluateResult: JSON.stringify({ e2: [10, 20, 120, 40] }),
    });
    const result = await snapshotHandler(
      createHandlerCtx({ browser, flags: { tab: TAB, boxes: 'true' } })
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[ref=e2] [box=10,20,120,40]');
    // e1 did not resolve — its line stays unannotated rather than lying.
    expect(result.stdout).toContain('[ref=e1]\n');
    expect(evaluate).toHaveBeenCalledTimes(1);
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
  it('applies sticky mobile emulation to the new tab', async () => {
    const { browser, setViewportOverride } = makeBrowser();
    const result = await openHandler(
      createHandlerCtx({
        browser,
        state: createPlaywrightState(),
        positional: ['https://example.com'],
        flags: { mobile: 'true' },
      })
    );
    expect(result.exitCode).toBe(0);
    expect(setViewportOverride).toHaveBeenCalledWith(
      TAB,
      412,
      915,
      expect.objectContaining({
        mobile: true,
        deviceScaleFactor: 2.625,
        userAgent: expect.stringContaining('Mobile Safari'),
      })
    );
  });

  it('does not apply emulation without --mobile', async () => {
    const { browser, setViewportOverride } = makeBrowser();
    await openHandler(
      createHandlerCtx({
        browser,
        state: createPlaywrightState(),
        positional: ['https://example.com'],
        flags: {},
      })
    );
    expect(setViewportOverride).not.toHaveBeenCalled();
  });
});
