/**
 * Durable save/skip memory between bench jobs: stash `/workspace/CLAUDE.md` under
 * `<out>/memory/CLAUDE.md` and restore it onto the next leader.
 *
 * Chrome profile checkpoints are not uploaded; CLAUDE.md is the agent-visible memory store
 * that must survive one-task-per-job chaining across Actions deadlines.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { quote } from './slicc-adapter.mjs';

/** Relative path under the bench out dir. */
export const MEMORY_CHECKPOINT_REL = join('memory', 'CLAUDE.md');

/** Leader path the cone / curator writes. */
export const WORKSPACE_CLAUDE_MD = '/workspace/CLAUDE.md';

/** Absolute path of the CLAUDE.md checkpoint in an out dir. */
export function memoryCheckpointPath(outDir) {
  return join(outDir, MEMORY_CHECKPOINT_REL);
}

/** True when `<out>/memory/CLAUDE.md` exists and is non-empty. */
export function hasMemoryCheckpoint(outDir) {
  const path = memoryCheckpointPath(outDir);
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Read `/workspace/CLAUDE.md` from the leader into `<out>/memory/CLAUDE.md`.
 * Returns `{ exported: false }` when the file is missing or empty (no overwrite).
 */
export async function exportMemoryCheckpoint(leader, outDir) {
  const r = await leader.exec(
    `if [ -f ${quote(WORKSPACE_CLAUDE_MD)} ]; then cat ${quote(WORKSPACE_CLAUDE_MD)}; fi`
  );
  if (r.leaderDown || (r.status !== 0 && r.status !== 1)) {
    const err = new Error(
      `export memory checkpoint: cat exited ${r.status}: ${(r.stderr || r.stdout || '')
        .trim()
        .slice(0, 400)}`
    );
    err.leaderDown = Boolean(r.leaderDown);
    throw err;
  }
  const text = r.stdout ?? '';
  if (!text.trim()) return { exported: false, bytes: 0 };
  const path = memoryCheckpointPath(outDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return { exported: true, bytes: Buffer.byteLength(text) };
}

/**
 * Write `<out>/memory/CLAUDE.md` onto the leader at `/workspace/CLAUDE.md`.
 * Returns `{ restored: false }` when there is no usable checkpoint.
 */
export async function importMemoryCheckpoint(leader, outDir) {
  const path = memoryCheckpointPath(outDir);
  if (!existsSync(path)) return { restored: false, bytes: 0 };
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return { restored: false, bytes: 0 };
  const r = await leader.exec(`base64 -d > ${quote(WORKSPACE_CLAUDE_MD)}`, {
    stdin: Buffer.from(text).toString('base64'),
  });
  if (r.status !== 0 || r.leaderDown) {
    const err = new Error(
      `import memory checkpoint: write exited ${r.status}: ${(r.stderr || r.stdout || '')
        .trim()
        .slice(0, 400)}`
    );
    err.leaderDown = Boolean(r.leaderDown);
    throw err;
  }
  return { restored: true, bytes: Buffer.byteLength(text) };
}
