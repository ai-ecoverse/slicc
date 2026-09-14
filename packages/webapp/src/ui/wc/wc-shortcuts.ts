export interface ShortcutSwitcher {
  readonly scoops: ReadonlyArray<{ key: string; label?: string }>;

  readonly active: string | null;

  select(key: string): void;

  arrowKeys?: 'on' | 'off';
}

export interface ShortcutDock {
  readonly items: ReadonlyArray<{ id: string; kind?: 'sprinkle' | 'tool' }>;
  readonly active: string | null;

  selectItem(id: string): void;

  collapse(): void;
}

export interface ShortcutComposerMeta {
  readonly models: readonly unknown[];

  openMenu(): void;

  cycleModel?(): void;

  cycleThinking?(): void;
}

export type KeyboardTrigger = 'auto' | 'esc' | null;

export const DEFAULT_TRIGGER: KeyboardTrigger = 'auto';

export function parseKeyboardTrigger(value: unknown): KeyboardTrigger | undefined {
  if (value === null) return null;
  if (value === 'auto' || value === 'esc') return value;
  return undefined;
}

export interface ShortcutFreezer extends EventTarget {
  toggle(force?: boolean): void;
}

export interface ShortcutList {
  size(): number;

  selectAt(index: number): void;
}

export interface ShortcutLists {
  files?: ShortcutList;
  memory?: ShortcutList;
  sessions?: ShortcutList;
}

export interface ShortcutDeps {
  switcher: ShortcutSwitcher;

  dock?: ShortcutDock;

  freezer?: ShortcutFreezer;

  composerMeta?: ShortcutComposerMeta;

  focusComposer?: () => void;

  stopTurn?: () => void;

  focusApproval?: () => void;

  openAttachMenu?: () => void;

  copyReply?: () => void;
  copyChat?: () => void;

  zoomSurface?: () => void;

  peekTabs?: () => void;

  toggleVoice?: () => void;

  scrollMessage?: (delta: 1 | -1) => void;

  lists?: ShortcutLists;

  composerAvailable?: () => boolean;

  hudHost?: HTMLElement;

  composerBand?: HTMLElement;

  caps?: ShortcutCaps;

  usage?: HelpUsage & { record?(id: CommandId): void };

  doc?: Document;
}

export interface ShortcutCaps {
  show(keymap: Readonly<Record<string, CommandId>>): void;
  hide(): void;
  destroy(): void;
}

export interface ShortcutActions {
  accounts?: () => void;
}

export interface ShortcutHandles {
  dispose(): void;

  showHelp(): void;

  hideHelp(): void;

  helpOverlay(): HTMLElement | null;

  active(): boolean;

  intent(): ModeIntent;

  setActive(on: boolean): void;

  setAction<K extends keyof ShortcutActions>(name: K, fn: ShortcutActions[K]): void;

  setKeymap(keymap: Readonly<Record<string, CommandId>>): void;

  keymap(): Readonly<Record<string, CommandId>>;

  trigger(): KeyboardTrigger;

  setTrigger(trigger: KeyboardTrigger): void;
}

type ModalElement = HTMLElement & { show?: () => void; hide?: () => void };

export interface ShortcutRow {
  keys: string[];
  description: string;

  group: CommandGroup;

  id?: CommandId;
}

const STYLE_ID = 'slicc-shortcuts-style';
const CSS = `
/* The sheet grows a column at a time as the viewport allows, and the dialog
   grows with it — one alphabetical column of thirty-odd rows is a reference
   you read; three short labelled ones are a cheat sheet you scan. Capped at
   three because a fourth makes the eye travel further than the list is long. */
slicc-dialog.wcsc-dialog::part(dialog){width:min(460px,92vw);}
@media (min-width:900px){slicc-dialog.wcsc-dialog::part(dialog){width:min(860px,94vw);}}
@media (min-width:1280px){slicc-dialog.wcsc-dialog::part(dialog){width:min(1180px,94vw);}}
.wcsc{font-family:var(--ui);color:var(--ink);}
.wcsc__note{font-size:12px;color:var(--txt-3);padding:0 2px 10px;line-height:1.5;}

/* CSS columns rather than a grid: the sections are different heights, and
   columns flow them into balanced tracks without anyone having to decide
   which group goes where. 'break-inside' is what keeps a section whole. */
.wcsc__cols{columns:1;column-gap:30px;}
@media (min-width:900px){.wcsc__cols{columns:2;}}
@media (min-width:1280px){.wcsc__cols{columns:3;}}
.wcsc__group{break-inside:avoid;page-break-inside:avoid;margin:0 0 16px;}
.wcsc__title{font:600 10.5px/1 var(--ui);letter-spacing:.09em;text-transform:uppercase;color:var(--txt-3);padding:0 2px 6px;}

.wcsc__row{display:flex;align-items:center;gap:12px;padding:6px 4px;border-bottom:1px solid var(--line);border-radius:6px;}
.wcsc__row:last-child{border-bottom:0;}
.wcsc__desc{flex:1;min-width:0;font-size:12.5px;}
.wcsc__keys{display:flex;align-items:center;gap:4px;flex:0 0 auto;}
.wcsc__key{font:600 11px/1 var(--mono,ui-monospace,monospace);color:var(--txt-2);background:var(--ghost);border:1px solid var(--line);border-bottom-width:2px;border-radius:5px;padding:4px 6px;white-space:nowrap;}
.wcsc__sep{font-size:11px;color:var(--txt-3);}

/* Used this session. A tinted row rather than a badge or a bolder weight:
   the point is to make the handful you already touched findable at a glance
   in a wall of rows, not to shout at you about them. */
.wcsc__row[data-used]{background:color-mix(in srgb,var(--ctx) 9%,transparent);}
.wcsc__row[data-used] .wcsc__desc{color:var(--ink);}
.wcsc__row[data-used] .wcsc__key{color:var(--ink);border-color:color-mix(in srgb,var(--ctx) 34%,var(--line));}

/* The personalised section leads, and is the one thing on the sheet allowed
   to look different from the reference below it. */
.wcsc__group--yours{border:1px solid color-mix(in srgb,var(--ctx) 26%,var(--line));border-radius:10px;padding:10px 10px 4px;background:color-mix(in srgb,var(--ctx) 5%,transparent);}
.wcsc__group--yours .wcsc__title{color:color-mix(in srgb,var(--ctx) 55%,var(--ink));}
.wcsc__group--yours .wcsc__row{border-bottom-color:color-mix(in srgb,var(--ctx) 16%,var(--line));}
.wcsc__count{font:500 10.5px/1 var(--ui);color:var(--txt-3);flex:0 0 auto;}
`;

