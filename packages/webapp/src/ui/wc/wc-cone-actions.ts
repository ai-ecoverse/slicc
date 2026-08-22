/**
 * Cone actions of the freezer rail (#1666 / #2272): the `new-cone` and
 * `drop-cone` events `<slicc-freezer-new>` fires from its expanded action
 * row, plus the cone count that decides which of the two it shows.
 *
 * There is no cone list here — the top tab strip is the only switcher. The
 * rail only ever grows by one click-triggered line (the name form for a new
 * cone, the confirm for a drop), never on hover, so the layout stays put.
 *
 * Dropping a cone freezes its chat without extracting memories and keeps its
 * frozen cards; the next-oldest root becomes the primary. The last cone can
 * never be dropped — the row hides the action, the client and the kernel
 * refuse it too. Followers never mount this (the leader owns the registry).
 */

import type { RegisteredScoop } from '../../scoops/types.js';
import { buildWorkUnitRecord } from '../../work-unit/manager.js';
import { rootsOf } from '../../work-unit/policy.js';
import type { OffscreenClient } from '../offscreen-client.js';
import { rootForSelection, switcherLabelFor } from './wc-unit-context.js';

export interface ConeActionsDeps {
  /** The freezer rail; the action row is its `<slicc-freezer-new>` child. */
  freezer: HTMLElement;
  client: Pick<OffscreenClient, 'getScoops' | 'registerScoop' | 'unregisterScoop'>;
  getSelected(): RegisteredScoop | null;
  selectScoop(scoop: RegisteredScoop): void;
  /**
   * Archive the cone's chat before it goes (the freezer, no memory
   * extraction). Resolves once the archive is durable; a failure is logged
   * and the drop proceeds — the kernel's cascade would lose the chat
   * otherwise, so the caller must only reject on a truly unrecoverable VFS.
   */
  freezeCone(root: RegisteredScoop): Promise<void>;
  log: { warn(message: string, ...rest: unknown[]): void };
}

export interface ConeActionsHandles {
  /** Re-sync the row's cone count and the pending-selection with the roster. */
  refresh(): void;
  /** The inline form / confirm line under the row (for tests). */
  element: HTMLElement;
}

const STYLE_ID = 'wcui-cone-actions-style';
const STYLE = `
.wcui-cone-line{display:flex;align-items:center;gap:6px;padding:2px 8px 6px;flex:0 0 auto;font:500 12px var(--ui);color:var(--ink);}
.wcui-cone-line:empty{display:none;}
.wcui-cone-line input{flex:1;min-width:0;border:1px solid var(--line);border-radius:6px;background:var(--canvas);color:var(--ink);
  font:inherit;font-family:var(--ui);font-size:12.5px;padding:4px 6px;}
.wcui-cone-line button{border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;font:inherit;padding:2px 8px;cursor:pointer;}
.wcui-cone-line button:focus-visible,.wcui-cone-line input:focus-visible{outline:2px solid var(--ctx);outline-offset:2px;}
.wcui-cone-line .danger{border-color:color-mix(in srgb,#d23 50%,var(--line));color:#d23;}
.wcui-cone-line .msg{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
`;

function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Build the optimistic record the rail registers for a new cone. */
export function buildNewConeRecord(
  name: string,
  existing: readonly RegisteredScoop[]
): RegisteredScoop {
  // The kernel assigns the real folder / jid (`handleConeCreate`); the rail
  // only needs a placeholder that reads as a root until `scoop-created`
  // replaces it by name.
  const placeholder = `cone-pending-${existing.length + 1}`;
  return {
    ...buildWorkUnitRecord({ parentId: null, name, folder: placeholder }),
    assistantLabel: name,
  };
}

