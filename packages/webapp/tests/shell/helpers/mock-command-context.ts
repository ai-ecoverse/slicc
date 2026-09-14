import type { CommandContext, IFileSystem, ResolvedCommandContext } from 'just-bash';
import { createCommandContext, unsafeBytesFromLatin1 } from 'just-bash';

export interface MockCommandContextOptions {
  fs?: Partial<IFileSystem>;
  cwd?: string;
  env?: Map<string, string>;

  stdin?: string;
  exportedEnv?: Record<string, string>;

  overrides?: Partial<CommandContext>;
}

export function mockCommandContext(
  options: MockCommandContextOptions = {}
): ResolvedCommandContext {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
    ...options.fs,
  };
  return createCommandContext({
    fs: fs as IFileSystem,
    cwd: options.cwd ?? '/home',
    env: options.env ?? new Map<string, string>(),
    stdin: unsafeBytesFromLatin1(options.stdin ?? ''),
    ...(options.exportedEnv ? { exportedEnv: options.exportedEnv } : {}),
    ...options.overrides,
  });
}
