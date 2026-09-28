import { type OpenFile, sinkFile } from '../kernel/wasm-realm/fd-table.js';

export const SHELL_CHOICE_ENV = 'SLICC_SHELL';

export const STATE_FD = 97;

export const STATE_HOOK =
  '__slicc_save() { local __s=$1 __p=$2 __c __n; { printf "%s\\0%s\\0%s\\0" "$__s" "$__p" "$PWD"; ' +
  'for __c in {A..Z} {a..z} _; do eval "__slicc_names=(\\"\\${!${__c}@}\\")"; ' +
  'for __n in "${__slicc_names[@]}"; do [[ ${!__n@a} == *x* ]] && printf "%s=%s\\0" "$__n" "${!__n}"; done; done; ' +
  `} >&${STATE_FD} 2>/dev/null; }; trap '__slicc_save "$?" "\${PIPESTATUS[*]}"' EXIT; `;

const RUN_ONLY = new Set(['SHLVL', '_']);

export interface BashRunState {
  status: number;
  pipeStatus: number[];
  cwd: string;
  env: Record<string, string>;
}

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

export function carriedEnv(
  env: Record<string, string>,
  runOnly: Iterable<string> = []
): Record<string, string> {
  const drop = new Set([...RUN_ONLY, ...runOnly]);
  return Object.fromEntries(Object.entries(env).filter(([name]) => !drop.has(name)));
}

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

  state: BashRunState | null;
}

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