/** Wire the row's cone actions and keep its cone count in sync. */
export function wireConeActions(deps: ConeActionsDeps): ConeActionsHandles {
  const { freezer, client, log } = deps;
  const doc = freezer.ownerDocument;
  ensureStyles(doc);

  const line = doc.createElement('div');
  line.className = 'wcui-cone-line';
  line.setAttribute('role', 'group');
  line.setAttribute('aria-label', 'Cone');

  type Pending = { kind: 'name'; draft: string } | { kind: 'drop'; jid: string } | null;
  let pending: Pending = null;
  /** Name of a cone we just asked the kernel for — selected once it lands. */
  let pendingSelect: string | null = null;
  let dropping = false;

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Record<string, string> = {},
    text?: string
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const row = (): HTMLElement | null => freezer.querySelector('slicc-freezer-new');

  /** The root the actions apply to: the selected cone (or the one owning the selected scoop). */
  const currentRoot = (): RegisteredScoop | undefined =>
    rootForSelection(client.getScoops(), deps.getSelected());

  const create = (): void => {
    if (pending?.kind !== 'name') return;
    const name = pending.draft.trim();
    if (!name) return;
    pending = null;
    const record = buildNewConeRecord(name, client.getScoops());
    pendingSelect = name;
    void client.registerScoop(record).catch((err) => log.warn('WC cone create failed', err));
    render();
  };

  const drop = (jid: string): void => {
    pending = null;
    const roots = rootsOf(client.getScoops());
    const root = roots.find((s) => s.jid === jid);
    // Never drop the last cone — the row hides the action in that state and
    // the client and the kernel refuse it too; this guards a stale confirm.
    if (!root || roots.length <= 1 || dropping) {
      render();
      return;
    }
    dropping = true;
    render();
    void (async () => {
      try {
        await deps.freezeCone(root);
      } catch (err) {
        log.warn('WC cone freeze before drop failed', err);
      }
      // Move off the cone first so nothing renders a unit that is going away;
      // the oldest surviving root is the primary, so that is the fallback.
      const wasMine = currentRoot()?.jid === root.jid;
      try {
        await client.unregisterScoop(root.jid);
      } catch (err) {
        log.warn('WC cone drop failed', err);
      }
      if (wasMine) {
        const next = rootsOf(client.getScoops()).find((s) => s.jid !== root.jid);
        if (next) deps.selectScoop(next);
      }
      dropping = false;
      render();
    })();
  };

  const render = (): void => {
    const roots = rootsOf(client.getScoops());
    // A cone created from the row becomes the active one as soon as the
    // kernel's real record (not the optimistic placeholder) is in the roster.
    if (pendingSelect !== null) {
      const landed = roots.find(
        (s) => s.name === pendingSelect && !s.folder.startsWith('cone-pending-')
      );
      if (landed) {
        pendingSelect = null;
        if (deps.getSelected()?.jid !== landed.jid) deps.selectScoop(landed);
      }
    }
    row()?.setAttribute('cones', String(roots.length));

    line.replaceChildren();
    if (pending?.kind === 'name') {
      const form = el('form');
      form.style.display = 'contents';
      const input = el('input', {
        type: 'text',
        placeholder: 'Cone name',
        'aria-label': 'New cone name',
        maxlength: '40',
      });
      input.value = pending.draft;
      input.addEventListener('input', () => {
        if (pending?.kind === 'name') pending.draft = input.value;
      });
      const ok = el('button', { type: 'submit' }, 'Create');
      const cancel = el('button', { type: 'button' }, 'Cancel');
      cancel.addEventListener('click', () => {
        pending = null;
        render();
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        create();
      });
      form.append(input, ok, cancel);
      line.append(form);
      queueMicrotask(() => input.focus());
    } else if (pending?.kind === 'drop') {
      const jid = pending.jid;
      const root = roots.find((s) => s.jid === jid);
      if (!root || roots.length <= 1) {
        pending = null;
      } else {
        line.append(
          el(
            'span',
            { class: 'msg' },
            `Drop ${switcherLabelFor(root)}? Its chat goes to the freezer.`
          )
        );
        const yes = el('button', { type: 'button', class: 'danger' }, 'Drop');
        yes.addEventListener('click', () => drop(jid));
        const no = el('button', { type: 'button' }, 'Cancel');
        no.addEventListener('click', () => {
          pending = null;
          render();
        });
        line.append(yes, no);
      }
    } else if (dropping) {
      line.append(el('span', { class: 'msg' }, 'Freezing the cone…'));
    }
  };

  freezer.addEventListener('new-cone', () => {
    pending = pending?.kind === 'name' ? null : { kind: 'name', draft: '' };
    render();
  });
  freezer.addEventListener('drop-cone', () => {
    const root = currentRoot();
    pending = !root || pending?.kind === 'drop' ? null : { kind: 'drop', jid: root.jid };
    render();
  });

  // Sits right under the action row, above the frozen cards.
  const anchor = row();
  if (anchor) anchor.after(line);
  else freezer.prepend(line);
  render();
  return { refresh: render, element: line };
}
