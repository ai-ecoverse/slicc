import type { PanelMeta } from '@slicc/webcomponents/panel/meta';
import { registerPanel } from '@slicc/webcomponents/panel/registry';
import { createLogger } from '../../base/logger.js';
import type { VirtualFS } from '../../fs/index.js';

const log = createLogger('agent-panels');

export const AGENT_PANELS_DIR = '/workspace/panels';

const MANIFEST = 'panel.json';

export interface AgentPanel {
  meta: PanelMeta;
  dir: string;

  entry: string | null;
}

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