export function isTypingTarget(target: EventTarget | null | undefined): boolean {
  if (!target || typeof target !== 'object') return false;

  const el = target as Partial<HTMLElement> & { tagName?: unknown };
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable === true) return true;

  const editable = (el as Partial<Element>).closest?.('[contenteditable]');
  return !!editable && editable.getAttribute('contenteditable') !== 'false';
}

export function deepTarget(event: Event): EventTarget | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  return (path[0] as EventTarget | undefined) ?? event.target;
}

export function deepActiveElement(doc: Document): Element | null {
  let element: Element | null = doc.activeElement;

  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

export function isWithinElement(
  root: Element | null | undefined,
  node: Node | null | undefined
): boolean {
  if (!root || !node) return false;
  let cur: Node | null = node;
  while (cur) {
    if (cur === root) return true;
    if (typeof ShadowRoot !== 'undefined' && cur instanceof ShadowRoot) {
      cur = cur.host;
      continue;
    }
    const parent: ParentNode | null = cur.parentNode;
    if (parent) {
      cur = parent;
      continue;
    }
    const slotted: HTMLSlotElement | null | undefined = (
      cur as Element & { assignedSlot?: HTMLSlotElement | null }
    ).assignedSlot;
    if (slotted) {
      cur = slotted;
      continue;
    }
    break;
  }
  return false;
}

export function isFrameTarget(target: EventTarget | null | undefined): target is Element {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: unknown };
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  return tag === 'IFRAME' || tag === 'FRAME' || tag === 'OBJECT' || tag === 'EMBED';
}

export function isActivationTarget(target: EventTarget | null | undefined): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as Partial<Element> & { tagName?: unknown };
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'OPTION') return true;
  if (tag === 'A' && el.hasAttribute?.('href') === true) return true;
  const role = el.getAttribute?.('role') ?? '';
  return [
    'button',
    'link',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'tab',
    'switch',
    'checkbox',
    'radio',
  ].includes(role);
}

export function hasOpenOverlay(doc: Document): boolean {
  return !!doc.querySelector(
    'slicc-quick-look, slicc-dialog[open], slicc-tab-overlay[open], .slicc-permissions__prompt[data-open]'
  );
}

export function digitFor(event: KeyboardEvent): number | null {
  const byCode = /^Digit([1-9])$/.exec(event.code ?? '');
  if (byCode) return Number(byCode[1]);
  return /^[1-9]$/.test(event.key) ? Number(event.key) : null;
}

export function indexForDigit(size: number, digit: number): number | null {
  if (size <= 0) return null;
  const index = digit === 9 ? size - 1 : digit - 1;
  return index < size ? index : null;
}

export function itemForDigit(keys: readonly string[], digit: number): string | null {
  const index = indexForDigit(keys.length, digit);
  return index === null ? null : (keys[index] ?? null);
}

export function unitKeyForDigit(
  scoops: ReadonlyArray<{ key: string }>,
  digit: number
): string | null {
  return itemForDigit(
    scoops.map((s) => s.key),
    digit
  );
}

export function nextInCycle(keys: readonly string[], current: string | null): string | null {
  if (keys.length === 0) return null;
  const index = current === null ? -1 : keys.indexOf(current);
  return keys[(index + 1) % keys.length] ?? null;
}

export function prevInCycle(keys: readonly string[], current: string | null): string | null {
  if (keys.length === 0) return null;
  const found = current === null ? -1 : keys.indexOf(current);

  const index = found === -1 ? 0 : found;
  return keys[(index - 1 + keys.length) % keys.length] ?? null;
}

export function sprinkleIds(dock: ShortcutDock): string[] {
  return dock.items.filter((i) => i.kind === 'sprinkle').map((i) => i.id);
}

interface CommandContext {
  deps: ShortcutDeps;
  actions: ShortcutActions;
  state: ModeState;
  toggleHelp(): void;

  armed: ArmedChord | null;
}

export interface ArmedChord {
  list: ChordListId;

  index: number | null;
}

export type ModeIntent = 'composer' | 'keyboard';

interface ModeState {
  lastDockSurface: string;
}

export const COMMAND_GROUPS = [
  'Getting around',
  'Agents',
  'The turn',
  'Panels',
  'Settings',
] as const;

export type CommandGroup = (typeof COMMAND_GROUPS)[number];

interface Command {
  holdsMode: boolean;
  description: string;

  list?: ChordListId;

  surfaceId?: string;

  group: CommandGroup;

  run(ctx: CommandContext): number | void;
}

export type ChordListId = 'files' | 'memory' | 'sessions' | 'sprinkles';

export function chordList(id: ChordListId, deps: ShortcutDeps): ShortcutList | null {
  if (id !== 'sprinkles') return deps.lists?.[id] ?? null;
  const dock = deps.dock;
  if (!dock) return null;
  return {
    size: () => sprinkleIds(dock).length,

    selectAt: (index) => {
      const id = sprinkleIds(dock)[index];
      if (id) dock.selectItem(id);
    },
  };
}

