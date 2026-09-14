import type { ExecBridge } from './realm-exec-bridge.js';

interface SliccyAgentOptions {
  model?: string;

  thinking?: string;

  schema?: unknown;

  cwd?: string;

  allowedCommands?: string;

  readOnly?: string | string[];
}

interface SliccyAgentSpawnResult {
  finalText: string;
  exitCode: number;
  stderr: string;
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
  const cwd = opts.cwd !== undefined ? String(opts.cwd) : realmCwd || '.';
  const allowed = opts.allowedCommands !== undefined ? String(opts.allowedCommands) : '*';
  return ['agent', ...flags, cwd, allowed, String(prompt)];
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
