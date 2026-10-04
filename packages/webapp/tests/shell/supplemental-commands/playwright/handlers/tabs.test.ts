import { describe, expect, it, vi } from 'vitest';
import type { BrowserAPI } from '../../../../../src/cdp/index.js';
import {
  openHandler,
  tabCloseHandler,
  tabListHandler,
  tabSelectHandler,
} from '../../../../../src/shell/supplemental-commands/playwright/handlers/tabs.js';
import { createHandlerCtx, createPlaywrightState } from '../../../helpers/playwright-harness.js';

type Page = { targetId: string; title: string; url: string; active?: boolean };

const page = (targetId: string, url = `https://${targetId.toLowerCase()}.example/`): Page => ({
  targetId,
  title: targetId,
  url,
});

/**
 * A browser whose tab listing is whatever `pages` holds at call time, in that
 * order — tests set it to the order Chrome actually reports.
 */
function makeBrowser(initial: Page[]) {
  const listing = { pages: initial };
  const bringToFront = vi.fn(async () => undefined);
  const browser = {
    listPages: vi.fn(async () => listing.pages),
    createPage: vi.fn(async (url: string) => {
      const created = page(`NEW${listing.pages.length}`, url);
      listing.pages = [...listing.pages, created];
      return created.targetId;
    }),
    closePage: vi.fn(async (targetId: string) => {
      listing.pages = listing.pages.filter((p) => p.targetId !== targetId);
    }),
    withTab: async <T>(targetId: string, fn: (tab: unknown) => Promise<T>) =>
      fn({ targetId, bringToFront }),
  } as unknown as BrowserAPI;
  return { browser, listing, bringToFront };
}

/** `tab-list` lines as `{ id, number }`. */
async function listTabs(ctx: Parameters<typeof tabListHandler>[0]) {
  const { stdout } = await tabListHandler(ctx);
  return [...stdout.matchAll(/^\[([^\]]+)\] .* \(tab ([0-9]+)\)/gm)].map((m) => ({
    id: m[1],
    number: Number(m[2]),
  }));
}

describe('stable tab numbers', () => {
  // Real Chrome, 2026-10-04: creating tabs A..G one by one, Target.getTargets
  // listed `C | about:blank | A | B | E | G | F | D` — new tabs land mid-list,
  // so a list position named a different tab after every open.
  it('keeps every tab on its number when Chrome lists a new tab mid-list', async () => {
    const { browser, listing } = makeBrowser([page('A'), page('B'), page('D')]);
    const state = createPlaywrightState();
    const first = await listTabs(createHandlerCtx({ browser, state }));
    expect(first).toEqual([
      { id: 'A', number: 1 },
      { id: 'B', number: 2 },
      { id: 'D', number: 3 },
    ]);

    listing.pages = [page('A'), page('B'), page('E'), page('D')];
    const second = await listTabs(createHandlerCtx({ browser, state }));
    expect(second).toEqual([
      { id: 'A', number: 1 },
      { id: 'B', number: 2 },
      { id: 'D', number: 3 },
      { id: 'E', number: 4 },
    ]);
  });

  it('never reuses a closed tab’s number and keeps the others in place', async () => {
    const { browser, listing } = makeBrowser([page('A'), page('B'), page('C')]);
    const state = createPlaywrightState();
    await listTabs(createHandlerCtx({ browser, state }));

    listing.pages = [page('A'), page('C')];
    listing.pages = [page('NEXT'), ...listing.pages];
    expect(await listTabs(createHandlerCtx({ browser, state }))).toEqual([
      { id: 'A', number: 1 },
      { id: 'C', number: 3 },
      { id: 'NEXT', number: 4 },
    ]);
  });

  it('keeps a remote tab’s number through a listing that missed it', async () => {
    const { browser, listing } = makeBrowser([page('A'), page('follower:7')]);
    const state = createPlaywrightState();
    await listTabs(createHandlerCtx({ browser, state }));

    listing.pages = [page('A')];
    await listTabs(createHandlerCtx({ browser, state }));
    listing.pages = [page('A'), page('follower:7')];
    expect(await listTabs(createHandlerCtx({ browser, state }))).toEqual([
      { id: 'A', number: 1 },
      { id: 'follower:7', number: 2 },
    ]);
  });

  // Codex review on #3802: a tab on a page tab-list hides is still open.
  it('keeps the number of a tab that visits a hidden chrome:// page', async () => {
    const { browser, listing } = makeBrowser([page('A'), page('B')]);
    const state = createPlaywrightState();
    await listTabs(createHandlerCtx({ browser, state }));

    listing.pages = [page('A', 'chrome://settings/'), page('B')];
    expect(await listTabs(createHandlerCtx({ browser, state }))).toEqual([{ id: 'B', number: 2 }]);
    listing.pages = [page('A'), page('B'), page('C')];
    expect(await listTabs(createHandlerCtx({ browser, state }))).toEqual([
      { id: 'A', number: 1 },
      { id: 'B', number: 2 },
      { id: 'C', number: 3 },
    ]);
  });

  it('keeps tab-list lines parseable as `[targetId] url "title"`', async () => {
    const { browser } = makeBrowser([{ ...page('T1', 'https://a/'), title: 'A', active: true }]);
    const { stdout } = await tabListHandler(
      createHandlerCtx({ browser, state: createPlaywrightState() })
    );
    expect(stdout).toBe('[T1] https://a/ "A" (tab 1) (active)\n');
    // The bench adapter's parser (packages/bench/scripts/slicc-adapter.mjs).
    expect([...stdout.matchAll(/^\[([^\]]+)\]\s+(\S+)/gm)].map((m) => [m[1], m[2]])).toEqual([
      ['T1', 'https://a/'],
    ]);
  });

  it('numbers tabs this shell opens in opening order', async () => {
    const { browser, listing } = makeBrowser([page('A')]);
    const state = createPlaywrightState();
    await openHandler(createHandlerCtx({ browser, state, positional: ['https://x.example/'] }));
    // Chrome lists the new tab first; it still gets the next number, after A's.
    listing.pages = [listing.pages[1], page('A')];
    expect(await listTabs(createHandlerCtx({ browser, state }))).toEqual([
      { id: 'NEW1', number: 1 },
      { id: 'A', number: 2 },
    ]);
  });

  it('frees the number mapping when tab-close closes the tab', async () => {
    const { browser } = makeBrowser([page('A'), page('B')]);
    const state = createPlaywrightState();
    await listTabs(createHandlerCtx({ browser, state }));
    await tabCloseHandler(createHandlerCtx({ browser, state, flags: { tab: 'A' } }));
    expect(state.tabNumbers.has('A')).toBe(false);
    expect(await listTabs(createHandlerCtx({ browser, state }))).toEqual([{ id: 'B', number: 2 }]);
  });

  it('looks the SLICC app tab up again once the cached one is gone', async () => {
    const appUrl = 'http://localhost:5710/';
    const { browser } = makeBrowser([page('A'), page('APP2', appUrl)]);
    const state = createPlaywrightState();
    state.appTabId = 'APP1';
    const tabs = await listTabs(createHandlerCtx({ browser, state }));
    expect(tabs.map((t) => t.id)).toEqual(['A']);
    expect(state.appTabId).toBe('APP2');
  });
});

