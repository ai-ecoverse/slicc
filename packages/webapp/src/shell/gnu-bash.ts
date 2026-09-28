/**
 * `gnu-bash.ts` — a shell's commands on GNU bash (#3530).
 *
 * When an installed package provides `bash` (`@ai-ecoverse/wasm-bash`), the
 * agent's shell runs each command as `bash -c COMMAND` in the wasm realm
 * instead of on just-bash: real pipes, job control, and the programs' own
 * semantics. Every call is a fresh bash; the working directory and the
 * exported environment carry over to the next call, as they do on just-bash.
 * A command bash finds no wasm program for runs through just-bash (the
 * shell's command registry), so every supplemental command stays reachable.
 *
 * What a run leaves behind (exit status, PIPESTATUS, `$PWD`, the exported
 * variables) comes back over a private descriptor, fd {@link STATE_FD}, a
 * sink only the runner holds: a one-line hook, prepended to the command on
 * its first line (so line numbers stay the user's), sets an EXIT trap that
 * writes the state there. Nothing touches the filesystem: `$TMPDIR` is under
 * `/tmp`, which every scoop can write, so a hook or state file there could be
 * swapped to run code, or inject a PATH, with another unit's authority. A
 * command that replaces the trap, ends in `exec`, or has a syntax error on
 * its first line leaves no state, and the shell keeps its previous one.
 * `SLICC_SHELL=just-bash` (in `~/.profile`, say) keeps a shell on just-bash.
 */

import { type OpenFile, sinkFile } from '../kernel/wasm-realm/fd-table.js';

/** Set to `just-bash` to keep a shell on just-bash though GNU bash is installed. */
export const SHELL_CHOICE_ENV = 'SLICC_SHELL';

/**
 * The descriptor the state comes back on: out of the way of scripts' own
 * (`exec 3>file`) and of bash's saved descriptors (10 and up).
 */
export const STATE_FD = 97;

/**
 * Put in front of the command, on its first line. Its EXIT trap writes the
 * run's state to fd {@link STATE_FD}, NUL-separated: status, PIPESTATUS,
 * `$PWD`, then `NAME=value` per exported variable. Builtins only (no
 * `compgen`: bash is built without readline): names by initial, kept when
 * the named variable's attributes (`${!name@a}`) include `x`.
 */
export const STATE_HOOK =
  '__slicc_save() { local __s=$1 __p=$2 __c __n; { printf "%s\\0%s\\0%s\\0" "$__s" "$__p" "$PWD"; ' +
  'for __c in {A..Z} {a..z} _; do eval "__slicc_names=(\\"\\${!${__c}@}\\")"; ' +
  'for __n in "${__slicc_names[@]}"; do [[ ${!__n@a} == *x* ]] && printf "%s=%s\\0" "$__n" "${!__n}"; done; done; ' +
  `} >&${STATE_FD} 2>/dev/null; }; trap '__slicc_save "$?" "\${PIPESTATUS[*]}"' EXIT; `;

/** Exported variables that belong to one run, never to the shell's state. */
const RUN_ONLY = new Set(['SHLVL', '_']);

export interface BashRunState {
  status: number;
  pipeStatus: number[];
  cwd: string;
  env: Record<string, string>;
}

/** The hook's state file; `null` when it is not one (an empty or cut-off file). */
export function parseBashState(text: string): BashRunState | null {
  const parts = text.split('\0');
  if (parts.length < 4) return null;
  const [status = '', pipe = '', cwd = '', ...vars] = parts;
  if (!/^\d+$/.test(status) || !cwd.startsWith('/')) return null;
  const env: Record<string, string> = {};
  for (const entry of vars) {
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  const pipeStatus = pipe.trim() === '' ? [] : pipe.trim().split(/\s+/).map(Number);
  return { status: Number(status), pipeStatus, cwd, env };
}

/** The environment to carry into the next call: the run's exports, minus its own markers. */
export function carriedEnv(
  env: Record<string, string>,
  runOnly: Iterable<string> = []
): Record<string, string> {
  const drop = new Set([...RUN_ONLY, ...runOnly]);
  return Object.fromEntries(Object.entries(env).filter(([name]) => !drop.has(name)));
}

/** A byte-exact (latin1) output as the text it encodes (UTF-8). */
export function outputText(output: string, kind: string | undefined): string {
  if (kind !== 'bytes') return output;
  const bytes = new Uint8Array(output.length);
  for (let i = 0; i < output.length; i++) bytes[i] = output.charCodeAt(i) & 0xff;
  return new TextDecoder().decode(bytes);
}

export interface GnuBashRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** What the run left, or `null` (it replaced the trap, exec'd, or was killed). */
  state: BashRunState | null;
}

/**
 * Run `command` on GNU bash through `run` (the `wasm` runner, handed
 * `['bash', '-c', HOOK + command]`, the environment to start it with, and
 * the state descriptor to give the program).
 */
export async function runOnGnuBash(
  command: string,
  deps: {
    env: Record<string, string>;
    run: (
      args: string[],
      env: Record<string, string>,
      fds: ReadonlyArray<readonly [number, OpenFile]>
    ) => Promise<{ stdout: string; stderr: string; exitCode: number; stdoutKind?: string }>;
  }
): Promise<GnuBashRunResult> {
  const chunks: Uint8Array[] = [];
  const state = sinkFile((bytes) => chunks.push(bytes));
  const result = await deps.run(['bash', '-c', `${STATE_HOOK}${command}`], deps.env, [
    [STATE_FD, state],
  ]);
  const size = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return {
    stdout: outputText(result.stdout, result.stdoutKind),
    stderr: result.stderr,
    exitCode: result.exitCode,
    state: size > 0 ? parseBashState(new TextDecoder().decode(all)) : null,
  };
}