export type CommandId =
  | 'nextAgent'
  | 'prevAgent'
  | 'composer'
  | 'newConversation'
  | 'newConversationErase'
  | 'newCone'
  | 'dropCone'
  | 'sessions'
  | 'stop'
  | 'approvals'
  | 'attach'
  | 'copyReply'
  | 'copyChat'
  | 'voice'
  | 'nextItem'
  | 'prevItem'
  | 'leftRail'
  | 'rightRail'
  | 'files'
  | 'tabs'
  | 'peek'
  | 'terminal'
  | 'memory'
  | 'monitor'
  | 'sprinkles'
  | 'zoom'
  | 'model'
  | 'cycleModel'
  | 'cycleThinking'
  | 'accounts'
  | 'help';

function surfaceCommand(id: string, description: string, list?: ChordListId): Command {
  return {
    holdsMode: !!list,
    description,
    group: 'Panels',
    surfaceId: id,
    ...(list ? { list } : {}),
    run: ({ deps, state }) => {
      state.lastDockSurface = id;
      deps.dock?.selectItem(id);
    },
  };
}

function freezerCommand(type: string, description: string): Command {
  return {
    holdsMode: false,
    description,
    group: 'Agents',
    run: ({ deps }) => {
      deps.freezer?.dispatchEvent(new CustomEvent(type, { bubbles: true }));
    },
  };
}

const COMMANDS: Readonly<Record<CommandId, Command>> = {
  nextAgent: {
    holdsMode: true,
    group: 'Agents',
    description: 'Next agent, looping',
    run: ({ deps }) => {
      const next = nextInCycle(
        deps.switcher.scoops.map((s) => s.key),
        deps.switcher.active
      );
      if (next) deps.switcher.select(next);
    },
  },
  prevAgent: {
    holdsMode: true,
    group: 'Agents',
    description: 'Previous agent, looping',
    run: ({ deps }) => {
      const prev = prevInCycle(
        deps.switcher.scoops.map((s) => s.key),
        deps.switcher.active
      );
      if (prev) deps.switcher.select(prev);
    },
  },
  composer: {
    holdsMode: false,
    group: 'Getting around',
    description: 'Back to the composer',
    run: ({ deps }) => deps.focusComposer?.(),
  },
  stop: {
    holdsMode: true,
    group: 'The turn',
    description: 'Stop the running turn',
    run: ({ deps }) => deps.stopTurn?.(),
  },
  approvals: {
    holdsMode: true,
    group: 'The turn',
    description: 'Go to the pending approval',
    run: ({ deps }) => deps.focusApproval?.(),
  },
  attach: {
    holdsMode: false,
    group: 'The turn',
    description: 'Attach a file or skill',
    run: ({ deps }) => deps.openAttachMenu?.(),
  },
  copyReply: {
    holdsMode: true,
    group: 'The turn',
    description: 'Copy the last reply',
    run: ({ deps }) => deps.copyReply?.(),
  },
  copyChat: {
    holdsMode: true,
    group: 'The turn',
    description: 'Copy the whole chat',
    run: ({ deps }) => deps.copyChat?.(),
  },
  voice: {
    holdsMode: true,
    group: 'The turn',
    description: 'Dictate — again to send',
    run: ({ deps }) => deps.toggleVoice?.(),
  },
  nextItem: {
    holdsMode: true,
    group: 'Getting around',
    description: 'Next message — or, after a list key, the next entry',
    run: (ctx) => stepList(ctx, 1),
  },
  prevItem: {
    holdsMode: true,
    group: 'Getting around',
    description: 'Previous message — or the previous entry',
    run: (ctx) => stepList(ctx, -1),
  },
  newConversation: {
    holdsMode: false,
    group: 'Agents',
    description: 'New conversation',

    run: ({ deps }) => {
      deps.freezer?.dispatchEvent(new CustomEvent('new-chat-save', { bubbles: true }));
    },
  },
  newConversationErase: freezerCommand('new-chat-erase', 'New conversation, erasing this one'),
  newCone: freezerCommand('new-cone', 'New cone'),
  dropCone: freezerCommand('drop-cone', 'Drop this cone'),
  sessions: {
    holdsMode: true,
    group: 'Agents',
    description: 'Archived chats (with 1-9 / j / k: restore that one)',
    list: 'sessions',

    run: ({ deps }) => deps.freezer?.toggle(true),
  },
  leftRail: {
    holdsMode: true,
    group: 'Getting around',
    description: 'Toggle the left rail',
    run: ({ deps }) => deps.freezer?.toggle(),
  },
  rightRail: {
    holdsMode: true,
    group: 'Getting around',
    description: 'Toggle the right panel',

    run: ({ deps, state }) => {
      const dock = deps.dock;
      if (!dock) return;
      if (dock.active) {
        state.lastDockSurface = dock.active;
        dock.collapse();
        return;
      }
      dock.selectItem(state.lastDockSurface);
    },
  },
  files: surfaceCommand('files', 'File browser (with 1-9 / j / k: open that row)', 'files'),
  tabs: surfaceCommand('browser', 'Browser tabs (then 1-9 to switch)'),
  peek: {
    holdsMode: true,
    group: 'Panels',
    description: 'Peek a tab (then 1-9: show it and come back)',
    run: ({ deps }) => deps.peekTabs?.(),
  },
  terminal: surfaceCommand('term', 'Terminal'),
  memory: surfaceCommand('memory', 'Memory (with 1-9 / j / k: open that entry)', 'memory'),
  monitor: surfaceCommand('monitor', 'Monitor'),
  sprinkles: {
    holdsMode: true,
    group: 'Panels',
    description: 'Sprinkles (with 1-9 / j / k: open that one)',
    list: 'sprinkles',
    run: ({ deps, state }) => {
      const dock = deps.dock;
      if (!dock) return;
      const ids = sprinkleIds(dock);

      if (ids.length === 0) return;
      state.lastDockSurface = ids[0];
      dock.selectItem(ids[0]);

      return 0;
    },
  },
  zoom: {
    holdsMode: true,
    group: 'Getting around',
    description: 'Full screen the open panel',

    run: ({ deps }) => deps.zoomSurface?.(),
  },
  model: {
    holdsMode: false,
    group: 'Settings',
    description: 'Model picker',

    run: ({ deps, actions }) => {
      const meta = deps.composerMeta;
      if (!meta) return;
      if (meta.models.length === 0) {
        actions.accounts?.();
        return;
      }
      meta.openMenu();
    },
  },
  cycleModel: {
    holdsMode: true,
    group: 'Settings',
    description: 'Next model',
    run: ({ deps, actions }) => {
      const meta = deps.composerMeta;
      if (!meta) return;
      if (meta.models.length === 0) {
        actions.accounts?.();
        return;
      }
      meta.cycleModel?.();
    },
  },
  cycleThinking: {
    holdsMode: true,
    group: 'Settings',
    description: 'Next thinking level',
    run: ({ deps }) => deps.composerMeta?.cycleThinking?.(),
  },
  accounts: {
    holdsMode: false,
    group: 'Settings',
    description: 'Accounts',
    run: ({ actions }) => actions.accounts?.(),
  },
  help: {
    holdsMode: true,
    group: 'Getting around',
    description: 'This help',
    run: (ctx) => ctx.toggleHelp(),
  },
};

