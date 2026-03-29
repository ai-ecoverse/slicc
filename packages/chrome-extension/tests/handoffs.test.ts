import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeSentMessages: unknown[] = [];
const storageState = new Map<string, unknown>();

async function readLocalStorage(
  keys?: string | string[] | Record<string, unknown> | null
): Promise<Record<string, unknown>> {
  if (typeof keys === 'string') {
    return { [keys]: storageState.get(keys) };
  }
  if (Array.isArray(keys)) {
    return Object.fromEntries(keys.map((key) => [key, storageState.get(key)]));
  }
  if (keys && typeof keys === 'object') {
    return Object.fromEntries(
      Object.entries(keys).map(([key, defaultValue]) => [
        key,
        storageState.get(key) ?? defaultValue,
      ])
    );
  }
  return Object.fromEntries(storageState.entries());
}

function createChromeMock() {
  return {
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
    runtime: {
      sendMessage: vi.fn(async (message: unknown) => {
        runtimeSentMessages.push(message);
      }),
    },
    storage: {
      local: {
        get: vi.fn(readLocalStorage),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            storageState.set(key, value);
          }
        }),
      },
    },
    tabs: {
      query: vi.fn(async () => []),
      remove: vi.fn(async () => undefined),
    },
  };
}

function buildHandoffUrl(
  payload: Record<string, unknown>,
  origin = 'https://www.sliccy.ai'
): string {
  return `${origin}/handoff#${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadHandoffsModule(): Promise<typeof import('../src/handoffs.js')> {
  return import('../src/handoffs.js');
}

describe('handoff queue', () => {
  beforeEach(() => {
    runtimeSentMessages.length = 0;
    storageState.clear();
    vi.clearAllMocks();
    vi.resetModules();

    (
      globalThis as typeof globalThis & {
        chrome: ReturnType<typeof createChromeMock>;
      }
    ).chrome = createChromeMock() as never;
  });

  it('captures matching handoff tabs, persists them, and updates the badge', async () => {
    const handoffs = await loadHandoffsModule();
    const url = buildHandoffUrl({
      title: 'Verify signup',
      instruction: 'Check whether signup works.',
      urls: ['https://example.com/signup'],
      acceptanceCriteria: ['Form loads', 'Submit succeeds'],
    });

    handoffs.handleUpdatedTabHandoff({ url }, { id: 42, url });
    await flushAsync();

    const stored = storageState.get('slicc.pendingHandoffs') as Array<any>;
    expect(stored).toHaveLength(1);
    expect(stored[0].sourceTabId).toBe(42);
    expect(stored[0].payload).toMatchObject({
      title: 'Verify signup',
      instruction: 'Check whether signup works.',
    });
    expect((globalThis as any).chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '1' });
    expect(runtimeSentMessages).toContainEqual({
      source: 'service-worker',
      payload: {
        type: 'handoff-pending-list',
        handoffs: expect.arrayContaining([
          expect.objectContaining({
            handoffId: expect.stringMatching(/^handoff-/),
            payload: expect.objectContaining({ instruction: 'Check whether signup works.' }),
          }),
        ]),
      },
    });
  });

  it('ignores non-matching handoff tabs', async () => {
    const handoffs = await loadHandoffsModule();

    handoffs.handleUpdatedTabHandoff({ url: 'https://www.sliccy.ai/handoff#abc' }, { id: 7 });
    handoffs.handleCreatedTabHandoff({ id: 8, url: 'https://www.sliccy.ai/other#abc' });
    await flushAsync();

    expect(storageState.get('slicc.pendingHandoffs')).toBeUndefined();
    expect(runtimeSentMessages).not.toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ type: 'handoff-pending-list' }),
      })
    );
  });

  it('rejects localhost handoff tabs', async () => {
    const handoffs = await loadHandoffsModule();
    const localhostUrl = buildHandoffUrl(
      { instruction: 'Ignore localhost handoff detection.' },
      'http://localhost:8787'
    );

    handoffs.handleUpdatedTabHandoff({ url: localhostUrl }, { id: 33, url: localhostUrl });
    await flushAsync();
    expect(storageState.get('slicc.pendingHandoffs')).toBeUndefined();
  });

  it('dedupes repeated tab events for the same handoff payload', async () => {
    const handoffs = await loadHandoffsModule();
    const url = buildHandoffUrl({ instruction: 'Run the same handoff twice.' });

    handoffs.handleCreatedTabHandoff({ id: 12, url });
    handoffs.handleUpdatedTabHandoff({ url }, { id: 12, url });
    await flushAsync();

    const stored = storageState.get('slicc.pendingHandoffs') as Array<any>;
    expect(stored).toHaveLength(1);
  });

  it('serializes concurrent handoff arrivals so different tabs are not lost', async () => {
    const chromeMock = (globalThis as any).chrome;
    chromeMock.storage.local.get.mockImplementation(
      async (keys?: string | string[] | Record<string, unknown> | null) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return readLocalStorage(keys);
      }
    );

    const handoffs = await loadHandoffsModule();
    handoffs.handleUpdatedTabHandoff(
      { url: buildHandoffUrl({ instruction: 'First concurrent handoff.' }) },
      { id: 12 }
    );
    handoffs.handleUpdatedTabHandoff(
      { url: buildHandoffUrl({ instruction: 'Second concurrent handoff.' }) },
      { id: 13 }
    );
    await flushAsync();
    await flushAsync();

    const stored = storageState.get('slicc.pendingHandoffs') as Array<any>;
    expect(stored).toHaveLength(2);
    expect(stored.map((item) => item.payload.instruction)).toEqual([
      'First concurrent handoff.',
      'Second concurrent handoff.',
    ]);
  });

  it('scans already-open handoff tabs when initialized', async () => {
    const chromeMock = (globalThis as any).chrome;
    chromeMock.tabs.query.mockResolvedValue([
      {
        id: 77,
        url: buildHandoffUrl({ instruction: 'Pick me up from an already open tab.' }),
      },
    ]);

    const handoffs = await loadHandoffsModule();
    handoffs.initializeHandoffs();
    await flushAsync();

    const stored = storageState.get('slicc.pendingHandoffs') as Array<any>;
    expect(stored).toHaveLength(1);
    expect(stored[0].sourceTabId).toBe(77);
  });

  it('publishes the current pending handoff list when requested by the panel', async () => {
    const handoffs = await loadHandoffsModule();
    const url = buildHandoffUrl({ instruction: 'Send me the current queue.' });
    handoffs.handleUpdatedTabHandoff({ url }, { id: 5, url });
    await flushAsync();
    runtimeSentMessages.length = 0;

    handoffs.handlePanelHandoffMessage({ type: 'handoff-list-request' });
    await flushAsync();

    expect(runtimeSentMessages).toContainEqual({
      source: 'service-worker',
      payload: {
        type: 'handoff-pending-list',
        handoffs: expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({ instruction: 'Send me the current queue.' }),
          }),
        ]),
      },
    });
  });

  it('clears a pending handoff and closes the source tab when dismissed or accepted', async () => {
    const handoffs = await loadHandoffsModule();
    const url = buildHandoffUrl({ instruction: 'Clear this handoff.' });
    handoffs.handleUpdatedTabHandoff({ url }, { id: 21, url });
    await flushAsync();

    const stored = storageState.get('slicc.pendingHandoffs') as Array<any>;
    const handoffId = stored[0].handoffId as string;

    handoffs.handlePanelHandoffMessage({ type: 'handoff-dismiss', handoffId });
    await flushAsync();

    expect(storageState.get('slicc.pendingHandoffs')).toEqual([]);
    expect((globalThis as any).chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
    expect((globalThis as any).chrome.tabs.remove).toHaveBeenCalledWith(21);

    handoffs.handleUpdatedTabHandoff({ url }, { id: 21, url });
    await flushAsync();
    const storedAgain = storageState.get('slicc.pendingHandoffs') as Array<any>;
    handoffs.handlePanelHandoffMessage({
      type: 'handoff-accept',
      handoffId: storedAgain[0].handoffId,
    });
    await flushAsync();

    expect(storageState.get('slicc.pendingHandoffs')).toEqual([]);
    expect((globalThis as any).chrome.tabs.remove).toHaveBeenCalledTimes(2);
  });
});
