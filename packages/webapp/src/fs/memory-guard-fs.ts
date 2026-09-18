import { isMemoryFilePath, MEMORY_FILE_GUARD_MESSAGE } from '../base/memory-budget.js';
import { normalizePath } from './path-utils.js';
import { MONKEYPATCH_UNSAFE_FS } from './sudo-fs.js';
import { FsError } from './types.js';
import type { VirtualFS } from './virtual-fs.js';

type GuardedMethod = 'writeFile' | 'appendFile' | 'rename' | 'copyFile' | 'symlink';

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

async function resolveDestination(fs: VirtualFS, path: string): Promise<string> {
  const normalized = normalizePath(path);
  try {
    return normalizePath(await fs.realpath(normalized));
  } catch {}
  const slash = normalized.lastIndexOf('/');
  if (slash <= 0) return normalized;
  try {
    const parent = normalizePath(await fs.realpath(normalized.slice(0, slash)));
    return `${parent === '/' ? '' : parent}/${normalized.slice(slash + 1)}`;
  } catch {
    return normalized;
  }
}

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
