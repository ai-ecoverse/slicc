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
  /**
   * Read-only VFS paths (array or CSV) forwarded as `--read-only`. Omitted,
   * the flag is not sent at all, so the spawned scoop gets the `agent`
   * command's owner-relative default — the OWNING cone's workspace plus the
   * invoking cwd (#2271), not a hardcoded `/workspace/`.
   */
  readOnly?: string | string[];
  /**
   * VFS paths of images (PNG, JPEG, GIF, WebP) attached to the prompt, each
   * forwarded as `--image`; at most 8. The scoop sees them without needing a
   * command to open them.
   */
  images?: string[];
  /**
   * `false` forwards `--no-escalate`: a command outside `allowedCommands` or
   * a write outside the scoop's paths is refused at once instead of asking
   * the invoking cone. Omitted or `true` keeps the default (escalate).
   */
  escalate?: boolean;
  /** System prompt body. A safety trailer is still appended by the bridge. */
  systemPrompt?: string;
  /** Short decision prompt instead of the skills essay. */
  minimal?: boolean;
  /** `auto` (default), `full`, or `output` (StructuredOutput only; needs `schema`). */
  tools?: 'auto' | 'full' | 'output';
  /**
   * Named session. The callable then returns
   * `{ output, sessionId, sessionStatus, usage? }` instead of the bare value.
   * The same id appends a turn. An idle-expired id starts over (`created`).
   */
  session?: string;
  /**
   * Resume `session` only. A missing or idle-expired id rejects (exit 2)
   * instead of starting a new scoop. Requires `session`.
   */
  resume?: boolean;
  /**
   * Return `{ output, sessionId?, sessionStatus?, usage? }` even without a
   * session. Implied when `session` or `resume` is set.
   */
  envelope?: boolean;
}

interface AgentCallUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** Non-throwing result shape returned by `agent.spawn`. */
interface SliccyAgentSpawnResult {
  finalText: string;
  exitCode: number;
  /** User-facing stderr. `agent-session` / `agent-usage` lines are lifted off it. */
  stderr: string;
  sessionId?: string;
  sessionStatus?: 'created' | 'resumed';
  usage?: AgentCallUsage;
}