describe('tab-select', () => {
  it('selects by stable number, not list position', async () => {
    const { browser, listing, bringToFront } = makeBrowser([page('A'), page('B'), page('D')]);
    const state = createPlaywrightState();
    await listTabs(createHandlerCtx({ browser, state }));
    // A new tab lands mid-list between the agent's tab-list and tab-select.
    listing.pages = [page('A'), page('E'), page('B'), page('D')];

    const result = await tabSelectHandler(createHandlerCtx({ browser, state, positional: ['3'] }));
    expect(result.stdout).toBe('Selected tab 3 [targetId: D]\n');
    expect(bringToFront).toHaveBeenCalledTimes(1);
  });

  it('selects by targetId', async () => {
    const { browser, bringToFront } = makeBrowser([page('A'), page('B')]);
    const result = await tabSelectHandler(
      createHandlerCtx({ browser, state: createPlaywrightState(), flags: { tab: 'B' } })
    );
    expect(result.stdout).toBe('Selected tab 2 [targetId: B]\n');
    expect(bringToFront).toHaveBeenCalledTimes(1);
  });

  it('rejects a number no open tab has instead of picking a neighbour', async () => {
    const { browser, listing, bringToFront } = makeBrowser([page('A'), page('B')]);
    const state = createPlaywrightState();
    await listTabs(createHandlerCtx({ browser, state }));
    listing.pages = [page('A')];
    const result = await tabSelectHandler(createHandlerCtx({ browser, state, positional: ['2'] }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no open tab is numbered 2');
    expect(bringToFront).not.toHaveBeenCalled();
  });

  it('validates its arguments', async () => {
    const { browser } = makeBrowser([page('A')]);
    const run = (positional: string[], flags: Record<string, string> = {}) =>
      tabSelectHandler(
        createHandlerCtx({ browser, state: createPlaywrightState(), positional, flags })
      );
    expect((await run([])).stderr).toContain('requires a tab number from tab-list or --tab');
    expect((await run(['1'], { tab: 'A' })).stderr).toContain('not both');
    for (const bad of ['0', '-1', 'x', '1.5']) {
      expect((await run([bad])).stderr, bad).toContain('must be a positive integer');
    }
  });
});
