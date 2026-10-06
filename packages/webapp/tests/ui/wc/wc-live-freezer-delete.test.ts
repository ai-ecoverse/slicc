// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

const mockDelete = vi.fn(async (..._args: unknown[]) => ({ status: 'deleted' as const }));
vi.mock('../../../src/ui/frozen-session-delete.js', () => ({
  deleteFrozenSession: (...args: unknown[]) => mockDelete(...args),
}));

import type { RegisteredScoop } from '../../../src/scoops/types.js';
import type { OffscreenClient } from '../../../src/ui/offscreen-client.js';
import { wireFreezerRail } from '../../../src/ui/wc/wc-live-freezer.js';
import { recordToWorkUnitSummary } from '../../../src/work-unit/client/from-record.js';

const research = {
  jid: 'cone_2',
  name: 'Research',
  folder: 'cone-research',
  isCone: true,
  type: 'cone',
  requiresTrigger: false,
  assistantLabel: 'Research',
  addedAt: '2026-01-02T00:00:00.000Z',
  parentJid: null,
} as unknown as RegisteredScoop;

const FILE = '2026-06-01T10-00-00Z-fix-build.md';
const LIVE = 'live-cone-x1.md';
const INDEX = [
  {
    filename: FILE,
    sessionId: 'sid-a',
    title: 'Fix the build',
    frozenAt: '2026-06-01T10:00:00Z',
    messageCount: 1,
    cone: 'cone-research',
  },
  {
    filename: LIVE,
    sessionId: 'sid-live',
    title: 'In progress',
    frozenAt: '2026-06-02T10:00:00Z',
    messageCount: 1,
    live: true,
  },
];
const ARCHIVE = [
  '---',
  'title: "Fix the build"',
  '---',
  '<!-- slicc:session-data',
  JSON.stringify([{ id: 'u1', role: 'user', content: 'fix the build', timestamp: 1 }]),
  '-->',
  '',
  '# Fix the build',
  '',
].join('\n');

function archiveFor(title: string): string {
  return [
    '---',
    `title: "${title}"`,
    '---',
    '<!-- slicc:session-data',
    JSON.stringify([{ id: 'u1', role: 'user', content: title, timestamp: 1 }]),
    '-->',
    '',
    `# ${title}`,
    '',
  ].join('\n');
}

