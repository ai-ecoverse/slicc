/**
 * `agent-panels.ts` — discover and register panels SLICC authored itself.
 *
 * A panel is a directory under `/workspace/panels/<name>/` containing:
 *
 *   panel.json   { "id", "title", "icon"?, "entry"?, "minWidth"?, … }
 *   panel.js     a module that `define()`s a custom element (optional)
 *
 * With no `panel.js` the entry is registered as a `sandboxed` source and the
 * sprinkle renderer draws its `.shtml` body — the zero-JS path, and the one that
 * works identically in every float.
 *
 * ## Trust
 *
 * These panels are **not gated, scanned, or signed**. That is a deliberate match
 * to how SLICC already works: the agent writes files and runs shell commands
 * without prompting, so a panel grants it no capability it lacks. An approval
 * prompt on top of an ungated shell would be theater, and prompting for "make me
 * a panel" would make the feature unusable.
 *
 * Static analysis was considered and rejected as a gate — it is trivially
 * defeated in JS (`globalThis[atob(…)]`, `new Function(fetched)`) and manufactures
 * false confidence. See `docs/panel-system-design.md`'s trust model,
 * and the two hardening measures that DO matter (H1/H2) which are already in.
 *
 * Third-party panels distributed between users are a different threat and are out
 * of scope; that would want a dedicated sandbox origin (issue #1717 option C),
 * not scanning.
 */

import type { PanelMeta } from '@slicc/webcomponents/panel/meta';
import { registerPanel } from '@slicc/webcomponents/panel/registry';
import { createLogger } from '../../base/logger.js';
import type { VirtualFS } from '../../fs/index.js';

const log = createLogger('agent-panels');

/** Root SLICC writes its own panels into. */
export const AGENT_PANELS_DIR = '/workspace/panels';

/** Manifest filename inside a panel directory. */
const MANIFEST = 'panel.json';

/** A discovered agent-authored panel. */
export interface AgentPanel {
  meta: PanelMeta;
  dir: string;
  /** Module path to import, when the panel ships JS. */
  entry: string | null;
}

/**
 * Validate a parsed `panel.json`. Requires only what the registry dereferences —
 * an id and a title — so a manifest with extra or unknown fields still loads.
 */
function parseManifest(value: unknown, dir: string): PanelMeta | null {
  if (!value || typeof value !== 'object') {
    log.warn('panel manifest is not an object', { dir });
    return null;
  }
  const raw = value as Partial<PanelMeta> & { entry?: unknown };
  if (typeof raw.id !== 'string' || raw.id.trim() === '') {
    log.warn('panel manifest needs a non-empty id', { dir });
    return null;
  }
  if (typeof raw.title !== 'string' || raw.title.trim() === '') {
    log.warn('panel manifest needs a non-empty title', { dir, id: raw.id });
    return null;
  }
  return {
    id: raw.id,
    title: raw.title,
    icon: typeof raw.icon === 'string' ? raw.icon : undefined,
    minWidth: typeof raw.minWidth === 'number' ? raw.minWidth : undefined,
    minHeight: typeof raw.minHeight === 'number' ? raw.minHeight : undefined,
    preferredSize:
      typeof raw.preferredSize === 'string' || typeof raw.preferredSize === 'number'
        ? raw.preferredSize
        : undefined,
    presentation: raw.presentation === 'floating' ? 'floating' : undefined,
    anchor: raw.anchor,
    realm: raw.realm === 'main' ? 'main' : 'sandboxed',
  };
}

/**
 * Scan `/workspace/panels/` for agent-authored panels.
 *
 * A directory whose manifest is missing or invalid is skipped with a warning, not
 * fatal: one malformed panel must not hide the others (the same principle as
 * layout documents and sprinkle discovery).
 */
export async function discoverAgentPanels(fs: VirtualFS): Promise<AgentPanel[]> {
  const found: AgentPanel[] = [];
  try {
    if (!(await fs.exists(AGENT_PANELS_DIR))) return found;
    const entries = await fs.readDir(AGENT_PANELS_DIR);
    for (const entry of entries) {
      if (entry.type !== 'directory') continue;
      const dir = `${AGENT_PANELS_DIR}/${entry.name}`;
      const manifestPath = `${dir}/${MANIFEST}`;
      if (!(await fs.exists(manifestPath))) continue;
      let parsed: unknown;
      try {
        const raw = await fs.readFile(manifestPath);
        parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw));
      } catch (err) {
        log.warn('unreadable panel manifest', { manifestPath, error: err });
        continue;
      }
      const meta = parseManifest(parsed, dir);
      if (!meta) continue;
      const entryFile = (parsed as { entry?: unknown }).entry;
      const entryPath =
        typeof entryFile === 'string' && entryFile.length > 0 ? `${dir}/${entryFile}` : null;
      found.push({ meta, dir, entry: entryPath });
    }
  } catch (err) {
    log.warn('agent panel discovery failed', { error: err });
  }
  return found;
}

/**
 * Register every discovered agent panel.
 *
 * A panel with a JS `entry` registers as a `sandboxed` source pointing at that
 * module: the renderer loads it inside the sprinkle iframe, which is where
 * agent-authored code already runs today. Registering it as a main-realm
 * `element` would require importing and `define()`ing the module here — possible
 * (the CSP allows it), but it would put freshly written code in the same realm as
 * the tray channel and stored credentials for no functional gain, since a panel
 * body does not need that reach. The realm is recorded in `meta.realm` so a
 * future main-realm path has somewhere to key off.
 */
export async function registerAgentPanels(fs: VirtualFS): Promise<AgentPanel[]> {
  const panels = await discoverAgentPanels(fs);
  for (const panel of panels) {
    registerPanel({
      meta: panel.meta,
      source: { kind: 'sandboxed', entry: panel.entry ?? `${panel.dir}/panel.shtml` },
      origin: 'agent',
    });
  }
  if (panels.length > 0) log.info('registered agent panels', { count: panels.length });
  return panels;
}