export const COMMAND_IDS = Object.keys(COMMANDS) as CommandId[];

export function isCommandId(value: unknown): value is CommandId {
  return typeof value === 'string' && Object.hasOwn(COMMANDS, value);
}

export function commandSurfaceId(id: CommandId): string | null {
  return COMMANDS[id].surfaceId ?? null;
}

export function commandForSurfaceId(surfaceId: string): CommandId | null {
  return COMMAND_IDS.find((id) => COMMANDS[id].surfaceId === surfaceId) ?? null;
}

export const RESERVED_KEYS: readonly string[] = [
  'Escape',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
];

export const DEFAULT_KEYMAP: Readonly<Record<string, CommandId>> = {
  i: 'composer',
  Enter: 'composer',
  '?': 'help',

  ArrowRight: 'nextAgent',
  ArrowLeft: 'prevAgent',
  n: 'newConversation',
  N: 'newConversationErase',
  c: 'newCone',
  C: 'dropCone',
  r: 'sessions',

  s: 'stop',
  a: 'approvals',
  u: 'attach',
  y: 'copyReply',
  Y: 'copyChat',
  v: 'voice',
  j: 'nextItem',
  k: 'prevItem',

  f: 'files',
  t: 'terminal',
  b: 'tabs',
  m: 'memory',
  g: 'monitor',
  e: 'sprinkles',
  p: 'peek',
  '[': 'leftRail',
  ']': 'rightRail',
  z: 'zoom',

  l: 'model',
  L: 'cycleModel',
  h: 'cycleThinking',
  ',': 'accounts',
};

export const V1_KEYMAP: Readonly<Record<string, CommandId>> = {
  d: 'nextAgent',
  c: 'composer',
  Enter: 'composer',
  n: 'newConversation',
  b: 'leftRail',
  x: 'rightRail',
  f: 'files',
  t: 'tabs',
  e: 'terminal',
  m: 'memory',
  s: 'sprinkles',
  l: 'model',
  a: 'accounts',
  h: 'help',
  '?': 'help',
  '/': 'help',
};

function keyLabel(key: string): string {
  return KEY_CAPS[key] ?? key;
}

export function commandKeyLabel(
  keymap: Readonly<Record<string, CommandId>>,
  id: CommandId
): string | null {
  const key = Object.keys(keymap).find((k) => keymap[k] === id);
  return key === undefined ? null : keyLabel(key);
}

export function helpKeyLabel(keymap: Readonly<Record<string, CommandId>>): string | null {
  return commandKeyLabel(keymap, 'help');
}

export function hudHint(keymap: Readonly<Record<string, CommandId>>): string {
  const help = helpKeyLabel(keymap);
  const typing = Object.keys(keymap)
    .filter((key) => keymap[key] === 'composer')
    .map((key) => `[${keyLabel(key)}]`);
  return [
    help === null ? null : `[${help}] help`,
    typing.length === 0 ? null : `${typing.join(' or ')} to type`,
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

export function shortcutRows(
  keymap: Readonly<Record<string, CommandId>> = DEFAULT_KEYMAP
): ShortcutRow[] {
  const byCommand = new Map<CommandId, string[]>();
  for (const [key, id] of Object.entries(keymap)) {
    byCommand.set(id, [...(byCommand.get(id) ?? []), keyLabel(key)]);
  }
  return [
    {
      keys: ['Esc'],
      description: 'Leave the composer for keyboard mode (again: exit full screen)',
      group: 'Getting around' as const,
    },
    {
      keys: ['1 – 9'],
      description: 'Switch to that agent in the tab strip (9 = last)',
      group: 'Agents' as const,
    },
    ...COMMAND_IDS.filter((id) => byCommand.has(id)).map((id) => ({
      keys: byCommand.get(id) ?? [],
      description: COMMANDS[id].description,
      group: COMMANDS[id].group,
      id,
    })),
  ];
}

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head ?? doc.documentElement)?.append(style);
}

const FREQUENT_ROWS = 5;

export interface HelpUsage {
  ranked(): ReadonlyArray<{ id: CommandId; count: number }>;
}

interface HelpRow extends ShortcutRow {
  count: number;
}

function keyNodes(doc: Document, row: ShortcutRow): HTMLElement {
  const keys = doc.createElement('div');
  keys.className = 'wcsc__keys';
  for (const key of row.keys) {
    const kbd = doc.createElement('kbd');
    kbd.className = 'wcsc__key';
    kbd.textContent = key;
    keys.append(kbd);
  }
  return keys;
}

