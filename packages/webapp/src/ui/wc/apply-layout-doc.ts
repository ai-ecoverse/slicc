/**
 * `apply-layout-doc.ts` — the page-side handler for the layout-DOCUMENT verbs
 * (`load`/`save`/`delete`/`docs`/`panels`/`show`/`hide`), plus a bridge for the
 * four dock-tree verbs (`open`/`close`/`move`/`chat`) that still express the same
 * intent against a panel layout.
 *
 * Split from `apply-layout.ts`, which handles the dock-tree verbs against the
 * older `WcSprinkleZone`: these operate on a `<slicc-layout>` plus the VFS and the
 * panel registry, and share none of that machinery. Keeping them apart also means
 * a float running the classic shell simply never loads this module.
 *
 * Every verb returns `{ applied, output?, error? }` — the shell prints `output`
 * and fails on `error`, because only the page can enumerate the VFS, the
 * registry, or the arrangement currently on screen.
 */

import {
  type LayoutDocument,
  listPanels,
  type SliccLayout,
  type ZoneName,
} from '@slicc/webcomponents';
import { createLogger } from '../../base/logger.js';
import type { DockZoneName } from '../../core/dock-tree-spec.js';
import type { VirtualFS } from '../../fs/index.js';
import type { LayoutApplyMsg } from '../../shell/supplemental-commands/layout-command.js';
import { PANEL_IDS } from './builtin-panels.js';
import { getLayoutDoc, layoutDocNames } from './default-layouts.js';
import { deleteLayout, listLayouts, loadLayoutByName, writeLayout } from './layout-store.js';
import { setPanelVisible } from './panel-visibility.js';

const log = createLogger('apply-layout-doc');

/** The document verbs this module handles. */
export type LayoutDocMsg =
  | { kind: 'load'; name: string }
  | { kind: 'save'; name: string; protected: boolean }
  | { kind: 'delete'; name: string }
  | { kind: 'docs' }
  | { kind: 'panels' }
  | { kind: 'show'; panelId: string }
  | { kind: 'hide'; panelId: string };

/** Result shape mirroring the `layout-apply` RPC contract. */
export interface LayoutDocResult {
  applied: boolean;
  output?: string;
  error?: string;
}

export interface LayoutDocDeps {
  layout: SliccLayout;
  /**
   * VFS handle. Optional because the purely in-memory verbs (`show`/`hide`, and
   * `load` of a shipped preset) work without one — the design-time preview and
   * tests panelize with no filesystem. The VFS-backed verbs report a clear error
   * instead of throwing when it is absent.
   */
  fs?: VirtualFS;
}

/** Error for a verb that needs the VFS in a context that has none. */
function noFs(verb: string): LayoutDocResult {
  return { applied: false, error: `layout ${verb} needs a filesystem (unavailable here)` };
}

/** Whether a message is one of the document verbs (vs. a dock-tree verb). */
export function isLayoutDocMsg(msg: { kind: string }): msg is LayoutDocMsg {
  return ['load', 'save', 'delete', 'docs', 'panels', 'show', 'hide'].includes(msg.kind);
}

/** The four dock-tree verbs {@link applyLegacyLayoutMsg} can bridge onto a panel layout. */
type LegacyBridgeMsg = Extract<LayoutApplyMsg, { kind: 'open' | 'close' | 'move' | 'chat' }>;

/** Whether a message is one of the dock-tree verbs {@link applyLegacyLayoutMsg} bridges. */
export function isBridgeableLegacyMsg(msg: { kind: string }): msg is LegacyBridgeMsg {
  return ['open', 'close', 'move', 'chat'].includes(msg.kind);
}

/** Dock-tree zone name → panel-system zone name. Every word matches except `middle`/`center`. */
function toPanelZone(zone: DockZoneName): ZoneName {
  return zone === 'middle' ? 'center' : zone;
}

/**
 * Bridge the four dock-tree verbs an agent's `layout` shell command already
 * speaks onto the panel-system's equivalent primitives, so a sprinkle created
 * and opened mid-session (the established pattern across every experiment
 * type — see e.g. `vfs-root/workspace/skills/sprinkles/SKILL.md`) lands the
 * same way whether the follower is on the dock-tree or panel layouts.
 *
 * `open`/`chat` reuse `setPanelVisible` (the same primitive the add-panel menu
 * uses), which places a not-yet-placed panel into the `right` zone by default,
 * then `applyMove` corrects it to whichever zone the caller actually asked for.
 * `close` hides rather than destroys, matching "unplaced panels are parked,
 * not destroyed" elsewhere in the panel system.
 */
export function applyLegacyLayoutMsg(deps: LayoutDocDeps, msg: LegacyBridgeMsg): LayoutDocResult {
  switch (msg.kind) {
    case 'open':
      setPanelVisible(deps.layout, msg.surfaceId, true);
      deps.layout.applyMove(msg.surfaceId, toPanelZone(msg.zone));
      return { applied: true };
    case 'close':
      setPanelVisible(deps.layout, msg.surfaceId, false);
      return { applied: true };
    case 'move':
      deps.layout.applyMove(msg.surfaceId, toPanelZone(msg.zone));
      return { applied: true };
    case 'chat':
      deps.layout.applyMove(PANEL_IDS.chat, toPanelZone(msg.zone));
      return { applied: true };
  }
}

