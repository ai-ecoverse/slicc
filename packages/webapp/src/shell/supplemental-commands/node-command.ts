/**
 * `node` command — runs JS code via the realm runtime so SIGKILL
 * can hard-stop runaway scripts.
 *
 * Argument shapes:
 *   - `node -e CODE [ARGS…]` — inline script
 *   - `node SCRIPT [ARGS…]` — script file from VFS
 *   - `node` with stdin piped — reads from stdin
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
  buildProcessConfig?: () => JshProcessConfig | undefined;
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
      if (args.includes('--help') || args.includes('-h')) return nodeHelp();
      if (args.includes('--version') || args.includes('-v')) return nodeVersion();

      let code = '';
      let filename: string;
      let argv: string[];
      // `node`'s read-from-stdin branch consumes `ctx.stdin` AS THE CODE.
      // The inner script must not also see that same buffer as its own
      // stdin (it would be reading its own source) — we hand it an empty
      // stdin via a context override. The `-e` and script-file branches
      // keep the upstream pipeline's stdin intact.
      let innerCtx: CommandContext = ctx;

      if (args.length > 0 && (args[0] === '-e' || args[0] === '--eval')) {
        if (!args[1]) {
          return {
            stdout: '',
            stderr: 'node: option requires an argument -- eval\n',
            exitCode: 9,
          };
        }
        code = args[1];
        filename = '[eval]';
        argv = ['node', ...args.slice(2)];
      } else if (args.length > 0 && !args[0].startsWith('-')) {
        const scriptArg = args[0];
        const scriptPath = ctx.fs.resolvePath(ctx.cwd, scriptArg);
        if (!(await ctx.fs.exists(scriptPath))) {
          return {
            stdout: '',
            stderr: `node: cannot find module '${scriptArg}'\n`,
            exitCode: 1,
          };
        }
        code = await ctx.fs.readFile(scriptPath);
        // Use the resolved absolute path so that skill.dir (derived from
        // dirname(argv[1]) in skill-global.ts), __dirname, and __filename
        // are all correct and absolute for BOTH relative and absolute invocations.
        filename = scriptPath;
        argv = ['node', scriptPath, ...args.slice(1)];
      } else if (stdinAsText(ctx.stdin).trim().length > 0) {
        code = stdinAsText(ctx.stdin);
        filename = '<stdin>';
        argv = ['node'];
        innerCtx = { ...ctx, stdin: EMPTY_BYTES };
      } else if (args.length > 0) {
        return {
          stdout: '',
          stderr: `node: unsupported option '${args[0]}'\n`,
          exitCode: 9,
        };
      } else {
        return {
          stdout: '',
          stderr: 'node: REPL mode is not supported in this environment; use node -e "code"\n',
          exitCode: 9,
        };
      }

      return executeJsCode(stripShebang(code), argv, innerCtx, options.buildProcessConfig?.(), {
        filename,
      });
    },
  };
}