function harness(
  opts: { index?: readonly Record<string, unknown>[]; archives?: Record<string, string> } = {}
) {
  const index = opts.index ?? INDEX;
  const archives = opts.archives ?? { [FILE]: ARCHIVE };
  document.body.replaceChildren();
  const freezer = document.createElement('slicc-freezer');
  document.body.append(freezer);
  const files = new Map<string, string>([
    ['/sessions/index.json', JSON.stringify(index)],
    ...Object.entries(archives).map(([name, content]) => [`/sessions/${name}`, content] as const),
  ]);
  const reader = {
    readFile: async (path: string) => {
      const text = files.get(path);
      if (text === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      return text;
    },
    readDir: async () => [],
  };
  const controller = { loadMessages: vi.fn() };
  const selectScoop = vi.fn();
  const unit = recordToWorkUnitSummary(research, {});
  const refs = {
    freezer,
    thread: document.createElement('slicc-thread'),
    inputCard: document.createElement('slicc-input-card'),
    switcher: document.createElement('slicc-switcher'),
    shader: document.createElement('slicc-shader'),
    frame: document.createElement('div'),
  };
  const handles = wireFreezerRail({
    refs: refs as unknown as Parameters<typeof wireFreezerRail>[0]['refs'],
    openVfs: async () =>
      ({ reader, writer: { writeFile: vi.fn(async () => undefined) } }) as unknown as Awaited<
        ReturnType<Parameters<typeof wireFreezerRail>[0]['openVfs']>
      >,
    client: {
      getScoops: () => [research],
      clearAllMessages: vi.fn(async () => undefined),
      spawnAgent: vi.fn(),
    } as unknown as OffscreenClient,
    getController: () => controller as never,
    getSelected: () => null,
    getUnits: () => [unit],
    selectScoop,
    clearSelection: vi.fn(),
    holdQueuedPile: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  });
  return { freezer, handles, controller, selectScoop, unit, refs };
}

const cardFor = (freezer: HTMLElement, slug: string) =>
  Array.from(freezer.querySelectorAll('slicc-freezer-card')).find(
    (card) => card.getAttribute('slug') === slug
  );

describe('Freezer rail → delete', () => {
  it('renders finished chats as deletable, never the live one', async () => {
    const { freezer, handles } = harness();
    handles.refreshFreezer();
    await vi.waitFor(() => expect(freezer.querySelectorAll('slicc-freezer-card')).toHaveLength(2));
    expect(cardFor(freezer, FILE)?.hasAttribute('deletable')).toBe(true);
    expect(cardFor(freezer, LIVE)?.hasAttribute('deletable')).toBe(false);
  });

  it('deleting the chat on screen clears the thread before handing back to its cone', async () => {
    const { freezer, handles, controller, selectScoop, unit } = harness();
    handles.refreshFreezer();
    await vi.waitFor(() => expect(cardFor(freezer, FILE)).toBeDefined());
    await handles.openFrozen(FILE);
    expect(handles.getViewedFrozenSessionId()).toBe('sid-a');

    cardFor(freezer, FILE)!.dispatchEvent(
      new CustomEvent('freezer-card-delete', {
        bubbles: true,
        composed: true,
        detail: { slug: FILE },
      })
    );
    document.querySelector<HTMLButtonElement>('slicc-dialog [data-cone-action="delete"]')!.click();

    await vi.waitFor(() => expect(selectScoop).toHaveBeenCalledWith(unit));
    expect(mockDelete).toHaveBeenCalledWith(expect.anything(), {
      filename: FILE,
      sessionId: 'sid-a',
    });
    const cleared = controller.loadMessages.mock.calls.findIndex(
      ([messages]) => Array.isArray(messages) && messages.length === 0
    );
    expect(cleared).toBeGreaterThan(-1);
    expect(controller.loadMessages.mock.invocationCallOrder[cleared]).toBeLessThan(
      selectScoop.mock.invocationCallOrder[0]!
    );
    expect(handles.getViewedFrozenSessionId()).toBeNull();
  });

  it('does not tear down a live cone reached via the switcher/URL/cone-action path, even though currentFrozenSessionId is stale', async () => {
    const { freezer, handles, controller, selectScoop, refs } = harness();
    handles.refreshFreezer();
    await vi.waitFor(() => expect(cardFor(freezer, FILE)).toBeDefined());
    await handles.openFrozen(FILE);
    expect(handles.getViewedFrozenSessionId()).toBe('sid-a');

    refs.thread.setAttribute('context', 'cone:cone-research');
    controller.loadMessages.mockClear();
    selectScoop.mockClear();
    mockDelete.mockClear();

    cardFor(freezer, FILE)!.dispatchEvent(
      new CustomEvent('freezer-card-delete', {
        bubbles: true,
        composed: true,
        detail: { slug: FILE },
      })
    );
    document.querySelector<HTMLButtonElement>('slicc-dialog [data-cone-action="delete"]')!.click();

    await vi.waitFor(() => expect(mockDelete).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(document.querySelector('slicc-dialog [data-cone-action="delete"]')).toBeNull()
    );

    expect(
      controller.loadMessages.mock.calls.some(
        ([messages]) => Array.isArray(messages) && messages.length === 0
      )
    ).toBe(false);
    expect(selectScoop).not.toHaveBeenCalled();
  });

  it('viewing chat A does not leave it when a different row sharing its legacy chat-key sessionId is deleted', async () => {
    const SHARED_SESSION_ID = 'session-cone';
    const CHAT_A = '2026-06-01T10-00-00Z-chat-a.md';
    const CHAT_B = '2026-06-01T11-00-00Z-chat-b.md';
    const SHARED_INDEX = [
      {
        filename: CHAT_A,
        sessionId: SHARED_SESSION_ID,
        title: 'Chat A',
        frozenAt: '2026-06-01T10:00:00Z',
        messageCount: 1,
        cone: 'cone-research',
      },
      {
        filename: CHAT_B,
        sessionId: SHARED_SESSION_ID,
        title: 'Chat B',
        frozenAt: '2026-06-01T11:00:00Z',
        messageCount: 1,
        cone: 'cone-research',
      },
    ];
    const { freezer, handles, controller, selectScoop } = harness({
      index: SHARED_INDEX,
      archives: { [CHAT_A]: archiveFor('Chat A'), [CHAT_B]: archiveFor('Chat B') },
    });
    handles.refreshFreezer();
    await vi.waitFor(() => expect(cardFor(freezer, CHAT_A)).toBeDefined());
    await handles.openFrozen(CHAT_A);

    expect(handles.getViewedFrozenSessionId()).toBe(SHARED_SESSION_ID);

    cardFor(freezer, CHAT_B)!.dispatchEvent(
      new CustomEvent('freezer-card-delete', {
        bubbles: true,
        composed: true,
        detail: { slug: CHAT_B },
      })
    );
    document.querySelector<HTMLButtonElement>('slicc-dialog [data-cone-action="delete"]')!.click();

    await vi.waitFor(() => expect(mockDelete).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(document.querySelector('slicc-dialog [data-cone-action="delete"]')).toBeNull()
    );

    expect(
      controller.loadMessages.mock.calls.some(
        ([messages]) => Array.isArray(messages) && messages.length === 0
      )
    ).toBe(false);
    expect(selectScoop).not.toHaveBeenCalled();
  });
});
