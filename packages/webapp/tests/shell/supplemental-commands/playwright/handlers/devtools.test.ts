import { describe, expect, it } from 'vitest';
import {
  generateLocatorHandler,
  highlightHandler,
} from '../../../../../src/shell/supplemental-commands/playwright/handlers/devtools.js';
import type { TabSnapshot } from '../../../../../src/shell/supplemental-commands/playwright/types.js';
import {
  createHandlerCtx,
  createMockBrowser,
  createMockTransport,
  createPlaywrightState,
} from '../../../helpers/playwright-harness.js';

const TAB = 'tab-1';

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

/** Browser whose callFunctionOn returns the given element props JSON. */
function browserWithProps(props: Record<string, unknown>) {
  const transport = createMockTransport((method) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'o1' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: JSON.stringify(props) } };
    return {};
  });
  return createMockBrowser({ transport });
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
    state.snapshots.set(TAB, makeSnapshot());
    const unknown = await generateLocatorHandler(
      createHandlerCtx({ state, positional: ['e9'], flags: { tab: TAB } })
    );
    expect(unknown.stderr).toContain('Unknown ref');
  });

  it('returns a CSS locator when only a selector is known', async () => {
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeSnapshot({ refToSelector: new Map([['e5', '#a, .b']]) }));
    const r = await generateLocatorHandler(
      createHandlerCtx({ state, positional: ['e5'], flags: { tab: TAB } })
    );
    expect(r.stdout).toBe('page.locator("#a")\n');
  });

  it('prefers testId > label > placeholder > id > selector', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ testId: 'submit' }, 'page.getByTestId("submit")\n'],
      [{ label: 'Email' }, 'page.getByLabel("Email")\n'],
      [{ placeholder: 'Search' }, 'page.getByPlaceholder("Search")\n'],
      [{ id: 'main' }, 'page.locator("#main")\n'],
      [{}, 'page.locator("#el")\n'],
    ];
    for (const [props, expected] of cases) {
      const { browser } = browserWithProps(props);
      const state = createPlaywrightState();
      state.snapshots.set(
        TAB,
        makeSnapshot({
          refToBackendNodeId: new Map([['e5', 1]]),
          refToSelector: new Map([['e5', '#el']]),
        })
      );
      const r = await generateLocatorHandler(
        createHandlerCtx({ browser, state, positional: ['e5'], flags: { tab: TAB } })
      );
      expect(r.stdout).toBe(expected);
    }
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

  it('highlights via backendNodeId', async () => {
    const { browser } = browserWithProps({});
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeSnapshot({ refToBackendNodeId: new Map([['e5', 1]]) }));
    const r = await highlightHandler(
      createHandlerCtx({ browser, state, positional: ['e5'], flags: { tab: TAB } })
    );
    expect(r.stdout).toBe('Highlighted e5\n');
  });

  it('hides a specific ref via backendNodeId', async () => {
    const { browser } = browserWithProps({});
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeSnapshot({ refToBackendNodeId: new Map([['e5', 1]]) }));
    const r = await highlightHandler(
      createHandlerCtx({ browser, state, positional: ['e5'], flags: { tab: TAB, hide: 'true' } })
    );
    expect(r.stdout).toBe('Highlight removed from e5\n');
  });

  it('highlights via the CSS selector fallback', async () => {
    const { browser, transport } = createMockBrowser();
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeSnapshot({ refToSelector: new Map([['e5', '#z']]) }));
    const r = await highlightHandler(
      createHandlerCtx({ browser, state, positional: ['e5'], flags: { tab: TAB } })
    );
    expect(r.stdout).toBe('Highlighted e5\n');
    expect(transport.send).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ expression: expect.stringContaining('#z') }),
      'session-1'
    );
  });

  it('throws when the element cannot be resolved', async () => {
    const transport = createMockTransport((method) =>
      method === 'DOM.resolveNode' ? { object: {} } : {}
    );
    const { browser } = createMockBrowser({ transport });
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeSnapshot({ refToBackendNodeId: new Map([['e5', 1]]) }));
    await expect(
      highlightHandler(
        createHandlerCtx({ browser, state, positional: ['e5'], flags: { tab: TAB } })
      )
    ).rejects.toThrow('Could not resolve');
  });

  it('throws on an unknown ref with no selector', async () => {
    const { browser } = createMockBrowser();
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeSnapshot());
    await expect(
      highlightHandler(
        createHandlerCtx({ browser, state, positional: ['e9'], flags: { tab: TAB } })
      )
    ).rejects.toThrow('Unknown ref');
  });
});
