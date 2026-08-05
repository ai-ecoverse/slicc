import { type PanelMeta, panelMetaOf } from './panel-meta.js';

/**
 * Panel registry — the single map from a layout document's panel id to something
 * that can render it.
 *
 * Three sources feed it, all through the same `registerPanel`:
 *
 *  1. **Built-ins** — registered at module load from the bundle.
 *  2. **Sprinkles** — every discovered `.shtml` registers an entry whose body is
 *     the existing sandboxed iframe. Sprinkle authoring is unchanged.
 *  3. **Agent-authored** — a manifest + module under `/workspace/panels/<name>/`,
 *     dynamically imported and registered at runtime.
 *
 * The registry is deliberately dumb: it stores descriptors, it does not
 * instantiate, mount, or lay out anything. That keeps it usable from contexts
 * that must enumerate panels WITHOUT building them — the "add panel" menu lists
 * panels that are not mounted, and the layout engine resolves ids to tags before
 * it has slots to put them in.
 *
 * It also lives in `@slicc/webcomponents` rather than the webapp because the
 * component layer is what owns panel identity; the webapp drives it.
 */

/** How a registered panel gets rendered. */
export type PanelSource =
  /** A real custom element in the page realm. `tag` must already be defined. */
  | { kind: 'element'; tag: string }
  /**
   * A body rendered inside the sandboxed sprinkle iframe. `entry` is the VFS
   * path of the `.shtml` (sprinkles) or the panel module (agent-authored); the
   * webapp's renderer owns loading it.
   */
  | { kind: 'sandboxed'; entry: string };

/** One registry entry: what to render, plus how to describe it. */
export interface PanelRegistration {
  meta: PanelMeta;
  source: PanelSource;
  /**
   * Where the registration came from. Purely informational — used by the
   * add-panel menu to group entries and by diagnostics to explain a duplicate.
   */
  origin: 'builtin' | 'sprinkle' | 'agent';
}

/** Fired on the registry's event target whenever entries change. */
export interface PanelRegistryChangeDetail {
  /** The affected panel id. */
  id: string;
  change: 'registered' | 'unregistered';
}

const entries = new Map<string, PanelRegistration>();

/**
 * Change notifications, so a live "add panel" menu re-renders when discovery
 * lands late (sprinkle discovery is VFS-backed and kernel-gated, so the rail is
 * routinely populated after first paint) or when the agent registers a panel
 * mid-session. A plain `EventTarget` rather than a DOM node: the registry is
 * module state, not an element.
 */
export const panelRegistryEvents = new EventTarget();

function emit(id: string, change: PanelRegistryChangeDetail['change']): void {
  panelRegistryEvents.dispatchEvent(
    new CustomEvent<PanelRegistryChangeDetail>('panel-registry-change', {
      detail: { id, change },
    })
  );
}

/**
 * Register a panel. Later registrations of the same id REPLACE earlier ones and
 * return `false` to report the clash.
 *
 * Replace-and-report rather than throw-or-ignore, because every caller is a
 * legitimate re-registration path in practice: HMR re-evaluates a built-in
 * module, sprinkle discovery re-runs on kernel-ready (`resync`), and the agent
 * may rewrite a panel it authored a moment ago. Throwing would break boot on a
 * duplicate; ignoring would leave a stale implementation live after the agent
 * edits one. The return value lets a caller that genuinely did not expect a
 * clash log it.
 */
export function registerPanel(registration: PanelRegistration): boolean {
  const { id } = registration.meta;
  const replaced = entries.has(id);
  entries.set(id, registration);
  emit(id, 'registered');
  return !replaced;
}

/**
 * Register a panel from its custom-element constructor, taking the id and the
 * rest of the metadata from the class's static `panelMeta`. The convenience path
 * for built-ins, so a component declares its identity in exactly one place.
 *
 * Returns `false` when the constructor has no usable `panelMeta` — the class
 * simply is not registrable, and callers should not silently believe it was.
 */
export function registerPanelElement(
  tag: string,
  ctor: unknown,
  origin: PanelRegistration['origin'] = 'builtin'
): boolean {
  const meta = panelMetaOf(ctor);
  if (!meta) return false;
  return registerPanel({ meta, source: { kind: 'element', tag }, origin });
}

/** Remove a panel from the registry. Returns whether anything was removed. */
export function unregisterPanel(id: string): boolean {
  if (!entries.delete(id)) return false;
  emit(id, 'unregistered');
  return true;
}

/** Look up one registration, or `undefined` when the id is unknown. */
export function getPanel(id: string): PanelRegistration | undefined {
  return entries.get(id);
}

/** Whether an id is registered. */
export function hasPanel(id: string): boolean {
  return entries.has(id);
}

/**
 * Every registration, in insertion order. Returns a fresh array so a caller
 * cannot mutate registry state (and can safely iterate while registering).
 */
export function listPanels(): PanelRegistration[] {
  return [...entries.values()];
}

/** Registrations from one origin — the add-panel menu groups by this. */
export function listPanelsByOrigin(origin: PanelRegistration['origin']): PanelRegistration[] {
  return listPanels().filter((entry) => entry.origin === origin);
}

/**
 * Drop every entry. Test-only in practice: a module-level registry otherwise
 * leaks between test files, and a stale entry from an unrelated suite is a
 * genuinely confusing failure. Not exported from the package barrel.
 */
export function resetPanelRegistry(): void {
  const ids = [...entries.keys()];
  entries.clear();
  for (const id of ids) emit(id, 'unregistered');
}
