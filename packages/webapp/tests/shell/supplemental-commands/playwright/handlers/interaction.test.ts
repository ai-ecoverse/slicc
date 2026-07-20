import { describe, expect, it, vi } from 'vitest';
import type { BrowserAPI } from '../../../../../src/cdp/index.js';
import {
  checkHandler,
  clickHandler,
  dblclickHandler,
  dragHandler,
  fillHandler,
  hoverHandler,
  keydownHandler,
  keyupHandler,
  pressHandler,
  selectHandler,
  typeHandler,
  uncheckHandler,
} from '../../../../../src/shell/supplemental-commands/playwright/handlers/interaction.js';
import type {
  PlaywrightState,
  TabSnapshot,
} from '../../../../../src/shell/supplemental-commands/playwright/types.js';
import { createHandlerCtx, createPlaywrightState } from '../../../helpers/playwright-harness.js';

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

function stateWithSnapshot(snapshot?: TabSnapshot): PlaywrightState {
  const state = createPlaywrightState();
  if (snapshot) state.snapshots.set(TAB, snapshot);
  return state;
}

/** A fully-spied BrowserAPI covering every method the interaction handlers touch. */
function makeBrowser() {
  const send = vi.fn(async (_m: string, _p?: Record<string, unknown>) => {
    if (_m === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
    if (_m === 'Runtime.callFunctionOn') return { result: { value: '' } };
    return {};
  });
  const spies = {
    send,
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    insertText: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => ''),
    evaluateInFrame: vi.fn(async () => undefined),
    clickByBackendNodeId: vi.fn(async () => undefined),
    dblclickByBackendNodeId: vi.fn(async () => undefined),
    hoverByBackendNodeId: vi.fn(async () => undefined),
    selectByBackendNodeId: vi.fn(async () => undefined),
    dragByBackendNodeIds: vi.fn(async () => undefined),
    setCheckedByBackendNodeId: vi.fn(async (): Promise<'toggled' | 'already'> => 'toggled'),
  };
  const browser = {
    withTab: async <T>(_t: string, fn: (sessionId: string) => Promise<T>) => fn('session-1'),
    getTransport: () => ({ send }),
    getSessionId: () => 'session-1',
    click: spies.click,
    type: spies.type,
    insertText: spies.insertText,
    evaluate: spies.evaluate,
    evaluateInFrame: spies.evaluateInFrame,
    clickByBackendNodeId: spies.clickByBackendNodeId,
    dblclickByBackendNodeId: spies.dblclickByBackendNodeId,
    hoverByBackendNodeId: spies.hoverByBackendNodeId,
    selectByBackendNodeId: spies.selectByBackendNodeId,
    dragByBackendNodeIds: spies.dragByBackendNodeIds,
    setCheckedByBackendNodeId: spies.setCheckedByBackendNodeId,
  } as unknown as BrowserAPI;
  return { browser, spies };
}

