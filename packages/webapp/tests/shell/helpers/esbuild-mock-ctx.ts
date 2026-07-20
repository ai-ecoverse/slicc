import type { CommandContext, IFileSystem } from 'just-bash';
import { vi } from 'vitest';

/**
 * File-store-backed {@link CommandContext} for esbuild command tests. Reads and
 * writes go through an in-memory map so bundle/transform paths resolve VFS
 * files without a real filesystem. Shared by the mocked-loader unit suite and
 * the opt-in live-wasm suite so the ctx shape stays identical across both.
 */
export function createEsbuildMockCtx(
  overrides: Partial<{ fs: Partial<IFileSystem>; cwd: string; stdin: string }> = {}
): CommandContext {
  const fileStore = new Map<string, string>();
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) =>
      path.startsWith('/') ? path : `${base.replace(/\/$/, '')}/${path}`,
    exists: vi.fn().mockImplementation(async (p: string) => fileStore.has(p)),
    readFile: vi.fn().mockImplementation(async (p: string) => {
      const v = fileStore.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    }),
    writeFile: vi.fn().mockImplementation(async (p: string, content: string | Uint8Array) => {
      fileStore.set(p, typeof content === 'string' ? content : new TextDecoder().decode(content));
    }),
    stat: vi.fn().mockImplementation(async (p: string) => {
      if (!fileStore.has(p)) throw new Error(`ENOENT: ${p}`);
      return { isFile: true, isDirectory: false, size: fileStore.get(p)!.length };
    }),
    readFileBuffer: vi.fn().mockImplementation(async () => new Uint8Array()),
    ...overrides.fs,
  };
  return {
    fs: fs as IFileSystem,
    cwd: overrides.cwd ?? '/workspace',
    env: new Map<string, string>(),
    stdin: overrides.stdin ?? '',
  } as unknown as CommandContext;
}
