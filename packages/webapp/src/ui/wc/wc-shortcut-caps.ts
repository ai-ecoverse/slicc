import type { ShortcutCaps } from './wc-shortcuts.js';
import { type CommandId, commandKeyLabel, commandSurfaceId } from './wc-shortcuts.js';

const LAYER_Z = 40;

const OVERHANG_PX = 56;

const LAYER_CLASS = 'wcsc-caps';
const GHOST_CLASS = 'wcsc-caps__ghost';
const STYLE_ID = 'wcsc-caps-style';

const LAYER_CSS = `
.${LAYER_CLASS}{position:fixed;inset:0;z-index:${LAYER_Z};pointer-events:none;}
.${GHOST_CLASS}{position:absolute;pointer-events:none;}
`;

export interface ShortcutCapDeps {
  inputCard: HTMLElement;

  switcher: { readonly scoops: ReadonlyArray<unknown> };

  root: HTMLElement;
}

interface CapSpec {
  commands: readonly CommandId[];
  find(deps: ShortcutCapDeps): HTMLElement | null;
  placement?: string;
}

function labelFor(spec: CapSpec, keymap: Readonly<Record<string, CommandId>>): string | null {
  const keys = spec.commands
    .map((command) => commandKeyLabel(keymap, command))
    .filter((key) => key !== null);
  return keys.length === 0 ? null : keys.join(' ');
}

function railItem(command: CommandId): CapSpec {
  return {
    commands: [command],
    find: (deps) => {
      const id = commandSurfaceId(command);
      return id
        ? deps.root.ownerDocument.querySelector<HTMLElement>(
            `slicc-dock-item[item-id="${escapeAttr(id)}"]`
          )
        : null;
    },
  };
}

function escapeAttr(value: string): string {
  return typeof globalThis.CSS?.escape === 'function'
    ? globalThis.CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}

const SPECS: readonly CapSpec[] = [
  {
    commands: ['prevAgent', 'nextAgent'],
    find: (deps) =>
      deps.switcher.scoops.length > 1
        ? deps.root.ownerDocument.querySelector<HTMLElement>(
            'slicc-agent-tabs [part="track-frame"]'
          )
        : null,
    placement: 'end',
  },
  railItem('tabs'),
  railItem('files'),
  railItem('terminal'),
  railItem('memory'),
  railItem('monitor'),
  {
    commands: ['sprinkles'],
    find: (deps) =>
      deps.root.ownerDocument.querySelector<HTMLElement>('slicc-dock-item[kind="sprinkle"]'),
  },
  {
    commands: ['leftRail'],
    find: (deps) =>
      deps.root.ownerDocument.querySelector<HTMLElement>('slicc-freezer [part="toggle"]'),
  },
  {
    commands: ['attach'],
    find: (deps) => deps.inputCard.querySelector<HTMLElement>('slicc-add-menu'),

    placement: 'top-start',
  },
  {
    commands: ['stop'],
    find: (deps) => deps.inputCard.querySelector<HTMLElement>('slicc-send-button'),
  },
  {
    commands: ['composer'],
    find: (deps) => deps.inputCard.querySelector<HTMLElement>('textarea'),
    placement: 'top-start',
  },
];

function flip(placement: string, rect: DOMRect, width = globalThis.innerWidth): string {
  if (placement.endsWith('end') && rect.right + OVERHANG_PX > width) {
    return placement.replace(/end$/, 'start');
  }
  if (placement.endsWith('start') && rect.left - OVERHANG_PX < 0) {
    return placement.replace(/start$/, 'end');
  }
  return placement;
}

type KeycapElement = HTMLElement & { anchor?: HTMLElement | null };

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = LAYER_CSS;
  (doc.head ?? doc.documentElement)?.append(style);
}

export function createShortcutCaps(deps: ShortcutCapDeps): ShortcutCaps {
  const doc = deps.root.ownerDocument;
  const view = doc.defaultView;

  let layer: HTMLElement | null = null;
  let keymap: Readonly<Record<string, CommandId>> = {};

  const mounted = new Map<number, { ghost: HTMLElement; cap: KeycapElement }>();

  let frame = 0;
  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;

  const schedule = (): void => {
    if (!layer || frame !== 0 || !view) return;
    frame = view.requestAnimationFrame(() => {
      frame = 0;
      if (layer) sync();
    });
  };

  const drop = (index: number): void => {
    const live = mounted.get(index);
    if (!live) return;

    live.cap.anchor = null;
    live.ghost.remove();
    mounted.delete(index);
  };

  function sync(): void {
    if (!layer) return;
    SPECS.forEach((spec, index) => {
      const label = labelFor(spec, keymap);
      const target = label === null ? null : spec.find(deps);
      const rect = target?.getBoundingClientRect();

      if (label === null || !target || !rect || rect.width === 0 || rect.height === 0) {
        drop(index);
        return;
      }

      let live = mounted.get(index);
      if (!live) {
        const ghost = doc.createElement('div');
        ghost.className = GHOST_CLASS;
        const cap = doc.createElement('slicc-keycap') as KeycapElement;
        cap.setAttribute('stagger', String(index));
        ghost.append(cap);
        layer?.append(ghost);
        live = { ghost, cap };
        mounted.set(index, live);
      }

      const placement = flip(spec.placement ?? 'top-end', rect);
      if (live.cap.getAttribute('placement') !== placement) {
        live.cap.setAttribute('placement', placement);
      }

      if (live.cap.getAttribute('cap') !== label) live.cap.setAttribute('cap', label);

      if (live.cap.anchor !== target) live.cap.anchor = target;

      const style = live.ghost.style;
      style.left = `${rect.left}px`;
      style.top = `${rect.top}px`;
      style.width = `${rect.width}px`;
      style.height = `${rect.height}px`;

      resizeObserver?.observe(target);
    });
  }

  const show = (next: Readonly<Record<string, CommandId>>): void => {
    keymap = next;
    if (layer) {
      sync();
      return;
    }
    ensureStyle(doc);
    layer = doc.createElement('div');
    layer.className = LAYER_CLASS;

    layer.dataset.wcShortcuts = 'caps';
    doc.body.append(layer);

    if (view?.ResizeObserver) resizeObserver = new view.ResizeObserver(schedule);

    if (view?.MutationObserver) {
      mutationObserver = new view.MutationObserver(schedule);
      mutationObserver.observe(deps.inputCard, { childList: true, subtree: true });
      const dock = doc.querySelector('slicc-dock');
      if (dock) mutationObserver.observe(dock, { childList: true, subtree: true });
    }

    view?.addEventListener('resize', schedule);
    doc.addEventListener('scroll', schedule, { capture: true, passive: true });
    resizeObserver?.observe(doc.documentElement);

    sync();
  };

  const hide = (): void => {
    if (!layer) return;
    if (frame !== 0) {
      view?.cancelAnimationFrame(frame);
      frame = 0;
    }
    for (const index of [...mounted.keys()]) drop(index);
    resizeObserver?.disconnect();
    resizeObserver = null;
    mutationObserver?.disconnect();
    mutationObserver = null;
    view?.removeEventListener('resize', schedule);
    doc.removeEventListener('scroll', schedule, { capture: true });
    layer.remove();
    layer = null;
  };

  return { show, hide, destroy: hide };
}
