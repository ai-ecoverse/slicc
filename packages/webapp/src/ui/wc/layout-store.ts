import { type LayoutDocument, parseLayoutDocument } from '@slicc/webcomponents/panel/layout-schema';
import { createLogger } from '../../base/logger.js';
import { PROTECTED_LAYOUTS_DIR } from '../../base/sudoers.js';
import type { VirtualFS } from '../../fs/index.js';

const log = createLogger('layout-store');

export const USER_LAYOUTS_DIR = '/workspace/layouts';

export const LAYOUT_DIRS = [USER_LAYOUTS_DIR, PROTECTED_LAYOUTS_DIR] as const;

export interface StoredLayout {
  name: string;
  path: string;
  doc: LayoutDocument;

  protected: boolean;
}

export function layoutPath(name: string, opts?: { protected?: boolean }): string {
  const dir = opts?.protected ? PROTECTED_LAYOUTS_DIR : USER_LAYOUTS_DIR;
  return `${dir}/${name}.json`;
}

export async function readLayout(fs: VirtualFS, path: string): Promise<LayoutDocument | null> {
  try {
    if (!(await fs.exists(path))) return null;
    const raw = await fs.readFile(path);
    const parsed = parseLayoutDocument(JSON.parse(typeof raw === 'string' ? raw : String(raw)));
    if ('error' in parsed) {
      log.warn('invalid layout document — ignoring', { path, error: parsed.error });
      return null;
    }
    return parsed;
  } catch (err) {
    log.warn('failed to read layout', { path, error: err instanceof Error ? err.message : err });
    return null;
  }
}

export async function writeLayout(
  fs: VirtualFS,
  doc: LayoutDocument,
  opts?: { protected?: boolean; name?: string }
): Promise<string> {
  const name = opts?.name ?? doc.id;
  const dir = opts?.protected ? PROTECTED_LAYOUTS_DIR : USER_LAYOUTS_DIR;
  const path = `${dir}/${name}.json`;
  if (!(await fs.exists(dir))) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
  log.info('layout saved', { path });
  return path;
}

export async function deleteLayout(
  fs: VirtualFS,
  name: string,
  opts?: { protected?: boolean }
): Promise<boolean> {
  const path = layoutPath(name, opts);
  if (!(await fs.exists(path))) return false;
  await fs.rm(path);
  return true;
}

export async function listLayouts(fs: VirtualFS): Promise<StoredLayout[]> {
  const found: StoredLayout[] = [];
  const seen = new Set<string>();

  for (const dir of LAYOUT_DIRS) {
    let names: string[];
    try {
      if (!(await fs.exists(dir))) continue;
      names = (await fs.readDir(dir)).filter((e) => e.type === 'file').map((e) => e.name);
    } catch (err) {
      log.warn('failed to list layout dir', { dir, error: err });
      continue;
    }
    for (const entry of names) {
      if (!entry.endsWith('.json')) continue;
      const name = entry.slice(0, -'.json'.length);
      if (seen.has(name)) continue;
      const path = `${dir}/${entry}`;
      const doc = await readLayout(fs, path);
      if (!doc) continue;
      seen.add(name);
      found.push({ name, path, doc, protected: dir === PROTECTED_LAYOUTS_DIR });
    }
  }
  return found;
}

export async function loadLayoutByName(fs: VirtualFS, name: string): Promise<StoredLayout | null> {
  for (const dir of LAYOUT_DIRS) {
    const path = `${dir}/${name}.json`;
    const doc = await readLayout(fs, path);
    if (doc) {
      return { name, path, doc, protected: dir === PROTECTED_LAYOUTS_DIR };
    }
  }
  return null;
}
