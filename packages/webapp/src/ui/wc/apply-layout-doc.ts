import { type LayoutDocument, listPanels, type SliccLayout } from '@slicc/webcomponents';
import { createLogger } from '../../base/logger.js';
import type { VirtualFS } from '../../fs/index.js';
import { getLayoutDoc, layoutDocNames } from './default-layouts.js';
import { deleteLayout, listLayouts, loadLayoutByName, writeLayout } from './layout-store.js';
import { setPanelVisible } from './panel-visibility.js';

const log = createLogger('apply-layout-doc');

export type LayoutDocMsg =
  | { kind: 'load'; name: string }
  | { kind: 'save'; name: string; protected: boolean }
  | { kind: 'delete'; name: string }
  | { kind: 'docs' }
  | { kind: 'panels' }
  | { kind: 'show'; panelId: string }
  | { kind: 'hide'; panelId: string };

export interface LayoutDocResult {
  applied: boolean;
  output?: string;
  error?: string;
}

export interface LayoutDocDeps {
  layout: SliccLayout;

  fs?: VirtualFS;
}

function noFs(verb: string): LayoutDocResult {
  return { applied: false, error: `layout ${verb} needs a filesystem (unavailable here)` };
}

export function isLayoutDocMsg(msg: { kind: string }): msg is LayoutDocMsg {
  return ['load', 'save', 'delete', 'docs', 'panels', 'show', 'hide'].includes(msg.kind);
}

async function handleLoad(deps: LayoutDocDeps, name: string): Promise<LayoutDocResult> {
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
    const message = err instanceof Error ? err.message : String(err);
    log.warn('layout save failed', { name, protected: isProtected, error: message });
    return { applied: false, error: `could not save "${name}": ${message}` };
  }
}

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

function handleVisibility(deps: LayoutDocDeps, panelId: string, visible: boolean): LayoutDocResult {
  setPanelVisible(deps.layout, panelId, visible);
  return { applied: true };
}

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
