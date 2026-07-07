import type { CommandContext, IFileSystem } from 'just-bash';
import { unsafeBytesFromLatin1 } from 'just-bash';

/**
 * Build a typed `CommandContext` for supplemental-command tests.
 *
 * Replaces the per-file `createMockCtx` copies that produced
 * `{ stdin: string }` literals — `CommandContext.stdin` is the opaque
 * `ByteString` brand, so those never typechecked (#1337). `stdin` here is
 * tagged via `unsafeBytesFromLatin1`, which is what the real pipeline edge
 * does (identity at runtime, so test behavior is unchanged).
 */
export interface MockCommandContextOptions {
  /** Partial FS stub; merged over a default `resolvePath` implementation. */
  fs?: Partial<IFileSystem>;
  cwd?: string;
  env?: Map<string, string>;
  /** Plain-string stdin; tagged as a ByteString like the real pipeline edge. */
  stdin?: string;
  exportedEnv?: Record<string, string>;
  /** Optional CommandContext members merged last (e.g. getRegisteredCommands). */
  overrides?: Partial<CommandContext>;
}

export function mockCommandContext(options: MockCommandContextOptions = {}): CommandContext {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
    ...options.fs,
  };
  return {
    fs: fs as IFileSystem,
    cwd: options.cwd ?? '/home',
    env: options.env ?? new Map<string, string>(),
    stdin: unsafeBytesFromLatin1(options.stdin ?? ''),
    ...(options.exportedEnv ? { exportedEnv: options.exportedEnv } : {}),
    ...options.overrides,
  };
}
