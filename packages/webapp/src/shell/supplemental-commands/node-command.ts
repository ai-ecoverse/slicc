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
 * RPC, `fetch` via SecureFetch RPC), `require()` pre-fetch via
 * esm.sh / cdn.jsdelivr.net. See `kernel/realm/js-realm-shared.ts`
 * for the full list.
 */

import { defineCommand } from 'just-bash';
import type { Command, CommandContext } from 'just-bash';
import { NODE_VERSION } from './shared.js';
import { executeJsCode } from '../jsh-executor.js';

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

export function createNodeCommand(): Command {
  return defineCommand('node', async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) return nodeHelp();
    if (args.includes('--version') || args.includes('-v')) return nodeVersion();

    let code = '';
    let filename = '<stdin>';
    let argv: string[] = ['node'];
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
      filename = scriptArg;
      argv = ['node', scriptArg, ...args.slice(1)];
    } else if (ctx.stdin.trim().length > 0) {
      code = ctx.stdin;
      filename = '<stdin>';
      argv = ['node'];
      innerCtx = { ...ctx, stdin: '' };
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

    return executeJsCode(code, argv, innerCtx, undefined, { filename });
  });
}
