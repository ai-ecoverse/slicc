import { describe, expect, it } from 'vitest';
import {
  generateLocatorHandler,
  highlightHandler,
} from '../../../../../src/shell/supplemental-commands/playwright/handlers/devtools.js';
import type { SnapshotRef } from '../../../../../src/shell/supplemental-commands/playwright/types.js';
import {
  createHandlerCtx,
  createMockBrowser,
  createPlaywrightState,
  makeTabSnapshot,
  snapshotRefs,
} from '../../../helpers/playwright-harness.js';

const TAB = 'tab-1';

function snapshotWithE5(entry: Partial<SnapshotRef> = {}) {
  return makeTabSnapshot({
    refs: new Map([['e5', { role: 'button', name: 'Save', localRef: 'e5', ...entry }]]),
  });
}

function browserWithProps(props: Record<string, unknown>) {
  return createMockBrowser({
    nodeIds: { e5: 1 },
    sendCdpImpl: (method) =>
      method === 'Runtime.callFunctionOn' ? { result: { value: JSON.stringify(props) } } : {},
  });
}

describe('generate-locator handler', () => {
  it('requires a ref, a snapshot, and a known ref', async () => {
    const noRef = await generateLocatorHandler(createHandlerCtx({ flags: { tab: TAB } }));
    expect(noRef.stderr).toContain('requires a ref');

    const noSnap = await generateLocatorHandler(
      createHandlerCtx({ positional: ['e5'], flags: { tab: TAB } })
    );
    expect(noSnap.stderr).toContain('No snapshot available');

    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeTabSnapshot());
    const unknown = await generateLocatorHandler(
      createHandlerCtx({ state, positional: ['e9'], flags: { tab: TAB } })
    );
    expect(unknown.stderr).toContain('Unknown ref');
  });

  it('prefers testId > label > placeholder > id > role and name', async () => {
    const cases: Array<[Record<string, unknown>, Partial<SnapshotRef>, string]> = [
      [{ testId: 'submit' }, {}, 'page.getByTestId("submit")\n'],
      [{ label: 'Email' }, {}, 'page.getByLabel("Email")\n'],
      [{ placeholder: 'Search' }, {}, 'page.getByPlaceholder("Search")\n'],
      [{ id: 'main' }, {}, 'page.locator("#main")\n'],
      [{}, {}, 'page.getByRole("button", { name: "Save" })\n'],
      [{}, { role: 'textbox', name: '' }, 'page.getByRole("textbox")\n'],
    ];
    for (const [props, entry, expected] of cases) {
      const { browser } = browserWithProps(props);
      const state = createPlaywrightState();
      state.snapshots.set(TAB, snapshotWithE5(entry));
      const r = await generateLocatorHandler(
        createHandlerCtx({ browser, state, positional: ['e5'], flags: { tab: TAB } })
      );
      expect(r.stdout).toBe(expected);
    }
  });

  it('fails on a ref whose element left the page', async () => {
    const { browser } = createMockBrowser();
    const state = createPlaywrightState();
    state.snapshots.set(TAB, snapshotWithE5());
    await expect(
      generateLocatorHandler(
        createHandlerCtx({ browser, state, positional: ['e5'], flags: { tab: TAB } })
      )
    ).rejects.toThrow('Ref "e5" (button "Save") is no longer on the page');
  });
});

describe('highlight handler', () => {
  it('removes all highlights with --hide and no ref', async () => {
    const { browser, transport } = createMockBrowser();
    const r = await highlightHandler(
      createHandlerCtx({ browser, flags: { tab: TAB, hide: 'true' } })
    );
    expect(r.stdout).toBe('All highlights removed\n');
    expect(transport.send).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ expression: expect.stringContaining('data-slicc-highlight') }),
      'session-1'
    );
  });

  it('errors without a ref and without --hide', async () => {
    const r = await highlightHandler(createHandlerCtx({ flags: { tab: TAB } }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('requires a ref');
  });

  it('errors without a snapshot', async () => {
    const r = await highlightHandler(createHandlerCtx({ positional: ['e5'], flags: { tab: TAB } }));
    expect(r.stderr).toContain('No snapshot available');
  });

  it('highlights the resolved element', async () => {
    const { browser, sendCDP } = browserWithProps({});
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeTabSnapshot({ refs: snapshotRefs('e5') }));
    const r = await highlightHandler(
      createHandlerCtx({ browser, state, positional: ['e5'], flags: { tab: TAB } })
    );
    expect(r.stdout).toBe('Highlighted e5\n');
    expect(sendCDP).toHaveBeenCalledWith(
      'Runtime.callFunctionOn',
      expect.objectContaining({ objectId: 'obj-e5', arguments: [{ value: expect.any(String) }] })
    );
  });

  it('hides a specific ref', async () => {
    const { browser } = browserWithProps({});
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeTabSnapshot({ refs: snapshotRefs('e5') }));
    const r = await highlightHandler(
      createHandlerCtx({ browser, state, positional: ['e5'], flags: { tab: TAB, hide: 'true' } })
    );
    expect(r.stdout).toBe('Highlight removed from e5\n');
  });

  it('throws when the element left the page', async () => {
    const { browser } = createMockBrowser();
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeTabSnapshot({ refs: snapshotRefs('e5') }));
    await expect(
      highlightHandler(
        createHandlerCtx({ browser, state, positional: ['e5'], flags: { tab: TAB } })
      )
    ).rejects.toThrow('is no longer on the page');
  });

  it('rejects an unknown ref without touching the page', async () => {
    const { browser, page } = createMockBrowser();
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeTabSnapshot());
    const r = await highlightHandler(
      createHandlerCtx({ browser, state, positional: ['e9'], flags: { tab: TAB } })
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Unknown ref "e9"');
    expect(page.resolveAriaRef).not.toHaveBeenCalled();
  });
});
