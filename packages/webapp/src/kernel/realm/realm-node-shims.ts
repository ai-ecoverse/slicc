/**
 * `realm-node-shims.ts` — Node `process` / `console` / `stdin` shims and
 * small path/exit helpers used to bootstrap a JS realm. Extracted from
 * `js-realm-shared.ts`; no behavior change.
 */
import { attachArgvParseFlags } from './js-realm-helpers.js';
import type { RealmInitMsg } from './realm-types.js';

export function dirnameOf(filePath: string): string {
  if (!filePath) return '';
  const idx = filePath.lastIndexOf('/');
  if (idx < 0) return '';
  if (idx === 0) return '/';
  return filePath.substring(0, idx);
}

export class NodeExitError extends Error {
  constructor(public readonly code: number) {
    super(`Process exited with code ${code}`);
    this.name = 'NodeExitError';
  }
}

function formatConsoleArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createNodeConsole(
  writeStdout: (value: unknown) => void,
  writeStderr: (value: unknown) => void
) {
  return {
    log: (...parts: unknown[]) =>
      writeStdout(`${parts.map(formatConsoleArg).join(' ')}
`),
    info: (...parts: unknown[]) =>
      writeStdout(`${parts.map(formatConsoleArg).join(' ')}
`),
    warn: (...parts: unknown[]) =>
      writeStderr(`${parts.map(formatConsoleArg).join(' ')}
`),
    error: (...parts: unknown[]) =>
      writeStderr(`${parts.map(formatConsoleArg).join(' ')}
`),
  };
}

export function createProcessShim(
  init: RealmInitMsg,
  writeStdout: (value: unknown) => void,
  writeStderr: (value: unknown) => void
): { processShim: Record<string, unknown>; getDidCallProcessExit: () => boolean } {
  const noColor = !!init.env?.NO_COLOR;
  const stdinShim = createStdinShim(init.stdin ?? '');
  const argvWithParseFlags = attachArgvParseFlags(init.argv);
  let didCallProcessExit = false;
  const processShim = {
    argv: argvWithParseFlags,
    env: init.env,
    cwd: () => init.cwd,
    exit: (codeValue?: number) => {
      didCallProcessExit = true;
      const normalized = Number.isFinite(codeValue) ? Number(codeValue) : 0;
      throw new NodeExitError(normalized);
    },
    stdin: stdinShim,
    stdout: { write: writeStdout, isTTY: !noColor },
    stderr: { write: writeStderr, isTTY: !noColor },
  };
  return { processShim, getDidCallProcessExit: () => didCallProcessExit };
}

/**
 * `process.stdin` shim. `init.stdin` arrives as a buffered, read-ahead
 * string from the kernel (the AlmostBashShell exec pipeline, `.jsh`
 * commands, `node`/`node -e`), so there's no streaming Readable.
 *
 * EOF semantics match Node's `Readable.read()`: the first `read()` returns
 * the full buffer, subsequent calls return `null`. A single `consumed` flag
 * is shared with the async iterator so `for await (const c of process.stdin)`
 * after a `read()` (or a second iteration) yields nothing. `toString()`
 * always returns the original buffer; `isTTY` is always `false`.
 */
function createStdinShim(stdinBuffer: string) {
  let consumed = false;
  return {
    isTTY: false,
    read(): string | null {
      if (consumed) return null;
      consumed = true;
      return stdinBuffer;
    },
    toString(): string {
      return stdinBuffer;
    },
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        async next(): Promise<IteratorResult<string>> {
          if (consumed) return { value: undefined, done: true };
          consumed = true;
          return { value: stdinBuffer, done: false };
        },
      };
    },
  };
}