describe('interaction handlers — argument validation', () => {
  it('each handler rejects missing positionals', async () => {
    const cases: Array<[(ctx: never) => Promise<{ stderr: string }>, string]> = [
      [clickHandler as never, 'click requires a ref'],
      [typeHandler as never, 'type requires text'],
      [fillHandler as never, 'fill requires <ref> <text>'],
      [pressHandler as never, 'press requires a key name'],
      [keydownHandler as never, 'keydown requires a key name'],
      [keyupHandler as never, 'keyup requires a key name'],
      [dblclickHandler as never, 'dblclick requires a ref'],
      [hoverHandler as never, 'hover requires a ref'],
      [selectHandler as never, 'select requires <ref> <value>'],
      [checkHandler as never, 'check requires a ref'],
      [uncheckHandler as never, 'uncheck requires a ref'],
      [dragHandler as never, 'drag requires <startRef> <endRef>'],
    ];
    for (const [handler, message] of cases) {
      const result = await handler(createHandlerCtx() as never);
      expect(result.stderr).toContain(message);
    }
  });

  it('handlers require a --tab flag', async () => {
    const result = await clickHandler(createHandlerCtx({ positional: ['e5'] }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--tab');
  });
});

describe('clickHandler', () => {
  it('clicks via backendNodeId and invalidates the snapshot', async () => {
    const { browser, spies } = makeBrowser();
    const snapshot = makeSnapshot({ refToBackendNodeId: new Map([['e5', 42]]) });
    const state = stateWithSnapshot(snapshot);
    const result = await clickHandler(
      createHandlerCtx({ browser, state, positional: ['e5'], flags: { tab: TAB } })
    );
    expect(result.stdout).toBe('Clicked e5\n');
    expect(spies.clickByBackendNodeId).toHaveBeenCalledWith(42, 0);
    expect(state.snapshots.has(TAB)).toBe(false);
  });

  it('falls back to a CSS selector and parses --modifiers', async () => {
    const { browser, spies } = makeBrowser();
    const snapshot = makeSnapshot({ refToSelector: new Map([['e5', '#btn']]) });
    const result = await clickHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(snapshot),
        positional: ['e5'],
        flags: { tab: TAB, modifiers: 'Shift,Meta' },
      })
    );
    expect(result.stdout).toBe('Clicked e5\n');
    expect(spies.click).toHaveBeenCalledWith('#btn', 12); // Shift(8)|Meta(4)
  });

  it('routes clicks into an iframe ref', async () => {
    const { browser, spies } = makeBrowser();
    const snapshot = makeSnapshot({
      refToFrameId: new Map([['f1e5', 'frame-1']]),
      refToSelector: new Map([['f1e5', '#a']]),
    });
    const result = await clickHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(snapshot),
        positional: ['f1e5'],
        flags: { tab: TAB },
      })
    );
    expect(result.stdout).toContain('(in iframe)');
    expect(spies.evaluateInFrame).toHaveBeenCalled();
  });

  it('rejects an unknown ref and a missing snapshot', async () => {
    const { browser } = makeBrowser();
    await expect(
      clickHandler(
        createHandlerCtx({
          browser,
          state: stateWithSnapshot(makeSnapshot()),
          positional: ['e9'],
          flags: { tab: TAB },
        })
      )
    ).rejects.toThrow('Unknown ref');

    await expect(
      clickHandler(
        createHandlerCtx({
          browser,
          state: createPlaywrightState(),
          positional: ['e5'],
          flags: { tab: TAB },
        })
      )
    ).rejects.toThrow('No snapshot');
  });
});

describe('keyboard + type handlers', () => {
  it('types text and submits with Enter', async () => {
    const { browser, spies } = makeBrowser();
    const result = await typeHandler(
      createHandlerCtx({
        browser,
        positional: ['hello', 'world'],
        flags: { tab: TAB, submit: 'true' },
      })
    );
    expect(result.stdout).toBe('Typed: hello world\n');
    expect(spies.type).toHaveBeenCalledWith('hello world');
    expect(spies.send).toHaveBeenCalledWith(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', key: 'Enter' },
      'session-1'
    );
  });

  it('press dispatches keyDown + keyUp', async () => {
    const { browser, spies } = makeBrowser();
    const result = await pressHandler(
      createHandlerCtx({ browser, positional: ['Escape'], flags: { tab: TAB } })
    );
    expect(result.stdout).toBe('Pressed Escape\n');
    expect(spies.send).toHaveBeenCalledTimes(2);
  });

  it('keydown and keyup dispatch a single event each', async () => {
    const { browser, spies } = makeBrowser();
    await keydownHandler(createHandlerCtx({ browser, positional: ['A'], flags: { tab: TAB } }));
    await keyupHandler(createHandlerCtx({ browser, positional: ['A'], flags: { tab: TAB } }));
    expect(spies.send).toHaveBeenCalledTimes(2);
  });
});

describe('fillHandler', () => {
  it('fills via backendNodeId with the React fallback and submits', async () => {
    const { browser, spies } = makeBrowser();
    const snapshot = makeSnapshot({ refToBackendNodeId: new Map([['e5', 7]]) });
    const state = stateWithSnapshot(snapshot);
    const result = await fillHandler(
      createHandlerCtx({
        browser,
        state,
        positional: ['e5', 'secret', 'value'],
        flags: { tab: TAB, submit: 'true' },
      })
    );
    expect(result.stdout).toBe('Filled e5 with: secret value\n');
    expect(spies.clickByBackendNodeId).toHaveBeenCalledWith(7);
    expect(spies.insertText).toHaveBeenCalledWith('secret value');
    expect(state.snapshots.has(TAB)).toBe(false);
  });

  it('fills via the CSS selector fallback', async () => {
    const { browser, spies } = makeBrowser();
    const snapshot = makeSnapshot({ refToSelector: new Map([['e5', '#in']]) });
    const result = await fillHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(snapshot),
        positional: ['e5', 'text'],
        flags: { tab: TAB },
      })
    );
    expect(result.stdout).toBe('Filled e5 with: text\n');
    expect(spies.click).toHaveBeenCalledWith('#in');
    expect(spies.insertText).toHaveBeenCalledWith('text');
  });
});