function helpRow(doc: Document, row: HelpRow, showCount = false): HTMLElement {
  const line = doc.createElement('div');
  line.className = 'wcsc__row';
  if (row.count > 0) line.dataset.used = String(row.count);

  const desc = doc.createElement('div');
  desc.className = 'wcsc__desc';
  desc.textContent = row.description;
  line.append(desc);

  if (showCount) {
    const count = doc.createElement('div');
    count.className = 'wcsc__count';
    count.textContent = `×${row.count}`;
    line.append(count);
  }
  line.append(keyNodes(doc, row));
  return line;
}

function helpGroup(doc: Document, title: string, rows: readonly HelpRow[]): HTMLElement {
  const group = doc.createElement('div');
  group.className = 'wcsc__group';
  const heading = doc.createElement('div');
  heading.className = 'wcsc__title';
  heading.textContent = title;
  group.append(heading);
  for (const row of rows) group.append(helpRow(doc, row));
  return group;
}

function frequentGroup(doc: Document, rows: readonly HelpRow[]): HTMLElement | null {
  const top = rows
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, FREQUENT_ROWS);
  if (top.length === 0) return null;

  const group = doc.createElement('div');
  group.className = 'wcsc__group wcsc__group--yours';
  const heading = doc.createElement('div');
  heading.className = 'wcsc__title';
  heading.textContent = 'Your frequent actions';
  group.append(heading);
  for (const row of top) group.append(helpRow(doc, row, true));
  return group;
}

function buildHelpBody(
  doc: Document,
  rows: readonly ShortcutRow[],
  trigger: KeyboardTrigger,
  usage?: HelpUsage
): HTMLElement {
  const list = doc.createElement('div');
  list.className = 'wcsc';
  const note = doc.createElement('div');
  note.className = 'wcsc__note';
  note.textContent =
    trigger === null
      ? 'Keyboard mode is off. Turn it on in Theme settings (Esc or Auto).'
      : trigger === 'esc'
        ? 'Press Esc to enter keyboard mode. Put the caret back in the composer to type — nothing is intercepted there.'
        : 'Keyboard mode is on whenever nothing is focused for typing (and you are not clicking composer chrome), so these keys are live by default. Put the caret back in the composer to type — nothing is intercepted there.';
  list.append(note);

  const counts = new Map((usage?.ranked() ?? []).map((entry) => [entry.id, entry.count]));
  const counted: HelpRow[] = rows.map((row) => ({
    ...row,
    count: (row.id === undefined ? undefined : counts.get(row.id)) ?? 0,
  }));

  const cols = doc.createElement('div');
  cols.className = 'wcsc__cols';
  const yours = frequentGroup(doc, counted);
  if (yours) cols.append(yours);
  for (const group of COMMAND_GROUPS) {
    const inGroup = counted.filter((row) => row.group === group);
    if (inGroup.length > 0) cols.append(helpGroup(doc, group, inGroup));
  }
  list.append(cols);
  return list;
}

const HUD_LINGER_MS = 1600;

const CHORD_WINDOW_MS = HUD_LINGER_MS;

const KEY_CAPS: Readonly<Record<string, string>> = {
  Escape: 'Esc',
  Enter: '⏎',
  ' ': 'Space',
  Tab: '⇥',
  Backspace: '⌫',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

export function describeKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>
): string[] {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('⌃');
  if (event.altKey) parts.push('⌥');
  if (event.metaKey) parts.push('⌘');

  if (event.shiftKey && event.key.length > 1) parts.push('⇧');
  parts.push(KEY_CAPS[event.key] ?? event.key);
  return parts;
}

function createHud(
  doc: Document,
  host: HTMLElement,
  keymap: Readonly<Record<string, CommandId>>
): {
  record(parts: readonly string[], bound: boolean): void;
  destroy(): void;
} {
  const hud = doc.createElement('slicc-key-hud') as HTMLElement & {
    record?(caps: readonly string[], bound: boolean): void;
  };
  hud.dataset.wcShortcuts = 'hud';
  hud.setAttribute('hint', hudHint(keymap));
  hud.setAttribute('linger', String(HUD_LINGER_MS));
  host.append(hud);
  return {
    record: (parts, bound) => hud.record?.(parts, bound),
    destroy: () => hud.remove(),
  };
}

function createHelp(
  doc: Document,
  readKeymap: () => Readonly<Record<string, CommandId>>,
  readTrigger: () => KeyboardTrigger,
  usage?: HelpUsage
): {
  show(): void;
  hide(): void;
  toggle(): void;
  element(): HTMLElement | null;
} {
  let overlay: ModalElement | null = null;
  const hide = (): void => {
    if (!overlay) return;
    const open = overlay;
    overlay = null;
    open.hide?.();
    open.remove();
  };
  const show = (): void => {
    if (overlay) return;
    ensureStyle(doc);
    const dialog = doc.createElement('slicc-dialog') as ModalElement;
    dialog.className = 'wcsc-dialog';
    dialog.setAttribute('heading', 'Keyboard mode');
    dialog.dataset.wcShortcuts = 'help';

    dialog.append(buildHelpBody(doc, shortcutRows(readKeymap()), readTrigger(), usage));

    dialog.addEventListener('slicc-dialog-close', () => {
      overlay = null;
      dialog.remove();
    });

    doc.body.append(dialog);
    overlay = dialog;
    dialog.show?.();
  };
  return {
    show,
    hide,
    toggle: () => (overlay ? hide() : show()),
    element: () => overlay,
  };
}

