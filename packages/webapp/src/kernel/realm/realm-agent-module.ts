/**
 * `realm-agent-module.ts` — the `sliccy:agent` module: client-side sugar
 * over the `exec` bridge that shells out to the `agent` supplemental command
 * to spawn `.jsh` workflows. Extracted from `js-realm-shared.ts`; no behavior
 * change.
 */
import type { ExecBridge } from './realm-exec-bridge.js';

/** Options accepted by the `sliccy:agent` callable and its `.spawn` variant. */
interface SliccyAgentOptions {
  /** Model id override forwarded as `--model`. */
  model?: string;
  /** Reasoning level forwarded as `--thinking` (off|minimal|low|medium|high|xhigh). */
  thinking?: string;
  /** StructuredOutput contract; base64-encoded JSON forwarded as `--schema-b64`. */
  schema?: unknown;
  /** Spawned scoop's writable cwd; defaults to the realm cwd. */
  cwd?: string;
  /** Comma-separated allowed bash commands; defaults to `*`. */
  allowedCommands?: string;
  /** Read-only VFS paths (array or CSV) forwarded as `--read-only`; defaults to `/workspace/`. */
  readOnly?: string | string[];
}

/** Non-throwing result shape returned by `agent.spawn`. */
interface SliccyAgentSpawnResult {
  finalText: string;
  exitCode: number;
  stderr: string;
}

/** The `sliccy:agent` module: a callable with a non-throwing `.spawn` sibling. */
type SliccyAgentModule = ((prompt: string, opts?: SliccyAgentOptions) => Promise<unknown>) & {
  spawn: (prompt: string, opts?: SliccyAgentOptions) => Promise<SliccyAgentSpawnResult>;
};

/**
 * Base64-encode a UTF-8 string for `--schema-b64`. Same byte-for-byte shape as
 * the workflow-DSL `__b64` helper in `workflow-prelude.ts` (TextEncoder →
 * String.fromCharCode → btoa), so the `agent` command's `atob`/`TextDecoder`
 * decode path round-trips identically.
 */
function agentSchemaToB64(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Build the `agent` command argv. Mirrors the workflow-DSL `agent()` in
 * `workflow-prelude.ts`: flags (`--model` / `--thinking` / `--schema-b64`)
 * first, then the `--read-only <csv>` flag and the three positionals
 * `<cwd> <allowedCommands> <prompt>`.
 */
function buildAgentArgv(prompt: string, opts: SliccyAgentOptions, realmCwd: string): string[] {
  const flags: string[] = [];
  if (opts.model) flags.push('--model', String(opts.model));
  if (opts.thinking) flags.push('--thinking', String(opts.thinking));
  if (opts.schema) flags.push('--schema-b64', agentSchemaToB64(JSON.stringify(opts.schema)));
  const readOnly =
    opts.readOnly === undefined
      ? '/workspace/'
      : Array.isArray(opts.readOnly)
        ? opts.readOnly.join(',')
        : String(opts.readOnly);
  const cwd = opts.cwd !== undefined ? String(opts.cwd) : realmCwd || '.';
  const allowed = opts.allowedCommands !== undefined ? String(opts.allowedCommands) : '*';
  return ['agent', ...flags, '--read-only', readOnly, cwd, allowed, String(prompt)];
}

/**
 * `sliccy:agent` — client-side sugar over the `exec` bridge that shells out to
 * the `agent` supplemental command (spawn a sub-scoop, feed it a task, block
 * until the agent loop completes). Option A: no host/RPC channel; argv
 * construction mirrors the workflow-DSL `agent()` in `workflow-prelude.ts`.
 *
 * The callable `agent(prompt, opts?)` resolves to trimmed stdout (JSON-parsed
 * when `opts.schema` is set) and REJECTS with an Error (message carries stderr
 * + exitCode) on a non-zero exit or a schema parse failure. `agent.spawn` is
 * the non-throwing variant — resolves `{ finalText, exitCode, stderr }`
 * regardless of exit code.
 */
export function createSliccyAgentModule(
  execBridge: ExecBridge,
  opts: { cwd: string }
): SliccyAgentModule {
  const realmCwd = opts.cwd;
  const spawn = async (
    prompt: string,
    agentOpts?: SliccyAgentOptions
  ): Promise<SliccyAgentSpawnResult> => {
    const o = agentOpts ?? {};
    const r = await execBridge.spawn(buildAgentArgv(prompt, o, realmCwd));
    const exitCode = typeof r.exitCode === 'number' ? r.exitCode : 0;
    const finalText = String(r.stdout ?? '').replace(/\n+$/, '');
    const stderr = String(r.stderr ?? '').replace(/\n+$/, '');
    return { finalText, exitCode, stderr };
  };
  const agent = (async (prompt: string, agentOpts?: SliccyAgentOptions): Promise<unknown> => {
    const o = agentOpts ?? {};
    const res = await spawn(prompt, o);
    if (res.exitCode !== 0) {
      throw new Error(
        `agent: exited with code ${res.exitCode}${res.stderr ? `: ${res.stderr}` : ''}`
      );
    }
    if (o.schema) {
      try {
        return JSON.parse(res.finalText);
      } catch {
        throw new Error(
          `agent: schema response was not valid JSON (exit ${res.exitCode}): ${res.finalText.slice(0, 200)}`
        );
      }
    }
    return res.finalText;
  }) as SliccyAgentModule;
  agent.spawn = spawn;
  return agent;
}