describe('pointer + form handlers', () => {
  it('dblclick uses backendNodeId', async () => {
    const { browser, spies } = makeBrowser();
    const snapshot = makeSnapshot({ refToBackendNodeId: new Map([['e5', 3]]) });
    const result = await dblclickHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(snapshot),
        positional: ['e5'],
        flags: { tab: TAB },
      })
    );
    expect(result.stdout).toBe('Double-clicked e5\n');
    expect(spies.dblclickByBackendNodeId).toHaveBeenCalledWith(3, 'left', 0);
  });

  it('hover uses backendNodeId', async () => {
    const { browser, spies } = makeBrowser();
    const snapshot = makeSnapshot({ refToBackendNodeId: new Map([['e5', 3]]) });
    const result = await hoverHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(snapshot),
        positional: ['e5'],
        flags: { tab: TAB },
      })
    );
    expect(result.stdout).toBe('Hovered e5\n');
    expect(spies.hoverByBackendNodeId).toHaveBeenCalledWith(3);
  });

  it('select sets a value by backendNodeId', async () => {
    const { browser, spies } = makeBrowser();
    const snapshot = makeSnapshot({ refToBackendNodeId: new Map([['e5', 3]]) });
    const result = await selectHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(snapshot),
        positional: ['e5', 'opt', 'two'],
        flags: { tab: TAB },
      })
    );
    expect(result.stdout).toBe('Selected "opt two" on e5\n');
    expect(spies.selectByBackendNodeId).toHaveBeenCalledWith(3, 'opt two');
  });

  it('check reports toggled vs already-checked', async () => {
    const { browser, spies } = makeBrowser();
    const snapshot = makeSnapshot({ refToBackendNodeId: new Map([['e5', 3]]) });
    const toggled = await checkHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(snapshot),
        positional: ['e5'],
        flags: { tab: TAB },
      })
    );
    expect(toggled.stdout).toBe('Checked e5\n');

    spies.setCheckedByBackendNodeId.mockResolvedValueOnce('already');
    const already = await checkHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(snapshot),
        positional: ['e5'],
        flags: { tab: TAB },
      })
    );
    expect(already.stdout).toBe('e5 already checked\n');
  });

  it('uncheck reports toggled state', async () => {
    const { browser, spies } = makeBrowser();
    const snapshot = makeSnapshot({ refToBackendNodeId: new Map([['e5', 3]]) });
    const result = await uncheckHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(snapshot),
        positional: ['e5'],
        flags: { tab: TAB },
      })
    );
    expect(result.stdout).toBe('Unchecked e5\n');
    expect(spies.setCheckedByBackendNodeId).toHaveBeenCalledWith(3, false);
  });

  it('drag connects two backendNodeIds and rejects missing endpoints', async () => {
    const { browser, spies } = makeBrowser();
    const snapshot = makeSnapshot({
      refToBackendNodeId: new Map([
        ['e1', 1],
        ['e2', 2],
      ]),
    });
    const ok = await dragHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(snapshot),
        positional: ['e1', 'e2'],
        flags: { tab: TAB },
      })
    );
    expect(ok.stdout).toBe('Dragged e1 to e2\n');
    expect(spies.dragByBackendNodeIds).toHaveBeenCalledWith(1, 2);

    await expect(
      dragHandler(
        createHandlerCtx({
          browser,
          state: stateWithSnapshot(makeSnapshot({ refToBackendNodeId: new Map([['e2', 2]]) })),
          positional: ['e1', 'e2'],
          flags: { tab: TAB },
        })
      )
    ).rejects.toThrow('Unknown ref "e1"');
  });
});