/**
 * Load a layout by name: a saved document first, then a shipped preset.
 *
 * Saved-first so a user's own `default.json` overrides the shipped `default` —
 * the same shadowing rule `listLayouts` uses, and the thing that makes "save your
 * arrangement and get it back next session" work without a separate preference.
 */
async function handleLoad(deps: LayoutDocDeps, name: string): Promise<LayoutDocResult> {
  // A saved document wins over a preset of the same name, but with no VFS we can
  // still serve presets — so this degrades rather than failing.
  const stored = deps.fs ? await loadLayoutByName(deps.fs, name) : null;
  if (stored) {
    deps.layout.setLayout(stored.doc);
    return { applied: true, output: `loaded layout "${name}" from ${stored.path}` };
  }
  const preset = getLayoutDoc(name);
  if (preset) {
    deps.layout.setLayout(preset);
    return { applied: true, output: `loaded preset "${name}"` };
  }
  return {
    applied: false,
    error: `unknown layout "${name}" — try: ${layoutDocNames().join(', ')}`,
  };
}

/**
 * Save the CURRENTLY LOADED document under `name`.
 *
 * Saves `getLayout()` (the document) rather than `getResolved()` (the
 * variant-applied arrangement): resolution is viewport-dependent, so persisting
 * the resolved form would freeze whatever breakpoint happened to be active and
 * throw away every other variant. The document is the reusable artifact.
 */
async function handleSave(
  deps: LayoutDocDeps,
  name: string,
  isProtected: boolean
): Promise<LayoutDocResult> {
  if (!deps.fs) return noFs('save');
  const doc: LayoutDocument = { ...deps.layout.getLayout(), id: name };
  try {
    const path = await writeLayout(deps.fs, doc, { name, protected: isProtected });
    return { applied: true, output: `saved layout to ${path}` };
  } catch (err) {
    // A denied approval on the protected root lands here — report it plainly
    // rather than as an unexplained failure.
    const message = err instanceof Error ? err.message : String(err);
    log.warn('layout save failed', { name, protected: isProtected, error: message });
    return { applied: false, error: `could not save "${name}": ${message}` };
  }
}

/** List saved documents and shipped presets, marking which saves are gated. */
async function handleDocs(deps: LayoutDocDeps): Promise<LayoutDocResult> {
  const saved = deps.fs ? await listLayouts(deps.fs) : [];
  const lines: string[] = [];
  if (saved.length > 0) {
    lines.push('saved layouts:');
    for (const entry of saved) {
      lines.push(`  ${entry.name}${entry.protected ? '  (protected)' : ''}  ${entry.path}`);
    }
  }
  lines.push(`presets: ${layoutDocNames().join(', ')}`);
  const current = deps.layout.getLayout();
  lines.push(`current: ${current.id}`);
  return { applied: true, output: lines.join('\n') };
}

/** List every registered panel, grouped by origin, marking which are placed. */
function handlePanels(deps: LayoutDocDeps): LayoutDocResult {
  const placed = new Set(deps.layout.getPlacedPanelIds());
  const groups: Record<string, string[]> = { builtin: [], sprinkle: [], agent: [] };
  for (const entry of listPanels()) {
    const mark = placed.has(entry.meta.id) ? '*' : ' ';
    (groups[entry.origin] ??= []).push(`  ${mark} ${entry.meta.id}  ${entry.meta.title}`);
  }
  const lines: string[] = [];
  for (const [origin, rows] of Object.entries(groups)) {
    if (rows.length === 0) continue;
    lines.push(`${origin}:`);
    lines.push(...rows);
  }
  lines.push('(* = currently placed)');
  return { applied: true, output: lines.join('\n') };
}

/**
 * Show or hide a panel.
 *
 * Delegates to the shared `setPanelVisible`, which also ADDS the panel to the
 * arrangement when it isn't placed yet. Writing only the `visible` override — what
 * this did before — rendered nothing for any panel the document doesn't mention,
 * which is every tool panel and every sprinkle until first opened: `layout show
 * files` reported success and put nothing on screen.
 */
function handleVisibility(deps: LayoutDocDeps, panelId: string, visible: boolean): LayoutDocResult {
  setPanelVisible(deps.layout, panelId, visible);
  return { applied: true };
}

/** Apply one document verb. */
export async function applyLayoutDoc(
  deps: LayoutDocDeps,
  msg: LayoutDocMsg
): Promise<LayoutDocResult> {
  switch (msg.kind) {
    case 'load':
      return handleLoad(deps, msg.name);
    case 'save':
      return handleSave(deps, msg.name, msg.protected);
    case 'delete': {
      if (!deps.fs) return noFs('delete');
      // Try both roots: the user shouldn't have to know which one holds it.
      const removed =
        (await deleteLayout(deps.fs, msg.name)) ||
        (await deleteLayout(deps.fs, msg.name, { protected: true }));
      return removed
        ? { applied: true, output: `deleted layout "${msg.name}"` }
        : { applied: false, error: `no saved layout named "${msg.name}"` };
    }
    case 'docs':
      return handleDocs(deps);
    case 'panels':
      return handlePanels(deps);
    case 'show':
      return handleVisibility(deps, msg.panelId, true);
    case 'hide':
      return handleVisibility(deps, msg.panelId, false);
  }
}
