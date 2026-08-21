/**
 * "Cones" section of the freezer rail (#1666 phase 4): one row per root
 * unit (click = switch, ✕ = remove) plus a "New cone" affordance that asks
 * for a name. Lives next to "New chat" because that is where session-level
 * management already happens; followers never mount it (the leader owns the
 * registry), they just see every cone in the switcher.
 *
 * Removal is a two-step inline confirm and is hidden on the last root — the
 * kernel refuses that drop as well, this is the visible half of the rule.
 * "Make default" (★) picks the root unaddressed licks and events land in
 * (#2273); the star is inert on the cone that already holds it, and both
 * affordances only appear once a second cone exists.
 * The rail re-renders from `client.getScoops()` whenever the scoop roster or
 * the active chip changes, so it never holds state of its own beyond the
 * in-progress name / confirm.
 */

import type { RegisteredScoop } from '../../scoops/types.js';
import {
  clearDefaultRootJid,
  getDefaultRootJid,
  pickDefaultRoot,
  setDefaultRootJid,
} from '../../work-unit/default-root.js';
import { buildWorkUnitRecord } from '../../work-unit/manager.js';
import { rootsOf } from '../../work-unit/policy.js';
import type { OffscreenClient } from '../offscreen-client.js';
import { switcherLabelFor } from './wc-unit-context.js';

export interface ConesRailDeps {
  /** The freezer rail to mount into and the switcher whose `active` attribute to mirror. */
  refs: { freezer: HTMLElement; switcher: Element };
  client: Pick<OffscreenClient, 'getScoops' | 'registerScoop' | 'unregisterScoop'>;
  getSelected(): RegisteredScoop | null;
  selectScoop(scoop: RegisteredScoop): void;
  log: { warn(message: string, ...rest: unknown[]): void };
}

export interface ConesRailHandles {
  /** Re-render from the live roster (roster or selection changed). */
  refresh(): void;
  /** The section root, for tests and layout tweaks. */
  element: HTMLElement;
}

