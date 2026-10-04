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
import {
  createHandlerCtx,
  createPlaywrightState,
  makeTabSnapshot,
  resolveAriaRefMock,
  snapshotRefs,
} from '../../../helpers/playwright-harness.js';

const TAB = 'tab-1';

function makeSnapshot(...printed: string[]): TabSnapshot {
  return makeTabSnapshot({ refs: snapshotRefs(...printed) });
}

function stateWithSnapshot(snapshot?: TabSnapshot): PlaywrightState {
  const state = createPlaywrightState();
  if (snapshot) state.snapshots.set(TAB, snapshot);
  return state;
}

function makeBrowser(nodeIds: Record<string, number> = {}) {
  const send = vi.fn(async (_m: string, _p?: Record<string, unknown>) => {
    if (_m === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
    if (_m === 'Runtime.callFunctionOn') return { result: { value: '' } };
    return {};
  });
  const spies = {
    send,
    resolveAriaRef: resolveAriaRefMock(nodeIds),
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

  const page = {
    targetId: TAB,
    sessionId: 'session-1',
    transport: { send },
    send: (method: string, params?: Record<string, unknown>) => send(method, params),
    resolveAriaRef: spies.resolveAriaRef,
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
  };
  const browser = {
    withTab: async <T>(_t: string, fn: (tab: typeof page) => Promise<T>) => fn(page),
    getTransport: () => ({ send }),
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
  it('clicks the element the ref resolves to and invalidates the snapshot', async () => {
    const { browser, spies } = makeBrowser({ e5: 42 });
    const state = stateWithSnapshot(makeSnapshot('e5'));
    const result = await clickHandler(
      createHandlerCtx({
        browser,
        state,
        positional: ['e5'],
        flags: { tab: TAB, modifiers: 'Shift,Meta' },
      })
    );
    expect(result.stdout).toBe('Clicked e5\n');
    expect(spies.resolveAriaRef).toHaveBeenCalledWith('e5', undefined);
    expect(spies.clickByBackendNodeId).toHaveBeenCalledWith(42, 12);
    expect(state.snapshots.has(TAB)).toBe(false);
  });

  it('clicks the third of three same-named button refs', async () => {
    const { browser, spies } = makeBrowser({ e1: 101, e2: 102, e3: 103 });
    const result = await clickHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(makeSnapshot('e1', 'e2', 'e3')),
        positional: ['e3'],
        flags: { tab: TAB },
      })
    );
    expect(result.stdout).toBe('Clicked e3\n');
    expect(spies.clickByBackendNodeId).toHaveBeenCalledTimes(1);
    expect(spies.clickByBackendNodeId).toHaveBeenCalledWith(103, 0);
  });

  it('clicks an iframe ref in its own frame', async () => {
    const { browser, spies } = makeBrowser({ e5: 9 });
    const result = await clickHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(makeSnapshot('f1e5')),
        positional: ['f1e5'],
        flags: { tab: TAB },
      })
    );
    expect(result.stdout).toContain('(in iframe)');
    expect(spies.resolveAriaRef).toHaveBeenCalledWith('e5', 'frame-1');
    expect(spies.send).toHaveBeenCalledWith(
      'Runtime.callFunctionOn',
      expect.objectContaining({ objectId: 'obj-e5' })
    );
    expect(spies.clickByBackendNodeId).not.toHaveBeenCalled();
  });

  it('refuses a ref whose element left the page', async () => {
    const { browser, spies } = makeBrowser({});
    await expect(
      clickHandler(
        createHandlerCtx({
          browser,
          state: stateWithSnapshot(makeSnapshot('e31')),
          positional: ['e31'],
          flags: { tab: TAB },
        })
      )
    ).rejects.toThrow('Ref "e31" (button) is no longer on the page');
    expect(spies.clickByBackendNodeId).not.toHaveBeenCalled();
    expect(spies.click).not.toHaveBeenCalled();
  });

  it('rejects an unknown ref and a missing snapshot', async () => {
    const { browser, spies } = makeBrowser({ e9: 1 });
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
    expect(spies.resolveAriaRef).not.toHaveBeenCalled();

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

const ENTER_KEY_DOWN = {
  type: 'keyDown' as const,
  key: 'Enter',
  code: 'Enter',
  windowsVirtualKeyCode: 13,
  text: '\r',
  unmodifiedText: '\r',
};
const ENTER_KEY_UP = {
  type: 'keyUp' as const,
  key: 'Enter',
  code: 'Enter',
  windowsVirtualKeyCode: 13,
};

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
    expect(spies.send).toHaveBeenCalledWith('Input.dispatchKeyEvent', ENTER_KEY_DOWN);
    expect(spies.send).toHaveBeenCalledWith('Input.dispatchKeyEvent', ENTER_KEY_UP);
  });

  it('press Enter sends text and keyCode so forms can submit', async () => {
    const { browser, spies } = makeBrowser();
    const result = await pressHandler(
      createHandlerCtx({ browser, positional: ['Enter'], flags: { tab: TAB } })
    );
    expect(result.stdout).toBe('Pressed Enter\n');
    expect(spies.send).toHaveBeenCalledWith('Input.dispatchKeyEvent', ENTER_KEY_DOWN, 'session-1');
    expect(spies.send).toHaveBeenCalledWith('Input.dispatchKeyEvent', ENTER_KEY_UP, 'session-1');
  });

  it('press dispatches keyDown + keyUp with key codes for Escape', async () => {
    const { browser, spies } = makeBrowser();
    const result = await pressHandler(
      createHandlerCtx({ browser, positional: ['Escape'], flags: { tab: TAB } })
    );
    expect(result.stdout).toBe('Pressed Escape\n');
    expect(spies.send).toHaveBeenCalledWith(
      'Input.dispatchKeyEvent',
      {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      },
      'session-1'
    );
    expect(spies.send).toHaveBeenCalledTimes(2);
  });

  it('keydown and keyup dispatch a single event each', async () => {
    const { browser, spies } = makeBrowser();
    await keydownHandler(createHandlerCtx({ browser, positional: ['A'], flags: { tab: TAB } }));
    await keyupHandler(createHandlerCtx({ browser, positional: ['A'], flags: { tab: TAB } }));
    expect(spies.send).toHaveBeenCalledTimes(2);
    expect(spies.send).toHaveBeenCalledWith(
      'Input.dispatchKeyEvent',
      {
        type: 'keyDown',
        key: 'A',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        text: 'A',
        unmodifiedText: 'A',
      },
      'session-1'
    );
  });
});

