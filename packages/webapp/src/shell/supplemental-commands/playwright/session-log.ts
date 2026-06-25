/**
 * Best-effort `/.playwright/` session logging and snapshot archiving for the
 * playwright-cli command family.
 */

import type { BrowserAPI } from '../../../cdp/index.js';
import type { VirtualFS } from '../../../fs/index.js';
import { buildSnapshot } from './snapshot.js';
import { filenameSafeTimestamp, isAlreadyExistsError } from './state.js';
import type { CmdResult, PlaywrightState, TabSnapshot } from './types.js';

/** Ensure /.playwright/ directories exist. */
export async function ensureSessionDirs(vfs: VirtualFS, state: PlaywrightState): Promise<void> {
  if (state.sessionDirsCreated) return;
  for (const dir of ['/.playwright', '/.playwright/snapshots', '/.playwright/screenshots']) {
    try {
      await vfs.mkdir(dir, { recursive: true });
    } catch (err) {
      if (!isAlreadyExistsError(err)) {
        throw err;
      }
    }
  }
  state.sessionDirsCreated = true;
}

/**
 * Take a fresh snapshot, persist it to /.playwright/snapshots/, and update
 * `state.snapshots` so subsequent commands can resolve refs without requiring a
 * manual re-snapshot. Returns the VFS path written, or null on any error.
 */
export async function autoSaveSnapshot(
  browser: BrowserAPI,
  vfs: VirtualFS,
  targetId: string,
  state: PlaywrightState
): Promise<string | null> {
  try {
    return await browser.withTab(targetId, async () => {
      const { url, title, text, refToSelector, refToBackendNodeId, refToFrameId } =
        await buildSnapshot(browser);

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
      const path = `/.playwright/snapshots/page-${ts}.yml`;
      await vfs.writeFile(path, output);
      return path;
    });
  } catch {
    return null;
  }
}

/** Append a session log entry to /.playwright/session.md. */
export async function logSession(
  vfs: VirtualFS,
  state: PlaywrightState,
  opts: {
    command: string;
    args: string[];
    result: CmdResult;
    snapshotPath: string | null;
    tabUrl?: string;
    targetId?: string | null;
  }
): Promise<void> {
  await ensureSessionDirs(vfs, state);
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
  const sessionPath = '/.playwright/session.md';
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