const STYLE_ID = 'wcui-cones-style';
const STYLE = `
.wcui-cones{display:flex;flex-direction:column;gap:2px;margin:2px 0 6px;flex:0 0 auto;}
.wcui-cones[hidden]{display:none;}
.wcui-cones .hd{font:500 11px/1 var(--ui);letter-spacing:.04em;text-transform:uppercase;
  color:color-mix(in srgb,var(--ink) 55%,transparent);padding:6px 8px 4px;white-space:nowrap;overflow:hidden;}
.wcui-cones:not([expanded]) .hd,.wcui-cones:not([expanded]) .lbl,.wcui-cones:not([expanded]) .rm,
.wcui-cones:not([expanded]) .def,
.wcui-cones:not([expanded]) .nlbl,.wcui-cones:not([expanded]) .form{display:none;}
.wcui-cones .row{display:flex;align-items:center;gap:8px;min-height:32px;padding:2px 6px;border-radius:8px;
  background:transparent;border:none;color:var(--ink);font:inherit;font-family:var(--ui);text-align:left;width:100%;cursor:pointer;}
.wcui-cones .row:hover{background:var(--ghost);}
.wcui-cones .row[aria-current="true"]{background:color-mix(in srgb,var(--ctx) 14%,transparent);}
.wcui-cones .row:focus-visible,.wcui-cones .rm:focus-visible,.wcui-cones .add:focus-visible{outline:2px solid var(--ctx);outline-offset:2px;}
.wcui-cones .dot{width:10px;height:10px;border-radius:50%;flex:0 0 auto;background:var(--dot,var(--ctx));
  border:1px solid color-mix(in srgb,var(--ink) 25%,transparent);}
.wcui-cones .lbl{flex:1;min-width:0;font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.wcui-cones .rm{flex:0 0 auto;width:22px;height:22px;border:none;border-radius:6px;background:transparent;color:inherit;
  opacity:.55;cursor:pointer;font:inherit;line-height:1;}
.wcui-cones .rm:hover{opacity:1;background:var(--ghost);}
.wcui-cones .def{flex:0 0 auto;width:22px;height:22px;border:none;border-radius:6px;background:transparent;color:inherit;
  opacity:.4;cursor:pointer;font:inherit;line-height:1;}
.wcui-cones .def:hover{opacity:.85;background:var(--ghost);}
.wcui-cones .def[aria-pressed="true"]{opacity:1;color:var(--ctx);cursor:default;}
.wcui-cones .def:focus-visible{outline:2px solid var(--ctx);outline-offset:2px;}
.wcui-cones .confirm{display:flex;align-items:center;gap:6px;padding:2px 6px 4px 30px;font:500 12px var(--ui);color:var(--ink);}
.wcui-cones .confirm button{border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;
  font:inherit;padding:2px 8px;cursor:pointer;}
.wcui-cones .confirm .danger{border-color:color-mix(in srgb,#d23 50%,var(--line));color:#d23;}
.wcui-cones .add{display:flex;align-items:center;gap:10px;min-height:32px;padding:2px 8px;border-radius:8px;
  background:transparent;border:none;color:var(--ink);font:inherit;font-family:var(--ui);text-align:left;width:100%;cursor:pointer;}
.wcui-cones .add:hover{background:var(--ghost);}
.wcui-cones:not([expanded]) .add{justify-content:center;padding:2px 0;}
.wcui-cones .plus{width:22px;height:22px;display:grid;place-items:center;border-radius:50%;
  background:color-mix(in srgb,var(--ctx) 14%,var(--canvas));border:1px solid color-mix(in srgb,var(--ctx) 40%,var(--line));color:var(--ctx);font-size:14px;line-height:1;}
.wcui-cones .nlbl{font-size:12.5px;font-weight:500;}
.wcui-cones .form{display:flex;gap:6px;padding:2px 8px 4px;}
.wcui-cones .form input{flex:1;min-width:0;border:1px solid var(--line);border-radius:6px;background:var(--canvas);color:var(--ink);
  font:inherit;font-family:var(--ui);font-size:12.5px;padding:4px 6px;}
.wcui-cones .form button{border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;font:inherit;padding:2px 8px;cursor:pointer;}
`;

function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Build the optimistic record the panel registers for a new cone. */
export function buildNewConeRecord(
  name: string,
  existing: readonly RegisteredScoop[]
): RegisteredScoop {
  // The kernel assigns the real folder / jid (`handleConeCreate`); the panel
  // only needs a placeholder that reads as a root until `scoop-created`
  // replaces it by name.
  const placeholder = `cone-pending-${existing.length + 1}`;
  return {
    ...buildWorkUnitRecord({ parentId: null, name, folder: placeholder }),
    assistantLabel: name,
  };
}

/** Terse `createElement` with attributes + text, bound to one document. */
type El = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  text?: string
) => HTMLElementTagNameMap[K];

function makeEl(doc: Document): El {
  return (tag, attrs = {}, text) => {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  };
}

interface ConeRowOptions {
  el: El;
  scoop: RegisteredScoop;
  selected: boolean;
  /** This cone currently receives unaddressed licks and events. */
  isDefault: boolean;
  /** Render the ★ / ✕ actions (suppressed while there is only one cone). */
  showActions: boolean;
  onSelect(): void;
  onMakeDefault(): void;
  onToggleRemove(): void;
}

/**
 * The ★ toggle: which root unaddressed licks and events land in (#2273).
 * Inert on the cone that already holds it — this is a choice among cones,
 * not a per-cone on/off.
 */
