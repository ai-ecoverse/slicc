/**
 * Memory-guard FS — the write side of the memory budget (#3157).
 *
 * A transparent decorator over the agent's gated filesystem handle (the one
 * the file tools AND the shell share) that refuses every write landing on a
 * budget-governed memory file (`isMemoryFilePath`) with an `EACCES` naming
 * the `memory_write` tool. That tool is handed the UNDECORATED handle, so it
 * is the single path a memory file can change through — and the single
 * place the budget rule ("over budget, a write must shrink the file") and
 * the size report live.
 *
 * Why at the fs and not in each tool: `write_file` and `edit` are two of
 * many writers. The dreamer transcripts behind #3157 landed their drafts
 * with `cp`, `cat >` and `node -e 'fs.writeFileSync(...)'`; a tool-level
 * check would have missed all three.
 *
 * Same Proxy shape as `createSudoFs`: overrides are served from the `get`
 * trap, everything else binds through to the wrapped handle, and the
 * `MONKEYPATCH_UNSAFE_FS` marker is advertised so in-place patchers skip it.
 */

import { isMemoryFilePath, MEMORY_FILE_GUARD_MESSAGE } from '../base/memory-budget.js';
import { normalizePath } from './path-utils.js';
import { MONKEYPATCH_UNSAFE_FS } from './sudo-fs.js';
import { FsError } from './types.js';
import type { VirtualFS } from './virtual-fs.js';

/** The write methods whose DESTINATION may be a memory file. */
type GuardedMethod = 'writeFile' | 'appendFile' | 'rename' | 'copyFile' | 'symlink';

/** Argument index of the destination path per guarded method. */
const DESTINATION_ARG: Record<GuardedMethod, number> = {
  writeFile: 0,
  appendFile: 0,
  rename: 1,
  copyFile: 1,
  symlink: 1,
};

function refusal(path: string): FsError {
  return new FsError('EACCES', MEMORY_FILE_GUARD_MESSAGE, normalizePath(path));
}

/**
 * Where a write to `path` would actually land. The lexical spelling is not
 * enough: `/tmp` is writable by every unit, so `ln -s /workspace/CLAUDE.md
 * /tmp/alias` followed by a write to `/tmp/alias` would reach the memory
 * file with the guard seeing only the alias. Resolve through `realpath`;
 * for a path that does not exist yet (a memory file being created through
 * a symlinked parent), resolve the parent directory and re-attach the name.
 * A path that resolves nowhere is judged by its spelling alone.
 */
async function resolveDestination(fs: VirtualFS, path: string): Promise<string> {
  const normalized = normalizePath(path);
  try {
    return normalizePath(await fs.realpath(normalized));
  } catch {
    // Absent — fall through to the parent.
  }
  const slash = normalized.lastIndexOf('/');
  if (slash <= 0) return normalized;
  try {
    const parent = normalizePath(await fs.realpath(normalized.slice(0, slash)));
    return `${parent === '/' ? '' : parent}/${normalized.slice(slash + 1)}`;
  } catch {
    return normalized;
  }
}

/**
 * Wrap `fs` so writes to memory files are refused (see module doc). Reads,
 * deletes and every other operation pass straight through — deleting a
 * memory file cannot exceed the budget, and refusing it would only break
 * `rm` in a curator's scratch cleanup.
 */
export function createMemoryGuardedFs<T extends VirtualFS>(fs: T): T {
  type AnyMethod = (...args: unknown[]) => unknown;
  const overrides: Partial<Record<GuardedMethod, AnyMethod>> = {};
  for (const method of Object.keys(DESTINATION_ARG) as GuardedMethod[]) {
    const original = fs[method] as unknown as AnyMethod | undefined;
    if (typeof original !== 'function') continue;
    const index = DESTINATION_ARG[method];
    overrides[method] = async (...args: unknown[]) => {
      const destination = args[index];
      if (typeof destination === 'string') {
        // The spelling first (cheap, and what the agent typed), then where
        // it resolves — an alias to a memory file is still a memory file.
        if (isMemoryFilePath(destination)) throw refusal(destination);
        const resolved = await resolveDestination(fs, destination);
        if (isMemoryFilePath(resolved)) throw refusal(destination);
      }
      return original.apply(fs, args);
    };
  }
  return new Proxy(fs, {
    get(target, prop, receiver) {
      if (prop === MONKEYPATCH_UNSAFE_FS) return true;
      if (typeof prop === 'string' && prop in overrides) {
        return overrides[prop as GuardedMethod];
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
