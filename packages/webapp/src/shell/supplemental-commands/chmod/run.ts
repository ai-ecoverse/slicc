/**
 * `chmod` implementation, imported on first use by the registration stub.
 *
 * Overlay just-bash's `chmod`. Upstream catches every filesystem error and
 * prints `cannot access: No such file or directory`, so `VfsAdapter.chmod()`
 * throwing `EOPNOTSUPP` still looked like a missing file. Agents then
 * recorded a false cause (#3109). This overlay reports the real errno.
 */

import type { CommandContext } from 'just-bash';

const HELP = `Usage: chmod [OPTION]... MODE FILE...
Change the mode of each FILE to MODE.

  -R, --recursive  change files and directories recursively
  -v, --verbose    output a diagnostic for every file processed
      --help       display this help and exit

This VFS does not store permission bits. chmod exits non-zero with
EOPNOTSUPP rather than succeeding as a no-op. Run scripts with their
interpreter (e.g. bash FILE); ./FILE cannot work.
`;

const FLAG = /^-R$|^--recursive$|^-v$|^--verbose$|^-[Rv]+$/;

type CmdResult = { stdout: string; stderr: string; exitCode: number };

function isModeToken(token: string): boolean {
  return (
    /^[0-7]+$/.test(token) || /^([ugoa]*[+\-=][rwxXst]*)(,([ugoa]*[+\-=][rwxXst]*))*$/.test(token)
  );
}

/** Octal as written; symbolic `+x` requests the execute bits. Other modes keep current. */
function requestedMode(spec: string, current: number): number {
  if (/^[0-7]+$/.test(spec)) return parseInt(spec, 8);
  if (/x/i.test(spec) && !spec.includes('-')) return current | 0o111;
  return current;
}

async function chmodPath(ctx: CommandContext, file: string, spec: string): Promise<void> {
  const path = ctx.fs.resolvePath(ctx.cwd, file);
  const st = await ctx.fs.stat(path);
  await ctx.fs.chmod(path, requestedMode(spec, st.mode));
}

export async function runChmod(args: string[], ctx: CommandContext): Promise<CmdResult> {
  const positional: string[] = [];
  let help = false;
  let endOpts = false;
  for (const arg of args) {
    if (!endOpts && arg === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && arg === '--help') {
      help = true;
      continue;
    }
    if (!endOpts && FLAG.test(arg)) continue;
    positional.push(arg);
  }
  if (help) return { stdout: HELP, stderr: '', exitCode: 0 };

  const spec = positional[0];
  const files = positional.slice(1);
  if (!spec || files.length === 0) {
    return { stdout: '', stderr: 'chmod: missing operand\n', exitCode: 1 };
  }
  if (!isModeToken(spec)) {
    return { stdout: '', stderr: `chmod: invalid mode: '${spec}'\n`, exitCode: 1 };
  }

  const errors: string[] = [];
  for (const file of files) {
    try {
      await chmodPath(ctx, file, spec);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(`chmod: ${file}: ${detail}`);
    }
  }
  const stderr = errors.length === 0 ? '' : `${errors.join('\n')}\n`;
  return { stdout: '', stderr, exitCode: errors.length === 0 ? 0 : 1 };
}
