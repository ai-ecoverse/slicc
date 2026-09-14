import { type PanelMeta, panelMetaOf } from './panel-meta.js';

export type PanelSource = { kind: 'element'; tag: string } | { kind: 'sandboxed'; entry: string };

export interface PanelRegistration {
  meta: PanelMeta;
  source: PanelSource;

  origin: 'builtin' | 'sprinkle' | 'agent';
}

export interface PanelRegistryChangeDetail {
  id: string;
  change: 'registered' | 'unregistered';
}

const entries = new Map<string, PanelRegistration>();

export const panelRegistryEvents = new EventTarget();

function emit(id: string, change: PanelRegistryChangeDetail['change']): void {
  panelRegistryEvents.dispatchEvent(
    new CustomEvent<PanelRegistryChangeDetail>('panel-registry-change', {
      detail: { id, change },
    })
  );
}

export function registerPanel(registration: PanelRegistration): boolean {
  const { id } = registration.meta;
  const replaced = entries.has(id);
  entries.set(id, registration);
  emit(id, 'registered');
  return !replaced;
}

export function registerPanelElement(
  tag: string,
  ctor: unknown,
  origin: PanelRegistration['origin'] = 'builtin'
): boolean {
  const meta = panelMetaOf(ctor);
  if (!meta) return false;
  return registerPanel({ meta, source: { kind: 'element', tag }, origin });
}

export function unregisterPanel(id: string): boolean {
  if (!entries.delete(id)) return false;
  emit(id, 'unregistered');
  return true;
}

export function getPanel(id: string): PanelRegistration | undefined {
  return entries.get(id);
}

export function hasPanel(id: string): boolean {
  return entries.has(id);
}

export function listPanels(): PanelRegistration[] {
  return [...entries.values()];
}

export function listPanelsByOrigin(origin: PanelRegistration['origin']): PanelRegistration[] {
  return listPanels().filter((entry) => entry.origin === origin);
}

export function resetPanelRegistry(): void {
  const ids = [...entries.keys()];
  entries.clear();
  for (const id of ids) emit(id, 'unregistered');
}
