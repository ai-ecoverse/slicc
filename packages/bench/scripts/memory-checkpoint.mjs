import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { quote } from './slicc-adapter.mjs';

export const MEMORY_CHECKPOINT_REL = join('memory', 'CLAUDE.md');

export const WORKSPACE_CLAUDE_MD = '/workspace/CLAUDE.md';

export function memoryCheckpointPath(outDir) {
  return join(outDir, MEMORY_CHECKPOINT_REL);
}

export function hasMemoryCheckpoint(outDir) {
  const path = memoryCheckpointPath(outDir);
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

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
