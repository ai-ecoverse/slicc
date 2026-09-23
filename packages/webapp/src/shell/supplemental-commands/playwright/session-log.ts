/**
 * Best-effort session logging and snapshot archiving for the playwright-cli
 * command family, under the calling unit's session root (see
 * {@link sessionRootFor}).
 */

import type { VirtualFS } from '../../../fs/index.js';
import { buildSnapshot } from './snapshot.js';
import { filenameSafeTimestamp, isAlreadyExistsError } from './state.js';
import type { CmdResult, PlaywrightHandlerCtx, PlaywrightState, TabSnapshot } from './types.js';

// Named via the handler context rather than imported from `cdp/` so this
// module stays inside the shell layer (see layer-stack import direction).
type BrowserAPI = PlaywrightHandlerCtx['browser'];

/** Session root for the cone and for shells with no work unit (the terminal). */
export const DEFAULT_SESSION_ROOT = '/.playwright';

/**
 * Where a unit's session log, snapshot/screenshot archives and default
 * storage-state file go.
 *
 * A sandboxed scoop cannot write `/.playwright/` without an approval, and a
 * best-effort log must never cost one (#3440) — so a scoop logs under its own
 * scratch directory (`$TMPDIR`, `/tmp/<cone>/<scoop>`), which every scoop can
 * write. Granting scoops a shared `/.playwright/**` instead would let them
 * overwrite each other's logs.
 */
export function sessionRootFor(isScoop: boolean, scratchDir: string): string {
  if (!isScoop) return DEFAULT_SESSION_ROOT;
  const base = scratchDir.replace(/\/+$/, '');
  return `${base}${DEFAULT_SESSION_ROOT}`;
}

/** Ensure `<root>`, `<root>/snapshots` and `<root>/screenshots` exist. */
export async function ensureSessionDirs(
  vfs: VirtualFS,
  state: PlaywrightState,
  root: string
): Promise<void> {
  if (state.sessionDirsCreated.has(root)) return;
  for (const dir of [root, `${root}/snapshots`, `${root}/screenshots`]) {
    try {
      await vfs.mkdir(dir, { recursive: true });
    } catch (err) {
      if (!isAlreadyExistsError(err)) {
        throw err;
      }
    }
  }
  state.sessionDirsCreated.add(root);
}

/**
 * Take a fresh snapshot, persist it to `<root>/snapshots/`, and update
 * `state.snapshots` so subsequent commands can resolve refs without requiring a
 * manual re-snapshot. Returns the VFS path written, or null on any error.
 */
export async function autoSaveSnapshot(
  browser: BrowserAPI,
  vfs: VirtualFS,
  targetId: string,
  state: PlaywrightState,
  root: string
): Promise<string | null> {
  try {
    return await browser.withTab(targetId, async (page) => {
      const { url, title, text, refToSelector, refToBackendNodeId, refToFrameId } =
        await buildSnapshot(page);

      const snapshot: TabSnapshot = {
        url,
        title,
        refToSelector,
        refToBackendNodeId,
        refToFrameId,
        content: text,
        timestamp: Date.now(),
      };
      state.snapshots.set(targetId, snapshot);

      const output = [`Page URL: ${url}`, `Page Title: ${title}`, '', text].join('\n');
      const ts = filenameSafeTimestamp(new Date());
      const path = `${root}/snapshots/page-${ts}.yml`;
      await vfs.writeFile(path, output);
      return path;
    });
  } catch {
    return null;
  }
}

/** Append a session log entry to `<root>/session.md`. */
export async function logSession(
  vfs: VirtualFS,
  state: PlaywrightState,
  root: string,
  opts: {
    command: string;
    args: string[];
    result: CmdResult;
    snapshotPath: string | null;
    tabUrl?: string;
    targetId?: string | null;
  }
): Promise<void> {
  await ensureSessionDirs(vfs, state, root);
  const ts = new Date().toISOString();
  const cmdLine = `playwright-cli ${opts.command}${opts.args.length ? ' ' + opts.args.join(' ') : ''}`;
  const resultSummary =
    opts.result.exitCode === 0
      ? opts.result.stdout.trim() || 'OK'
      : `Error: ${opts.result.stderr.trim()}`;

  const lines = [`### ${cmdLine}`, `- **Time**: ${ts}`];
  if (opts.tabUrl || opts.targetId) {
    const tabInfo = opts.tabUrl
      ? `${opts.tabUrl}${opts.targetId ? ` (targetId: ${opts.targetId})` : ''}`
      : `targetId: ${opts.targetId}`;
    lines.push(`- **Tab**: ${tabInfo}`);
  }
  lines.push(`- **Result**: ${resultSummary}`);
  if (opts.snapshotPath) {
    lines.push('', `[Snapshot](${opts.snapshotPath})`);
  }
  lines.push('---', '');

  const entry = lines.join('\n') + '\n';
  const sessionPath = `${root}/session.md`;
  let existing = '';
  try {
    const content = await vfs.readFile(sessionPath);
    existing =
      typeof content === 'string' ? content : new TextDecoder().decode(content as Uint8Array);
  } catch {
    // File doesn't exist yet
  }
  await vfs.writeFile(sessionPath, existing + entry);
}
