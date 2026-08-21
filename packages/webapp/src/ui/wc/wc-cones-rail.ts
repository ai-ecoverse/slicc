/**
 * "Cones" section of the freezer rail (#1666 phase 4): one row per root
 * unit (click = switch, ✕ = remove) plus a "New cone" affordance that asks
 * for a name. Lives next to "New chat" because that is where session-level
 * management already happens; followers never mount it (the leader owns the
 * registry), they just see every cone in the switcher.
 *
 * Removal is a two-step inline confirm and is hidden on the last root — the
 * kernel refuses that drop as well, this is the visible half of the rule.
 * The rail re-renders from `client.getScoops()` whenever the scoop roster or
 * the active chip changes, so it never holds state of its own beyond the
 * in-progress name / confirm.
 */

import type { RegisteredScoop } from '../../scoops/types.js';
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

/** Mount the Cones section into the freezer rail and keep it in sync. */
export function wireConesRail(deps: ConesRailDeps): ConesRailHandles {
  const { refs, client, log } = deps;
  const doc = refs.freezer.ownerDocument;
  ensureStyles(doc);

  const section = doc.createElement('div');
  section.className = 'wcui-cones';
  section.setAttribute('role', 'group');
  section.setAttribute('aria-label', 'Cones');

  let pendingRemove: string | null = null;
  let adding = false;
  let draftName = '';
  /** Name of a cone we just asked the kernel for — selected once it lands. */
  let pendingSelect: string | null = null;

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

  const remove = (scoop: RegisteredScoop): void => {
    pendingRemove = null;
    const wasSelected = deps.getSelected()?.jid === scoop.jid;
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

  const render = (): void => {
    const roots = rootsOf(client.getScoops());
    // A cone created from this rail becomes the active one as soon as the
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
    const selected = deps.getSelected()?.jid ?? refs.switcher.getAttribute('active');
    section.replaceChildren();
    section.append(el('div', { class: 'hd' }, 'Cones'));
    for (const scoop of roots) {
      const row = el('button', {
        type: 'button',
        class: 'row',
        'data-jid': scoop.jid,
        'aria-current': selected === scoop.jid ? 'true' : 'false',
        title: switcherLabelFor(scoop),
      });
      row.append(
        el('span', { class: 'dot' }),
        el('span', { class: 'lbl' }, switcherLabelFor(scoop))
      );
      row.addEventListener('click', () => {
        if (deps.getSelected()?.jid !== scoop.jid) deps.selectScoop(scoop);
      });
      if (roots.length > 1) {
        const rm = el(
          'button',
          { type: 'button', class: 'rm', 'aria-label': `Remove cone ${switcherLabelFor(scoop)}` },
          '✕'
        );
        rm.addEventListener('click', (event) => {
          event.stopPropagation();
          pendingRemove = pendingRemove === scoop.jid ? null : scoop.jid;
          render();
        });
        row.append(rm);
      }
      section.append(row);
      if (pendingRemove === scoop.jid) {
        const confirm = el('div', { class: 'confirm' });
        confirm.append(el('span', {}, 'Remove this cone and its scoops?'));
        const yes = el('button', { type: 'button', class: 'danger' }, 'Remove');
        yes.addEventListener('click', () => remove(scoop));
        const no = el('button', { type: 'button' }, 'Cancel');
        no.addEventListener('click', () => {
          pendingRemove = null;
          render();
        });
        confirm.append(yes, no);
        section.append(confirm);
      }
    }
    if (adding) {
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
      const ok = el('button', { type: 'submit' }, 'Create');
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
      form.append(input, ok, cancel);
      section.append(form);
      queueMicrotask(() => input.focus());
    } else {
      const add = el('button', { type: 'button', class: 'add', 'aria-label': 'New cone' });
      add.append(el('span', { class: 'plus' }, '+'), el('span', { class: 'nlbl' }, 'New cone'));
      add.addEventListener('click', () => {
        adding = true;
        render();
      });
      section.append(add);
    }
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