function buildDefaultRootToggle(o: ConeRowOptions): HTMLButtonElement {
  const label = switcherLabelFor(o.scoop);
  const star = o.el(
    'button',
    {
      type: 'button',
      class: 'def',
      'aria-pressed': o.isDefault ? 'true' : 'false',
      'aria-label': o.isDefault
        ? `${label} receives unaddressed events`
        : `Make ${label} the default cone`,
      title: o.isDefault
        ? 'Default cone — webhooks, cron and other unaddressed events land here'
        : 'Make default for unaddressed events',
    },
    o.isDefault ? '★' : '☆'
  );
  star.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!o.isDefault) o.onMakeDefault();
  });
  return star;
}

/** One cone row: switch on click, ★ picks the default, ✕ starts the confirm. */
function buildConeRow(o: ConeRowOptions): HTMLButtonElement {
  const label = switcherLabelFor(o.scoop);
  const row = o.el('button', {
    type: 'button',
    class: 'row',
    'data-jid': o.scoop.jid,
    'aria-current': o.selected ? 'true' : 'false',
    title: label,
  });
  row.append(o.el('span', { class: 'dot' }), o.el('span', { class: 'lbl' }, label));
  row.addEventListener('click', o.onSelect);
  if (!o.showActions) return row;
  row.append(buildDefaultRootToggle(o));
  const rm = o.el(
    'button',
    { type: 'button', class: 'rm', 'aria-label': `Remove cone ${label}` },
    '✕'
  );
  rm.addEventListener('click', (event) => {
    event.stopPropagation();
    o.onToggleRemove();
  });
  row.append(rm);
  return row;
}

/** Two-step removal confirm rendered under the row it belongs to. */
function buildRemoveConfirm(
  el: El,
  handlers: { onConfirm(): void; onCancel(): void }
): HTMLElement {
  const confirm = el('div', { class: 'confirm' });
  confirm.append(el('span', {}, 'Remove this cone and its scoops?'));
  const yes = el('button', { type: 'button', class: 'danger' }, 'Remove');
  yes.addEventListener('click', handlers.onConfirm);
  const no = el('button', { type: 'button' }, 'Cancel');
  no.addEventListener('click', handlers.onCancel);
  confirm.append(yes, no);
  return confirm;
}

