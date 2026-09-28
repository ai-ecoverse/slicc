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
 * variables) comes back through a file: `BASH_ENV` names a hook that bash
 * sources before the command, and its EXIT trap writes the state. A command
 * that replaces the trap or ends in `exec` leaves none, and the shell keeps
 * its previous state. `SLICC_SHELL=just-bash` (in `~/.profile`, say) keeps a
 * shell on just-bash.
 */

/** Set to `just-bash` to keep a shell on just-bash though GNU bash is installed. */
export const SHELL_CHOICE_ENV = 'SLICC_SHELL';

const STATE_ENV = 'SLICC_BASH_STATE';

/**
 * Sourced by bash before the command (`BASH_ENV`). Its EXIT trap writes the
 * run's state, NUL-separated: status, PIPESTATUS, `$PWD`, then `NAME=value`
 * per exported variable. Builtins only (no `compgen`: bash is built without
 * readline): names by initial, kept when the named variable's attributes
 * (`${!name@a}`) include `x`. The
 * hook takes itself out of the environment, so a nested bash does not run it.
 */
export const STATE_HOOK = `__slicc_state=$${STATE_ENV}
unset BASH_ENV ${STATE_ENV}
__slicc_save() {
  local __s=$1 __p=$2 __c __n
  {
    printf '%s\\0%s\\0%s\\0' "$__s" "$__p" "$PWD"
    for __c in {A..Z} {a..z} _; do
      eval '__slicc_names=("\${!'"$__c"'@}")'
      for __n in "\${__slicc_names[@]}"; do
        [[ \${!__n@a} == *x* ]] && printf '%s=%s\\0' "$__n" "\${!__n}"
      done
    done
  } >"$__slicc_state" 2>/dev/null
}
trap '__slicc_save "$?" "\${PIPESTATUS[*]}"' EXIT
`;

/** Exported variables that belong to one run, never to the shell's state. */
const RUN_ONLY = new Set(['SHLVL', '_', 'BASH_ENV', STATE_ENV]);

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

export interface GnuBashFs {
  mkdir(path: string, options: { recursive: true }): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string, options: { encoding: 'utf-8' }): Promise<string | Uint8Array>;
  rm(path: string): Promise<void>;
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
 * `['bash', '-c', command]` and the environment to start it with).
 */
export async function runOnGnuBash(
  command: string,
  deps: {
    fs: GnuBashFs;
    tmpDir: string;
    env: Record<string, string>;
    run: (
      args: string[],
      env: Record<string, string>
    ) => Promise<{ stdout: string; stderr: string; exitCode: number; stdoutKind?: string }>;
  }
): Promise<GnuBashRunResult> {
  const dir = deps.tmpDir.replace(/\/+$/, '') || '/tmp';
  const hook = `${dir}/.slicc-bash-env.sh`;
  const statePath = `${dir}/.slicc-bash-state-${crypto.randomUUID()}`;
  await deps.fs.mkdir(dir, { recursive: true });
  await deps.fs.writeFile(hook, STATE_HOOK);
  const result = await deps.run(['bash', '-c', command], {
    ...deps.env,
    BASH_ENV: hook,
    [STATE_ENV]: statePath,
  });
  let state: BashRunState | null = null;
  try {
    const raw = await deps.fs.readFile(statePath, { encoding: 'utf-8' });
    state = parseBashState(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    await deps.fs.rm(statePath);
  } catch {
    // No state: the run replaced the trap, exec'd, or was killed.
  }
  return {
    stdout: outputText(result.stdout, result.stdoutKind),
    stderr: result.stderr,
    exitCode: result.exitCode,
    state,
  };
}
