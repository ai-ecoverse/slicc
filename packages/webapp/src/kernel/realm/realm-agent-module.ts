import type { ExecBridge } from './realm-exec-bridge.js';

interface SliccyAgentOptions {
  model?: string;

  thinking?: string;

  schema?: unknown;

  cwd?: string;

  allowedCommands?: string;

  readOnly?: string | string[];

  images?: string[];

  escalate?: boolean;

  systemPrompt?: string;

  minimal?: boolean;

  tools?: 'auto' | 'full' | 'output';

  session?: string;

  resume?: boolean;

  envelope?: boolean;
}

interface AgentCallUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface SliccyAgentSpawnResult {
  finalText: string;
  exitCode: number;

  stderr: string;
  sessionId?: string;
  sessionStatus?: 'created' | 'resumed';
  usage?: AgentCallUsage;
}

interface SliccyAgentEnvelope {
  output: unknown;
  sessionId?: string;
  sessionStatus?: 'created' | 'resumed';
  usage?: AgentCallUsage;
}

type SliccyAgentModule = ((prompt: string, opts?: SliccyAgentOptions) => Promise<unknown>) & {
  spawn: (prompt: string, opts?: SliccyAgentOptions) => Promise<SliccyAgentSpawnResult>;
};

function agentSchemaToB64(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

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
      } catch {}
    }
    if (line !== '') kept.push(line);
  }
  return { stderr: kept.join('\n'), sessionId, sessionStatus, usage };
}

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