/** Mount the Cones section into the freezer rail and keep it in sync. */
export function wireConesRail(deps: ConesRailDeps): ConesRailHandles {
  const { refs, client, log } = deps;
  const doc = refs.freezer.ownerDocument;
  ensureStyles(doc);
  const el = makeEl(doc);

  const section = doc.createElement('div');
  section.className = 'wcui-cones';
  section.setAttribute('role', 'group');
  section.setAttribute('aria-label', 'Cones');

  let pendingRemove: string | null = null;
  let adding = false;
  let draftName = '';
  /** Name of a cone we just asked the kernel for — selected once it lands. */
  let pendingSelect: string | null = null;

  const remove = (scoop: RegisteredScoop): void => {
    pendingRemove = null;
    // Never remove the last cone — the ✕ is hidden in that state, the
    // client and the kernel refuse it too; this guards a stale confirm.
    if (rootsOf(client.getScoops()).length <= 1) {
      render();
      return;
    }
    const wasSelected = deps.getSelected()?.jid === scoop.jid;
    // Dropping the cone that events default to forgets the pick, so the
    // fallback (primary, else oldest) takes over instead of leaving a jid
    // that resolves to nothing.
    if (getDefaultRootJid() === scoop.jid) clearDefaultRootJid();
    void client.unregisterScoop(scoop.jid).catch((err) => log.warn('WC cone remove failed', err));
    if (wasSelected) {
      const next = rootsOf(client.getScoops()).find((s) => s.jid !== scoop.jid);
      if (next) deps.selectScoop(next);
    }
    render();
  };

  const create = (): void => {
    const name = draftName.trim();
    if (!name) return;
    adding = false;
    draftName = '';
    const record = buildNewConeRecord(name, client.getScoops());
    pendingSelect = name;
    void client.registerScoop(record).catch((err) => log.warn('WC cone create failed', err));
    render();
  };

  /** Adopt the kernel's real record for a cone this rail just asked for. */
  const adoptPendingSelection = (roots: readonly RegisteredScoop[]): void => {
    if (pendingSelect === null) return;
    const landed = roots.find(
      (s) => s.name === pendingSelect && !s.folder.startsWith('cone-pending-')
    );
    if (!landed) return;
    pendingSelect = null;
    if (deps.getSelected()?.jid !== landed.jid) deps.selectScoop(landed);
  };

  const render = (): void => {
    const roots = rootsOf(client.getScoops());
    // A cone created from this rail becomes the active one as soon as the
    // kernel's real record (not the optimistic placeholder) is in the roster.
    adoptPendingSelection(roots);
    const selected = deps.getSelected()?.jid ?? refs.switcher.getAttribute('active');
    // Resolved, not raw: a stale or unset pick still stars the root that
    // events actually reach (primary, else oldest).
    const defaultJid = pickDefaultRoot(roots)?.jid;
    section.replaceChildren();
    section.append(el('div', { class: 'hd' }, 'Cones'));
    for (const scoop of roots) {
      section.append(
        buildConeRow({
          el,
          scoop,
          selected: selected === scoop.jid,
          isDefault: defaultJid === scoop.jid,
          // A single cone owns everything by definition: nothing to remove,
          // nothing to choose between.
          showActions: roots.length > 1,
          onSelect: () => {
            if (deps.getSelected()?.jid !== scoop.jid) deps.selectScoop(scoop);
          },
          onMakeDefault: () => {
            setDefaultRootJid(scoop.jid);
            render();
          },
          onToggleRemove: () => {
            pendingRemove = pendingRemove === scoop.jid ? null : scoop.jid;
            render();
          },
        })
      );
      if (pendingRemove === scoop.jid) {
        section.append(
          buildRemoveConfirm(el, {
            onConfirm: () => remove(scoop),
            onCancel: () => {
              pendingRemove = null;
              render();
            },
          })
        );
      }
    }
    section.append(adding ? buildAddForm() : buildAddButton());
  };

  const buildAddButton = (): HTMLElement => {
    const add = el('button', { type: 'button', class: 'add', 'aria-label': 'New cone' });
    add.append(el('span', { class: 'plus' }, '+'), el('span', { class: 'nlbl' }, 'New cone'));
    add.addEventListener('click', () => {
      adding = true;
      render();
    });
    return add;
  };

  const buildAddForm = (): HTMLElement => {
    const form = el('form', { class: 'form' });
    const input = el('input', {
      type: 'text',
      placeholder: 'Cone name',
      'aria-label': 'New cone name',
      maxlength: '40',
    });
    input.value = draftName;
    input.addEventListener('input', () => {
      draftName = input.value;
    });
    const cancel = el('button', { type: 'button' }, 'Cancel');
    cancel.addEventListener('click', () => {
      adding = false;
      draftName = '';
      render();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      create();
    });
    form.append(input, el('button', { type: 'submit' }, 'Create'), cancel);
    queueMicrotask(() => input.focus());
    return form;
  };

  // Mirror the rail's open/collapsed state (`slicc-freezer` toggles
  // `expanded` on its known children only, so we track it ourselves).
  const syncExpanded = (): void => {
    const open =
      refs.freezer.hasAttribute('open') ||
      refs.freezer.querySelector('slicc-freezer-new')?.hasAttribute('expanded') === true;
    section.toggleAttribute('expanded', open);
  };
  refs.freezer.addEventListener('freezer-toggle', (event) => {
    const open = (event as CustomEvent<{ open?: boolean }>).detail?.open === true;
    section.toggleAttribute('expanded', open);
  });
  // Selection highlight follows the switcher's `active` attribute.
  if (typeof MutationObserver === 'function') {
    new MutationObserver(render).observe(refs.switcher, {
      attributes: true,
      attributeFilter: ['active'],
    });
  }

  refs.freezer.append(section);
  syncExpanded();
  render();
  return { refresh: render, element: section };
}
