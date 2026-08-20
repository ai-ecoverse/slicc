/**
 * `node` command — runs JS code via the realm runtime so SIGKILL
 * can hard-stop runaway scripts.
 *
 * Argument shapes:
 *   - `node -e CODE [ARGS…]` — inline script
 *   - `node SCRIPT [ARGS…]` — script file from VFS
 *   - `node` with stdin piped — reads from stdin
 *   - `node - [ARGS…]` / `node /dev/stdin [ARGS…]` — explicit stdin script
 *     (the `node /dev/stdin << 'EOF'` heredoc idiom)
 *
 * The realm runtime owns: AsyncFunction construction, Node-like
 * shims (`console`, `process`, `fs` via VFS RPC, `exec` via shell
 * RPC, `fetch` via SecureFetch RPC), and a synchronous `require()`
 * served from a host-built CJS module graph rooted in the ipk
 * `node_modules` walk — no CDN, no network. A missing bare module
 * throws `Cannot find module 'x' (run: ipk install x)` immediately.
 * See `kernel/realm/realm-module-system.ts` for the full list.
 */

import type { Command, CommandContext } from 'just-bash';
import type { JshProcessConfig } from '../jsh-executor.js';
import { executeJsCode } from '../jsh-executor.js';
import { EMPTY_BYTES, stdinAsText } from '../just-bash-compat.js';
import { stripShebang } from '../strip-shebang.js';
import { NODE_VERSION } from './shared.js';

export interface NodeCommandOptions {
  /**
   * Builds the `kind:'jsh'` realm process config so the realm child spawns
   * parented to the active shell pid (enabling terminal-signal fan-out to
   * the realm — #1116). When omitted, `executeJsCode` falls back to the
   * global / ephemeral PM with `ppid: 1`.
   */
  buildProcessConfig?: (runEnv?: ReadonlyMap<string, string>) => JshProcessConfig | undefined;
}

/**
 * Script-path tokens that mean "the program comes from stdin, not the VFS".
 * `-` is Node's own convention; the device paths are what `node /dev/stdin
 * << 'EOF'` heredoc idioms use. None of them exist as VFS files, so without
 * this set they fall into the script-file branch and die with
 * `cannot find module '/dev/stdin'`.
 */
const STDIN_SCRIPT_TOKENS = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']);

/**
 * Index of the token that introduces the program (`-e`, a stdin token, or a
 * script path), or `args.length` when the vector is all node options.
 *
 * Everything at or after that index belongs to the *script*, not to node — so
 * `node /dev/stdin --help` must reach `process.argv`, not print the shim's
 * usage. Only the leading slice is scanned for `--help` / `--version`.
 */
function programSourceIndex(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-e' || arg === '--eval') return i;
    if (STDIN_SCRIPT_TOKENS.has(arg)) return i;
    if (!arg.startsWith('-')) return i;
  }
  return args.length;
}

function nodeHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'usage: node -e <code> [args...]\n',
    stderr: '',
    exitCode: 0,
  };
}

function nodeVersion(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `${NODE_VERSION}\n`,
    stderr: '',
    exitCode: 0,
  };
}

/** A resolved `node` invocation, or the early-exit result to return as-is. */
type NodeInvocation =
  | { kind: 'ok'; code: string; filename: string; argv: string[]; innerCtx: CommandContext }
  | { kind: 'result'; result: { stdout: string; stderr: string; exitCode: number } };

/**
 * Map the argument vector onto a program source.
 *
 * `node`'s stdin branches consume `ctx.stdin` AS THE CODE. The inner script
 * must not also see that same buffer as its own stdin (it would be reading its
 * own source) — those branches hand it an empty stdin via a context override.
 * The `-e` and script-file branches keep the upstream pipeline's stdin intact.
 */