function syncKeyboardLock(doc: Document): void {
  const keyboard = (
    doc.defaultView?.navigator as Navigator & {
      keyboard?: { lock(keys: string[]): Promise<void>; unlock(): void };
    }
  )?.keyboard;
  if (!keyboard) return;
  if (doc.fullscreenElement) void keyboard.lock(['Escape']).catch(() => undefined);
  else keyboard.unlock();
}

function createMode(
  doc: Document,
  keymap: () => Readonly<Record<string, CommandId>>,
  hudHost: () => HTMLElement,
  caps: ShortcutCaps | undefined,
  onToggle: (on: boolean) => void
): {
  on(): boolean;
  set(next: boolean): void;
  record(parts: readonly string[], bound: boolean): void;
} {
  let modeOn = false;
  let hud: ReturnType<typeof createHud> | null = null;
  return {
    on: () => modeOn,

    record: (parts, bound) => hud?.record(parts, bound),
    set: (next: boolean) => {
      if (next === modeOn) return;
      modeOn = next;
      doc.documentElement.toggleAttribute('data-slicc-keyboard-mode', next);
      onToggle(next);
      if (!next) {
        hud?.destroy();
        hud = null;
        caps?.hide();
        return;
      }
      ensureStyle(doc);

      hud = createHud(doc, hudHost(), keymap());

      caps?.show(keymap());

      const focused = doc.activeElement as HTMLElement | null;
      if (isTypingTarget(focused)) focused?.blur();
    },
  };
}

function passesThrough(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  const target = deepTarget(event);
  if (isTypingTarget(target)) return true;
  return (event.key === 'Enter' || event.key === ' ') && isActivationTarget(target);
}

function applyTriggerSettle(
  trigger: KeyboardTrigger,
  keepComposer: boolean,
  composerAvailable: boolean,
  mode: { set(on: boolean): void },
  setIntent: (next: ModeIntent) => void
): void {
  if (trigger === null) {
    mode.set(false);
    if (composerAvailable && keepComposer) setIntent('composer');
    return;
  }
  if (trigger === 'esc') {
    if (keepComposer) {
      mode.set(false);
      if (composerAvailable) setIntent('composer');
    }
    return;
  }

  mode.set(!keepComposer);
  if (composerAvailable) setIntent(keepComposer ? 'composer' : 'keyboard');
}

function createSettler(
  doc: Document,
  mode: ReturnType<typeof createMode>,
  deps: ShortcutDeps,
  readTrigger: () => KeyboardTrigger,
  keepExtra?: () => boolean
): {
  schedule(): void;

  restore(): void;

  choose(next: ModeIntent): void;

  suspend(): void;

  dropSuspension(): void;
  intent(): ModeIntent;
  dispose(): void;
} {
  const view = doc.defaultView;
  const setTimer = view?.setTimeout.bind(view) ?? setTimeout;
  const clearTimer = view?.clearTimeout.bind(view) ?? clearTimeout;

  const composerAvailable = deps.composerAvailable ?? ((): boolean => !!deps.focusComposer);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let intent: ModeIntent = 'composer';

  let suspended = false;

  let watchedFrame: Element | null = null;
  let framePresence: MutationObserver | null = null;

  const unwatchFrame = (): void => {
    framePresence?.disconnect();
    framePresence = null;
    watchedFrame = null;
  };

  const watchFrame = (frame: Element): void => {
    if (watchedFrame === frame) return;
    unwatchFrame();
    const ObserverCtor = view?.MutationObserver ?? globalThis.MutationObserver;
    if (!ObserverCtor) return;
    watchedFrame = frame;
    framePresence = new ObserverCtor(() => {
      if (frame.isConnected) return;
      unwatchFrame();
      schedule();
    });
    framePresence.observe(doc.documentElement, { childList: true, subtree: true });
  };

  const suspend = (): void => {
    suspended ||= mode.on();
    mode.set(false);
  };

  const settle = (): void => {
    if (hasOpenOverlay(doc)) return;

    if (typeof doc.hasFocus === 'function' && !doc.hasFocus()) return;
    const focused = deepActiveElement(doc);

    if (isFrameTarget(focused)) {
      watchFrame(focused);
      suspend();
      return;
    }
    unwatchFrame();
    const keepComposer =
      isTypingTarget(focused) || isWithinElement(deps.composerBand, focused) || !!keepExtra?.();

    if (suspended) {
      suspended = false;
      if (!keepComposer && readTrigger() === 'esc') mode.set(true);
    }
    applyTriggerSettle(readTrigger(), keepComposer, composerAvailable(), mode, (next) => {
      intent = next;
    });
  };

  const schedule = (): void => {
    if (timer !== undefined) return;
    timer = setTimer(() => {
      timer = undefined;
      settle();
    }, 0);
  };

  return {
    schedule,
    restore: () => {
      if (hasOpenOverlay(doc)) return;
      const trigger = readTrigger();
      if (intent === 'composer' && composerAvailable()) {
        mode.set(false);
        deps.focusComposer?.();
      } else if (trigger === null) {
        mode.set(false);
      } else {
        mode.set(true);
      }

      schedule();
    },
    choose: (next) => {
      intent = next;
    },
    suspend,
    dropSuspension: () => {
      suspended = false;
    },
    intent: () => intent,
    dispose: () => {
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;

      unwatchFrame();
    },
  };
}

function observeSelectedUnit(
  switcher: ShortcutSwitcher,
  doc: Document,
  onChange: () => void
): () => void {
  const node =
    (switcher as unknown as Partial<Node>).nodeType === 1 ? (switcher as unknown as Element) : null;
  const ObserverCtor = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  if (!node || !ObserverCtor) return () => undefined;
  let last = switcher.active;
  const observer = new ObserverCtor(() => {
    const next = switcher.active;

    if (next === last) return;
    last = next;
    onChange();
  });
  observer.observe(node, { attributes: true, attributeFilter: ['active'] });
  return () => observer.disconnect();
}

