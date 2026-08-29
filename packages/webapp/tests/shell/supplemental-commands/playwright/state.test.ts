import { describe, expect, it, vi } from 'vitest';
import { FsError } from '../../../../src/fs/index.js';
import {
  TRAY_JOIN_STORAGE_KEY as CANONICAL_TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY as CANONICAL_TRAY_WORKER_STORAGE_KEY,
} from '../../../../src/scoops/tray-runtime-config.js';
import {
  filenameSafeTimestamp,
  frameIdUsedAsTabError,
  getCurrentPageLocation,
  getSharedState,
  isAlreadyExistsError,
  listAllTargetsWithRemote,
  parseFlags,
  parseRef,
  requireTab,
  resolveFrame,
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../../../../src/shell/supplemental-commands/playwright/state.js';

describe('playwright state helpers', () => {
  it('keeps inlined tray storage keys byte-identical to the canonical source', () => {
    // The keys are inlined in state.ts to avoid a shell → scoops back-edge; this
    // test imports both copies (allowed in tests) to catch silent drift if the
    // canonical values in scoops/tray-runtime-config.ts ever change.
    expect(TRAY_WORKER_STORAGE_KEY).toBe(CANONICAL_TRAY_WORKER_STORAGE_KEY);
    expect(TRAY_JOIN_STORAGE_KEY).toBe(CANONICAL_TRAY_JOIN_STORAGE_KEY);
  });

  it('parses main-frame and iframe refs', () => {
    expect(parseRef('e5')).toEqual({ framePrefix: '', isIframe: false });
    expect(parseRef('f1e5')).toEqual({ framePrefix: 'f1', isIframe: true });
    expect(parseRef('not-a-ref')).toEqual({ framePrefix: '', isIframe: false });
  });

  it('formats ISO timestamps for filenames', () => {
    expect(filenameSafeTimestamp(new Date('2026-08-29T12:34:56.789Z'))).toBe(
      '2026-08-29T12-34-56.789Z'
    );
  });

  it('detects EEXIST from FsError, code bags, and message text', () => {
    expect(isAlreadyExistsError(new FsError('EEXIST', 'exists'))).toBe(true);
    expect(isAlreadyExistsError({ code: 'EEXIST' })).toBe(true);
    expect(isAlreadyExistsError(new Error('EEXIST: file exists'))).toBe(true);
    expect(isAlreadyExistsError(new Error('ENOENT'))).toBe(false);
    expect(isAlreadyExistsError('plain')).toBe(false);
  });

  it('parses flags including the --no-iframes rewrite', () => {
    expect(parseFlags(['click', 'e5', '--tab=t1', '--no-iframes'])).toEqual({
      positional: ['click', 'e5'],
      flags: { tab: 't1', 'no-iframes': 'true' },
    });
    expect(parseFlags(['--full-page', '--fg'])).toEqual({
      positional: [],
      flags: {
        'full-page': 'true',
        fullPage: 'true',
        fg: 'true',
        foreground: 'true',
      },
    });
  });

  it('requires --tab', () => {
    expect(requireTab({})).toEqual({
      error: "Error: --tab <targetId> is required. Run 'playwright-cli tab-list' to get tab IDs.\n",
    });
    expect(requireTab({ tab: 't1' })).toEqual({ targetId: 't1' });
  });

  it('shares PlaywrightState per browser+fs pair', () => {
    const browser = {};
    const fsA = {} as never;
    const fsB = {} as never;
    const a1 = getSharedState(browser as never, fsA);
    const a2 = getSharedState(browser as never, fsA);
    const b1 = getSharedState(browser as never, fsB);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
    expect(a1.snapshots).toBeInstanceOf(Map);
  });
});

describe('playwright browser helpers', () => {
  it('reads the current page location from evaluate JSON', async () => {
    const browser = {
      evaluate: vi
        .fn()
        .mockResolvedValue(
          JSON.stringify({ href: 'https://ex.test/p', hostname: 'ex.test', pathname: '/p' })
        ),
      getFrameTree: vi.fn(),
      listPages: vi.fn(),
      withTab: vi.fn(),
    };
    await expect(getCurrentPageLocation(browser)).resolves.toEqual({
      href: 'https://ex.test/p',
      hostname: 'ex.test',
      pathname: '/p',
    });
  });

  it('resolves --frame against the frame tree or throws', async () => {
    const frames = [
      { frameId: 'main', url: 'https://a', name: '' },
      { frameId: 'child', parentFrameId: 'main', url: 'https://b', name: 'f' },
    ];
    const browser = {
      evaluate: vi.fn(),
      getFrameTree: vi.fn().mockResolvedValue(frames),
      listPages: vi.fn(),
      withTab: vi.fn(),
    };
    await expect(resolveFrame(browser, {})).resolves.toBeNull();
    await expect(resolveFrame(browser, { frame: 'child' })).resolves.toEqual(frames[1]);
    await expect(resolveFrame(browser, { frame: 'missing', tab: 't1' })).rejects.toThrow(
      /Unknown frame ID "missing" for tab t1/
    );
  });

  it('lists local pages when listAllTargets is absent', async () => {
    const pages = [{ targetId: 't1', title: 'One', url: 'https://a' }];
    const browser = {
      evaluate: vi.fn(),
      getFrameTree: vi.fn(),
      listPages: vi.fn().mockResolvedValue(pages),
      withTab: vi.fn(),
    };
    await expect(listAllTargetsWithRemote(browser)).resolves.toEqual(pages);
    expect(browser.listPages).toHaveBeenCalledOnce();
  });

  it('returns listAllTargets pages when no tray is configured', async () => {
    const pages = [{ targetId: 't1', title: 'One', url: 'https://a' }];
    const browser = {
      evaluate: vi.fn(),
      getFrameTree: vi.fn(),
      listPages: vi.fn(),
      listAllTargets: vi.fn().mockResolvedValue(pages),
      withTab: vi.fn(),
    };
    await expect(listAllTargetsWithRemote(browser)).resolves.toEqual(pages);
  });

  it('explains when a frame ID was used as --tab', async () => {
    const browser = {
      evaluate: async () => undefined as unknown,
      getFrameTree: async () => [{ frameId: 'frame-1', url: 'https://a', name: '' }],
      listPages: async () => [{ targetId: 'tab-1', title: 'T', url: 'https://a' }],
      withTab: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn(),
    };
    await expect(
      frameIdUsedAsTabError(browser, 'frame-1', new Error('No target with given id found'))
    ).resolves.toContain('is a frame ID, not a tab target ID');
    await expect(
      frameIdUsedAsTabError(browser, 'frame-1', new Error('something else'))
    ).resolves.toBeNull();
  });
});
