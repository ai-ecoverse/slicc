/**
 * `layout-store.ts` — reading and writing layout documents on the VFS.
 *
 * Two roots, with deliberately different protection:
 *
 * | Path                        | Agent writes                                  |
 * | --------------------------- | --------------------------------------------- |
 * | `/workspace/layouts/*.json` | free — the normal path for saved layouts       |
 * | `/etc/slicc/layouts/*.json` | require user approval (sudoers self-protected) |
 *
 * The free path is the default because SLICC does not prompt for ordinary agent
 * work — writing a sprinkle or running a shell command is ungated, so saving a
 * layout should be too. The protected root is the opt-in exception, enforced in
 * `base/sudoers.ts`'s `matchPath` where no `NOPASSWD` rule can override it.
 *
 * A skill ships layouts by writing them into either root; discovery just lists
 * both, so "load an app including its UI" needs no separate registration step.
 */

// The DOM-free subpath, NOT the package barrel: this module is imported by
// node-environment tests and (via the layout verbs) by code paths with no DOM,
// while the barrel side-effect-registers every component and needs
// `CSSStyleSheet`. Same rationale as `@slicc/webcomponents/composer/speech`.
import { type LayoutDocument, parseLayoutDocument } from '@slicc/webcomponents/panel/layout-schema';
import { createLogger } from '../../base/logger.js';
import { PROTECTED_LAYOUTS_DIR } from '../../base/sudoers.js';
import type { VirtualFS } from '../../fs/index.js';

const log = createLogger('layout-store');

/** Freely agent-writable layout directory. */
export const USER_LAYOUTS_DIR = '/workspace/layouts';

/** Both roots, in lookup order — user layouts shadow protected ones of the same name. */
export const LAYOUT_DIRS = [USER_LAYOUTS_DIR, PROTECTED_LAYOUTS_DIR] as const;

/** A discovered layout document plus where it came from. */
export interface StoredLayout {
  /** Basename without `.json` — the name `layout load <name>` takes. */
  name: string;
  path: string;
  doc: LayoutDocument;
  /** Whether writing it back requires user approval. */
  protected: boolean;
}

/** The VFS path a named layout is saved to. */
export function layoutPath(name: string, opts?: { protected?: boolean }): string {
  const dir = opts?.protected ? PROTECTED_LAYOUTS_DIR : USER_LAYOUTS_DIR;
  return `${dir}/${name}.json`;
}

/**
 * Read and validate one layout document. Returns `null` (with a warning) when the
 * file is missing, unparseable, or fails schema validation.
 *
 * Returning `null` rather than throwing because a corrupt layout must not break
 * boot: the caller falls back to the default document, which is a strictly better
 * outcome than a blank app.
 */
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

/**
 * Write a layout document. The caller's `fs` decides whether approval is needed:
 * a gated (sudo-wrapped) handle writing under `/etc/slicc/layouts/` prompts, an
 * ungated one does not. This function deliberately does not check — enforcement
 * belongs at the FS boundary, not duplicated here where it could drift.
 */
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

/** Delete a saved layout. Returns whether a file was removed. */
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

/**
 * List every saved layout across both roots.
 *
 * A user layout SHADOWS a protected one of the same name (user root is scanned
 * first and first-wins) — so a user can override a shipped or pinned layout
 * locally without needing write access to the protected copy. Invalid documents
 * are skipped with a warning rather than failing the listing, so one bad file
 * doesn't hide every good one.
 */
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

/**
 * Load a layout by name from either root, user root first.
 *
 * Returns `null` when the name is unknown — the caller decides whether that means
 * "try a shipped preset" or "report an error", since `layout load` should accept
 * both saved layouts and preset names.
 */
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