/** What the callable returns once a session, resume, or `envelope` is requested. */
interface SliccyAgentEnvelope {
  output: unknown;
  sessionId?: string;
  sessionStatus?: 'created' | 'resumed';
  usage?: AgentCallUsage;
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
 * first, then an optional `--read-only <csv>` flag, one `--image <path>` per
 * image, `--no-escalate` for `escalate: false`, and the three positionals
 * `<cwd> <allowedCommands> <prompt>`.
 *
 * `--read-only` is emitted ONLY when the caller asked for it. The flag is
 * pure-replace, so passing a default here would override the command's
 * owner-relative roots and hand JS running under an extra cone the PRIMARY
 * cone's files instead of its own (#2271).
 */
function buildAgentArgv(prompt: string, opts: SliccyAgentOptions, realmCwd: string): string[] {
  const flags: string[] = [];
  if (opts.model) flags.push('--model', String(opts.model));
  if (opts.thinking) flags.push('--thinking', String(opts.thinking));
  if (opts.schema) flags.push('--schema-b64', agentSchemaToB64(JSON.stringify(opts.schema)));
  if (opts.readOnly !== undefined) {
    flags.push(
      '--read-only',
      Array.isArray(opts.readOnly) ? opts.readOnly.join(',') : String(opts.readOnly)
    );
  }
  for (const image of opts.images ?? []) flags.push('--image', String(image));
  if (opts.escalate === false) flags.push('--no-escalate');
  if (opts.minimal) flags.push('--minimal');
  if (opts.systemPrompt !== undefined) flags.push(`--system-prompt=${String(opts.systemPrompt)}`);
  if (opts.tools) flags.push('--tools', String(opts.tools));
  if (opts.resume) flags.push('--resume', String(opts.session ?? ''));
  else if (opts.session !== undefined) flags.push('--session', String(opts.session));
  if (opts.envelope && opts.session === undefined && opts.resume !== true) flags.push('--usage');
  const cwd = opts.cwd !== undefined ? String(opts.cwd) : realmCwd || '.';
  const allowed = opts.allowedCommands !== undefined ? String(opts.allowedCommands) : '*';
  return ['agent', ...flags, cwd, allowed, String(prompt)];
}

/**
 * Lift `agent-session` and `agent-usage` lines off stderr. The command prints
 * them only when a session or `--usage` was requested; the callable turns
 * them into fields and leaves the user's stderr alone.
 */
function takeAgentTrailer(stderr: string): {
  stderr: string;
  sessionId?: string;
  sessionStatus?: 'created' | 'resumed';
  usage?: AgentCallUsage;
} {
  const kept: string[] = [];
  let sessionId: string | undefined;
  let sessionStatus: 'created' | 'resumed' | undefined;
  let usage: AgentCallUsage | undefined;
  for (const line of stderr.split('\n')) {
    if (line.startsWith('agent-session: ')) {
      const rest = line.slice('agent-session: '.length);
      const splitAt = rest.lastIndexOf(' ');
      const id = splitAt === -1 ? '' : rest.slice(0, splitAt);
      const status = splitAt === -1 ? '' : rest.slice(splitAt + 1);
      if (id && (status === 'created' || status === 'resumed')) {
        sessionId = id;
        sessionStatus = status;
        continue;
      }
    } else if (line.startsWith('agent-usage: ')) {
      try {
        const parsed = JSON.parse(line.slice('agent-usage: '.length)) as AgentCallUsage;
        if (parsed && typeof parsed.input === 'number' && typeof parsed.cost === 'number') {
          usage = parsed;
          continue;
        }
      } catch {
        // Not our trailer. Leave the line for the caller.
      }
    }
    if (line !== '') kept.push(line);
  }
  return { stderr: kept.join('\n'), sessionId, sessionStatus, usage };
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
    if (o.resume === true && (o.session === undefined || o.session === '')) {
      return { finalText: '', exitCode: 1, stderr: 'agent: resume requires a session id' };
    }
    const r = await execBridge.spawn(buildAgentArgv(prompt, o, realmCwd));
    const exitCode = typeof r.exitCode === 'number' ? r.exitCode : 0;
    const finalText = String(r.stdout ?? '').replace(/\n+$/, '');
    const peeled = takeAgentTrailer(String(r.stderr ?? '').replace(/\n+$/, ''));
    return {
      finalText,
      exitCode,
      stderr: peeled.stderr,
      ...(peeled.sessionId
        ? { sessionId: peeled.sessionId, sessionStatus: peeled.sessionStatus }
        : {}),
      ...(peeled.usage ? { usage: peeled.usage } : {}),
    };
  };
  const agent = (async (prompt: string, agentOpts?: SliccyAgentOptions): Promise<unknown> => {
    const o = agentOpts ?? {};
    const res = await spawn(prompt, o);
    if (res.exitCode !== 0) {
      throw new Error(
        `agent: exited with code ${res.exitCode}${res.stderr ? `: ${res.stderr}` : ''}`
      );
    }
    let output: unknown = res.finalText;
    if (o.schema) {
      try {
        output = JSON.parse(res.finalText);
      } catch {
        throw new Error(
          `agent: schema response was not valid JSON (exit ${res.exitCode}): ${res.finalText.slice(0, 200)}`
        );
      }
    }
    if (o.session !== undefined || o.resume === true || o.envelope === true) {
      const envelope: SliccyAgentEnvelope = { output };
      if (res.sessionId) {
        envelope.sessionId = res.sessionId;
        envelope.sessionStatus = res.sessionStatus;
      }
      if (res.usage) envelope.usage = res.usage;
      return envelope;
    }
    return output;
  }) as SliccyAgentModule;
  agent.spawn = spawn;
  return agent;
}