describe('fillHandler', () => {
  it('fills the resolved element with the React fallback and submits', async () => {
    const { browser, spies } = makeBrowser({ e5: 7 });
    const state = stateWithSnapshot(makeSnapshot('e5'));
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

    expect(spies.send).toHaveBeenCalledWith(
      'Runtime.callFunctionOn',
      expect.objectContaining({ arguments: [{ value: 'secret value' }] })
    );

    expect(spies.send).toHaveBeenCalledWith('Input.dispatchKeyEvent', ENTER_KEY_DOWN);
    expect(spies.send).toHaveBeenCalledWith('Input.dispatchKeyEvent', ENTER_KEY_UP);
    expect(state.snapshots.has(TAB)).toBe(false);
  });

  it('fills an iframe ref in its own frame', async () => {
    const { browser, spies } = makeBrowser({ e2: 5 });
    const result = await fillHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(makeSnapshot('f3e2')),
        positional: ['f3e2', 'text'],
        flags: { tab: TAB },
      })
    );
    expect(result.stdout).toBe('Filled f3e2 with: text (in iframe)\n');
    expect(spies.resolveAriaRef).toHaveBeenCalledWith('e2', 'frame-3');
    expect(spies.send).toHaveBeenCalledWith(
      'Runtime.callFunctionOn',
      expect.objectContaining({ objectId: 'obj-e2', arguments: [{ value: 'text' }] })
    );
    expect(spies.insertText).not.toHaveBeenCalled();
  });

  it('fails loudly on a stale ref instead of filling a neighbour', async () => {
    const { browser, spies } = makeBrowser({ e31: 8 });
    await expect(
      fillHandler(
        createHandlerCtx({
          browser,
          state: stateWithSnapshot(makeSnapshot('e30', 'e31')),
          positional: ['e30', 'Trieloff'],
          flags: { tab: TAB },
        })
      )
    ).rejects.toThrow('Ref "e30" (button) is no longer on the page');
    expect(spies.insertText).not.toHaveBeenCalled();
  });
});