async function resolveInvocation(args: string[], ctx: CommandContext): Promise<NodeInvocation> {
  if (args.length > 0 && (args[0] === '-e' || args[0] === '--eval')) {
    if (!args[1]) {
      return {
        kind: 'result',
        result: { stdout: '', stderr: 'node: option requires an argument -- eval\n', exitCode: 9 },
      };
    }
    return {
      kind: 'ok',
      code: args[1],
      filename: '[eval]',
      argv: ['node', ...args.slice(2)],
      innerCtx: ctx,
    };
  }

  if (args.length > 0 && STDIN_SCRIPT_TOKENS.has(args[0])) {
    // Explicit stdin script: `node /dev/stdin << 'EOF'`, `node - < file`.
    // argv keeps the token in slot 1 (Node parity — user args stay at
    // argv[2…]), but `filename` stays the non-absolute `<stdin>` sentinel so
    // relative `require('./x')` resolves against cwd rather than the device
    // path's bogus `/dev` directory (see `entryFromDir` in
    // realm-module-system.ts).
    return {
      kind: 'ok',
      code: stdinAsText(ctx.stdin),
      filename: '<stdin>',
      argv: ['node', args[0], ...args.slice(1)],
      innerCtx: { ...ctx, stdin: EMPTY_BYTES },
    };
  }

  if (args.length > 0 && !args[0].startsWith('-')) {
    const scriptArg = args[0];
    const scriptPath = ctx.fs.resolvePath(ctx.cwd, scriptArg);
    if (!(await ctx.fs.exists(scriptPath))) {
      return {
        kind: 'result',
        result: { stdout: '', stderr: `node: cannot find module '${scriptArg}'\n`, exitCode: 1 },
      };
    }
    // Use the resolved absolute path so that skill.dir (derived from
    // dirname(argv[1]) in skill-global.ts), __dirname, and __filename
    // are all correct and absolute for BOTH relative and absolute invocations.
    return {
      kind: 'ok',
      code: await ctx.fs.readFile(scriptPath),
      filename: scriptPath,
      argv: ['node', scriptPath, ...args.slice(1)],
      innerCtx: ctx,
    };
  }

  if (stdinAsText(ctx.stdin).trim().length > 0) {
    return {
      kind: 'ok',
      code: stdinAsText(ctx.stdin),
      filename: '<stdin>',
      argv: ['node'],
      innerCtx: { ...ctx, stdin: EMPTY_BYTES },
    };
  }

  if (args.length > 0) {
    return {
      kind: 'result',
      result: { stdout: '', stderr: `node: unsupported option '${args[0]}'\n`, exitCode: 9 },
    };
  }

  return {
    kind: 'result',
    result: {
      stdout: '',
      stderr: 'node: REPL mode is not supported in this environment; use node -e "code"\n',
      exitCode: 9,
    },
  };
}

export function createNodeCommand(options: NodeCommandOptions = {}): Command {
  return {
    name: 'node',
    // just-bash monkey-patches async primitives in its defense-in-depth box for
    // untrusted commands. `executeJsCode` runs the script in a worker realm whose
    // cross-thread RPC (graph build + the `realm-done` carrying the exit code)
    // needs unpatched async I/O. Without `trusted`, the host-side await settles
    // early in the real DedicatedWorker float, so a failing `require` that exits
    // non-zero in the realm is reported to the shell as exit 0. Mark trusted so
    // just-bash runs it inside `DefenseInDepthBox.runTrustedAsync`, matching how
    // the `.jsh` script command and other host-extension commands (git, mount)
    // are registered.
    trusted: true,
    async execute(args: string[], ctx: CommandContext) {
      // Scan only the options that PRECEDE the program source: Node treats
      // `--help` / `-v` after the script token as script arguments.
      const nodeOptions = args.slice(0, programSourceIndex(args));
      if (nodeOptions.includes('--help') || nodeOptions.includes('-h')) return nodeHelp();
      if (nodeOptions.includes('--version') || nodeOptions.includes('-v')) return nodeVersion();

      const resolved = await resolveInvocation(args, ctx);
      if (resolved.kind === 'result') return resolved.result;
      const { code, filename, argv, innerCtx } = resolved;

      // `ctx.signal` identifies the run this command belongs to, so the realm
      // child parents to the right shell job even when several runs overlap.
      return executeJsCode(
        stripShebang(code),
        argv,
        innerCtx,
        options.buildProcessConfig?.(ctx.env),
        { filename }
      );
    },
  };
}