function stepList(ctx: CommandContext, delta: 1 | -1): number | void {
  const armed = ctx.armed;
  if (!armed) {
    ctx.deps.scrollMessage?.(delta);
    return;
  }
  const list = chordList(armed.list, ctx.deps);
  const size = list?.size() ?? 0;
  if (!list || size === 0) return;

  const at =
    armed.index === null ? (delta > 0 ? 0 : size - 1) : (armed.index + delta + size) % size;
  list.selectAt(at);
  return at;
}

function selectChordItem(deps: ShortcutDeps, id: ChordListId, digit: number): number | null {
  const list = chordList(id, deps);
  const index = list ? indexForDigit(list.size(), digit) : null;
  if (index === null || !list) return null;
  list.selectAt(index);
  return index;
}

interface Dispatch {
  deps: ShortcutDeps;
  actions: ShortcutActions;
  state: ModeState;
  mode: ReturnType<typeof createMode>;
  settler: ReturnType<typeof createSettler>;
  chord: ReturnType<typeof createChord>;
  toggleHelp(): void;
}

function runCommand(
  command: Command,
  id: CommandId,
  event: KeyboardEvent,
  armed: ArmedChord | null,
  ctx: Dispatch
): void {
  event.preventDefault();

  ctx.deps.usage?.record?.(id);
  if (!command.holdsMode) ctx.mode.set(false);
  const at = command.run({
    deps: ctx.deps,
    actions: ctx.actions,
    state: ctx.state,
    toggleHelp: ctx.toggleHelp,
    armed,
  });

  const opened = command.list ?? (typeof at === 'number' ? armed?.list : undefined);
  if (opened) ctx.chord.arm(opened, typeof at === 'number' ? at : null);
  if (!command.holdsMode) ctx.settler.schedule();
}

function handleEscape(
  event: KeyboardEvent,
  doc: Document,
  mode: ReturnType<typeof createMode>,
  settler: ReturnType<typeof createSettler>,
  trigger: KeyboardTrigger
): void {
  if (hasOpenOverlay(doc)) return;
  if (!mode.on()) {
    if (trigger === null) return;

    event.preventDefault();
    mode.set(true);

    settler.choose('keyboard');

    mode.record(describeKey(event), true);
    return;
  }

  const fullscreen = !!doc.fullscreenElement;
  mode.record(describeKey(event), fullscreen);
  if (fullscreen) void doc.exitFullscreen?.().catch(() => undefined);
}

function suspendedByModal(doc: Document, command: Command | undefined, helpOpen: boolean): boolean {
  return hasOpenOverlay(doc) && !(command === COMMANDS.help && helpOpen);
}

function selectByDigit(
  deps: ShortcutDeps,
  armed: ArmedChord | null,
  digit: number
): { hit: boolean; index: number | null } {
  if (armed) {
    const index = selectChordItem(deps, armed.list, digit);
    return { hit: index !== null, index };
  }
  const key = unitKeyForDigit(deps.switcher.scoops, digit);
  if (key !== null) deps.switcher.select(key);

  return { hit: key !== null, index: null };
}

function createChord(doc: Document): {
  take(): ArmedChord | null;

  arm(list: ChordListId, index: number | null): void;
  clear(): void;
} {
  const view = doc.defaultView;
  const setTimer = view?.setTimeout.bind(view) ?? setTimeout;
  const clearTimer = view?.clearTimeout.bind(view) ?? clearTimeout;
  let armed: (ArmedChord & { timer: ReturnType<typeof setTimeout> }) | null = null;
  const clear = (): void => {
    if (!armed) return;
    clearTimer(armed.timer);
    armed = null;
  };
  return {
    take: () => {
      if (!armed) return null;
      const { list, index } = armed;
      clear();
      return { list, index };
    },
    arm: (list, index) => {
      clear();
      armed = { list, index, timer: setTimer(clear, CHORD_WINDOW_MS) };
    },
    clear,
  };
}

const INSTALLED = new WeakMap<Document, ShortcutHandles>();

function handleModeKeyDown(
  event: KeyboardEvent,
  ctx: {
    doc: Document;
    mode: ReturnType<typeof createMode>;
    settler: ReturnType<typeof createSettler>;
    chord: ReturnType<typeof createChord>;
    helpOpen: () => boolean;
    deps: ShortcutDeps;
    dispatch: Dispatch;
    commandIdFor: (key: string) => CommandId | undefined;
    trigger: KeyboardTrigger;
  }
): void {
  if (event.defaultPrevented || event.isComposing) return;
  if (event.key === 'Escape') {
    ctx.chord.clear();
    handleEscape(event, ctx.doc, ctx.mode, ctx.settler, ctx.trigger);
    return;
  }
  if (!ctx.mode.on()) return;
  if (passesThrough(event)) return;

  const armed = ctx.chord.take();

  const commandId = ctx.commandIdFor(event.key);
  const command = commandId ? COMMANDS[commandId] : undefined;
  if (suspendedByModal(ctx.doc, command, ctx.helpOpen())) {
    ctx.mode.record(describeKey(event), false);
    return;
  }

  const digit = digitFor(event);
  if (digit !== null) {
    const { hit, index } = selectByDigit(ctx.deps, armed, digit);
    ctx.mode.record(describeKey(event), hit);
    if (!hit) return;
    event.preventDefault();

    if (armed && index !== null) ctx.chord.arm(armed.list, index);
    return;
  }

  ctx.mode.record(describeKey(event), !!command);

  if (command && commandId) runCommand(command, commandId, event, armed, ctx.dispatch);
}