describe('pointer + form handlers', () => {
  it('dblclick uses the resolved backend node', async () => {
    const { browser, spies } = makeBrowser({ e5: 3 });
    const result = await dblclickHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(makeSnapshot('e5')),
        positional: ['e5'],
        flags: { tab: TAB },
      })
    );
    expect(result.stdout).toBe('Double-clicked e5\n');
    expect(spies.dblclickByBackendNodeId).toHaveBeenCalledWith(3, 'left', 0);
  });

  it('hover uses the resolved backend node', async () => {
    const { browser, spies } = makeBrowser({ e5: 3 });
    const result = await hoverHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(makeSnapshot('e5')),
        positional: ['e5'],
        flags: { tab: TAB },
      })
    );
    expect(result.stdout).toBe('Hovered e5\n');
    expect(spies.hoverByBackendNodeId).toHaveBeenCalledWith(3);
  });

  it('select sets a value on the resolved backend node', async () => {
    const { browser, spies } = makeBrowser({ e5: 3 });
    const result = await selectHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(makeSnapshot('e5')),
        positional: ['e5', 'opt', 'two'],
        flags: { tab: TAB },
      })
    );
    expect(result.stdout).toBe('Selected "opt two" on e5\n');
    expect(spies.selectByBackendNodeId).toHaveBeenCalledWith(3, 'opt two');
  });

  it('iframe dblclick, hover, and select run on the frame element', async () => {
    for (const [handler, positional, expected] of [
      [dblclickHandler, ['f1e4'], 'Double-clicked f1e4 (in iframe)\n'],
      [hoverHandler, ['f1e4'], 'Hovered f1e4 (in iframe)\n'],
      [selectHandler, ['f1e4', 'b'], 'Selected "b" on f1e4 (in iframe)\n'],
    ] as const) {
      const { browser, spies } = makeBrowser({ e4: 4 });
      const result = await handler(
        createHandlerCtx({
          browser,
          state: stateWithSnapshot(makeSnapshot('f1e4')),
          positional: [...positional],
          flags: { tab: TAB },
        })
      );
      expect(result.stdout).toBe(expected);
      expect(spies.send).toHaveBeenCalledWith(
        'Runtime.callFunctionOn',
        expect.objectContaining({ objectId: 'obj-e4' })
      );
    }
  });

  it('check reports toggled vs already-checked', async () => {
    const { browser, spies } = makeBrowser({ e5: 3 });
    const toggled = await checkHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(makeSnapshot('e5')),
        positional: ['e5'],
        flags: { tab: TAB },
      })
    );
    expect(toggled.stdout).toBe('Checked e5\n');

    spies.setCheckedByBackendNodeId.mockResolvedValueOnce('already');
    const state = stateWithSnapshot(makeSnapshot('e5'));
    const already = await checkHandler(
      createHandlerCtx({ browser, state, positional: ['e5'], flags: { tab: TAB } })
    );
    expect(already.stdout).toBe('e5 already checked\n');

    expect(state.snapshots.has(TAB)).toBe(true);
  });

  it('uncheck reports toggled state', async () => {
    const { browser, spies } = makeBrowser({ e5: 3 });
    const result = await uncheckHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(makeSnapshot('e5')),
        positional: ['e5'],
        flags: { tab: TAB },
      })
    );
    expect(result.stdout).toBe('Unchecked e5\n');
    expect(spies.setCheckedByBackendNodeId).toHaveBeenCalledWith(3, false);
  });

  it('iframe check/uncheck toggle in the frame and report no-ops', async () => {
    const { browser, spies } = makeBrowser({ e4: 4 });
    spies.send.mockImplementation(async (method: string) =>
      method === 'Runtime.callFunctionOn' ? { result: { value: 'toggled' } } : {}
    );
    const checked = await checkHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(makeSnapshot('f1e4')),
        positional: ['f1e4'],
        flags: { tab: TAB },
      })
    );
    expect(checked.stdout).toBe('Checked f1e4 (in iframe)\n');
    expect(spies.send).toHaveBeenCalledWith(
      'Runtime.callFunctionOn',
      expect.objectContaining({ objectId: 'obj-e4', arguments: [{ value: true }] })
    );

    spies.send.mockImplementation(async (method: string) =>
      method === 'Runtime.callFunctionOn' ? { result: { value: 'already' } } : {}
    );
    const already = await uncheckHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(makeSnapshot('f1e4')),
        positional: ['f1e4'],
        flags: { tab: TAB },
      })
    );
    expect(already.stdout).toBe('f1e4 already unchecked\n');
  });

  it('drag connects two resolved nodes and rejects missing endpoints', async () => {
    const { browser, spies } = makeBrowser({ e1: 1, e2: 2 });
    const ok = await dragHandler(
      createHandlerCtx({
        browser,
        state: stateWithSnapshot(makeSnapshot('e1', 'e2')),
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
          state: stateWithSnapshot(makeSnapshot('e2')),
          positional: ['e1', 'e2'],
          flags: { tab: TAB },
        })
      )
    ).rejects.toThrow('Unknown ref "e1"');
  });

  it('drag refuses iframe refs (their coordinates live in another frame)', async () => {
    const { browser, spies } = makeBrowser({ e1: 1, e2: 2 });
    await expect(
      dragHandler(
        createHandlerCtx({
          browser,
          state: stateWithSnapshot(makeSnapshot('e1', 'f1e2')),
          positional: ['e1', 'f1e2'],
          flags: { tab: TAB },
        })
      )
    ).rejects.toThrow('drag does not support iframe refs ("f1e2")');
    expect(spies.dragByBackendNodeIds).not.toHaveBeenCalled();
  });
});