function bindComposerPointer(
  doc: Document,
  deps: ShortcutDeps,
  settler: { schedule(): void },
  held: { value: boolean }
): () => void {
  const view = doc.defaultView;
  const setTimer = view?.setTimeout.bind(view) ?? setTimeout;
  const clearTimer = view?.clearTimeout.bind(view) ?? clearTimeout;
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;

  const dropHold = (restore: boolean): void => {
    if (!held.value) return;
    if (restoreTimer !== undefined) return;
    restoreTimer = setTimer(() => {
      restoreTimer = undefined;
      held.value = false;
      if (restore) {
        const focused = deepActiveElement(doc);
        if (
          !hasOpenOverlay(doc) &&
          !isTypingTarget(focused) &&
          !isWithinElement(deps.composerBand, focused)
        ) {
          deps.focusComposer?.();
        }
      }
      settler.schedule();
    }, 0);
  };

  const onPointerDown = (event: Event): void => {
    if (isWithinElement(deps.composerBand, deepTarget(event) as Node | null)) {
      held.value = true;
      return;
    }

    if (held.value) dropHold(false);
  };

  const onRelease = (): void => dropHold(true);
  const onAbandon = (): void => dropHold(false);

  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('mousedown', onPointerDown, true);
  doc.addEventListener('pointerup', onRelease, true);
  doc.addEventListener('mouseup', onRelease, true);
  doc.addEventListener('pointercancel', onAbandon, true);
  deps.composerBand?.addEventListener('lostpointercapture', onAbandon);
  view?.addEventListener('blur', onAbandon);
  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('mousedown', onPointerDown, true);
    doc.removeEventListener('pointerup', onRelease, true);
    doc.removeEventListener('mouseup', onRelease, true);
    doc.removeEventListener('pointercancel', onAbandon, true);
    deps.composerBand?.removeEventListener('lostpointercapture', onAbandon);
    view?.removeEventListener('blur', onAbandon);
    if (restoreTimer !== undefined) clearTimer(restoreTimer);
  };
}

export function wireKeyboardShortcuts(deps: ShortcutDeps): ShortcutHandles {
  const doc = deps.doc ?? (deps.switcher as unknown as { ownerDocument?: Document })?.ownerDocument;
  if (!doc) throw new Error('wireKeyboardShortcuts: no document');
  INSTALLED.get(doc)?.dispose();
  const actions: ShortcutActions = {};
  let keymap: Readonly<Record<string, CommandId>> = DEFAULT_KEYMAP;
  let trigger: KeyboardTrigger = DEFAULT_TRIGGER;

  const usage = deps.usage;
  const help = createHelp(
    doc,
    () => keymap,
    () => trigger,
    usage
  );
  const mode = createMode(
    doc,
    () => keymap,
    () => deps.hudHost ?? doc.body,
    deps.caps,
    (on) => {
      deps.switcher.arrowKeys = on ? 'off' : 'on';
      deps.composerBand?.toggleAttribute('keys', on);
    }
  );
  const state: ModeState = { lastDockSurface: 'files' };
  const commandIdFor = (key: string): CommandId | undefined => keymap[key];
  const composerPointer = { value: false };
  const settler = createSettler(
    doc,
    mode,
    deps,
    () => trigger,
    () => composerPointer.value
  );
  const unbindComposerPointer = bindComposerPointer(doc, deps, settler, composerPointer);
  const chord = createChord(doc);
  const dispatch: Dispatch = {
    deps,
    actions,
    state,
    mode,
    settler,
    chord,
    toggleHelp: () => help.toggle(),
  };

  const onKeyDown = (event: KeyboardEvent): void =>
    handleModeKeyDown(event, {
      doc,
      mode,
      settler,
      chord,
      helpOpen: () => !!help.element(),
      deps,
      dispatch,
      commandIdFor,
      trigger,
    });

  const onFocusIn = (event: FocusEvent): void => {
    const target = deepTarget(event);

    if (mode.on() && isFrameTarget(target)) settler.suspend();
    else if (
      mode.on() &&
      (isTypingTarget(target) || isWithinElement(deps.composerBand, target as Node | null))
    ) {
      mode.set(false);
    }
    settler.schedule();
  };

  const onFocusOut = (): void => settler.schedule();
  const onFullscreenChange = (): void => syncKeyboardLock(doc);

  const onWindowFocus = (): void => settler.schedule();

  const onWindowBlur = (): void => settler.suspend();
  const stopWatchingUnit = observeSelectedUnit(deps.switcher, doc, settler.restore);

  const view = doc.defaultView;
  doc.addEventListener('keydown', onKeyDown);
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('focusout', onFocusOut);
  doc.addEventListener('fullscreenchange', onFullscreenChange);
  view?.addEventListener('focus', onWindowFocus);
  view?.addEventListener('blur', onWindowBlur);
  syncKeyboardLock(doc);

  settler.schedule();

  const handles: ShortcutHandles = {
    dispose: () => {
      doc.removeEventListener('keydown', onKeyDown);
      doc.removeEventListener('focusin', onFocusIn);
      doc.removeEventListener('focusout', onFocusOut);
      doc.removeEventListener('fullscreenchange', onFullscreenChange);
      view?.removeEventListener('focus', onWindowFocus);
      view?.removeEventListener('blur', onWindowBlur);
      unbindComposerPointer();
      stopWatchingUnit();
      settler.dispose();

      chord.clear();
      mode.set(false);
      help.hide();

      deps.caps?.destroy();

      if (INSTALLED.get(doc) === handles) INSTALLED.delete(doc);
    },
    showHelp: help.show,
    hideHelp: help.hide,
    helpOverlay: help.element,
    active: mode.on,
    setActive: mode.set,
    intent: settler.intent,
    setAction: (name, fn) => {
      actions[name] = fn;
    },
    setKeymap: (next) => {
      keymap = { ...next };
    },
    keymap: () => keymap,
    trigger: () => trigger,
    setTrigger: (next) => {
      trigger = next;

      if (next === null || next === 'esc') mode.set(false);

      settler.dropSuspension();
      settler.schedule();
    },
  };
  INSTALLED.set(doc, handles);
  return handles;
}
