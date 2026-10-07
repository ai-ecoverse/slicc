import type { CommandContext } from 'just-bash';
import { requestPublish, requestStop } from './serve-bridge.js';
import { parseServeArgs, type ServeTarget } from './serve-catalog.js';
import {
  bindMcpRunner,
  currentPublication,
  discoverCli,
  ensureMcpServeInstalled,
  type RunFn,
  type RunResult,
  setPublication,
} from './serve-runtime.js';
import {
  loadPublication,
  type McpPublication,
  type PublishedCli,
  type TextFs,
} from './serve-store.js';

export interface McpServeCommandDeps {
  discover(path: string, explicitName?: string): Promise<PublishedCli>;
  load(): Promise<McpPublication | null>;
  save(publication: McpPublication | null): Promise<void>;
  publish(generation: number): Promise<{ url: string; token: string }>;
  setGeneration(generation: number): Promise<{ url: string; token: string }>;
  stopRemote(): Promise<void>;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runMcpServeCommand(args: string[], ctx: CommandContext): Promise<ExecResult> {
  const fs = adaptFs(ctx.fs);
  const run = await scriptRunner(ctx);
  bindMcpRunner(run);
  ensureMcpServeInstalled();
  const cwd = ctx.cwd || '/';
  return executeMcpServe(canonicalizeServeArgs(args, cwd), {
    discover: (path, name) => discoverCli(resolvePath(cwd, path), name, run),
    load: async () => currentPublication() ?? loadPublication(fs),
    save: (publication) => setPublication(fs, publication),
    publish: (generation) => requestPublish(generation),
    setGeneration: (generation) => requestPublish(generation),
    stopRemote: () => requestStop(),
  });
}

export async function executeMcpServe(
  args: string[],
  deps: McpServeCommandDeps
): Promise<ExecResult> {
  const parsed = parseServeArgs(args);
  if (parsed.error) return err(parsed.error);
  if (parsed.help) return ok(serveHelpText());
  const current = await deps.load();
  if (parsed.list) return ok(formatList(current));
  if (parsed.stop !== null) return stopPublished(parsed.stop, current, deps);
  if (parsed.targets.length === 0) return err('mcp --serve: missing path');
  return addTargets(parsed.targets, current, deps);
}

export function serveHelpText(): string {
  return `usage: mcp --serve <path> [--serve <path>…]
       mcp --serve <name>=<path>
       mcp --serve --list
       mcp --serve --stop [<name>]

Publish .jsh CLIs as one OAuth MCP server. Repeat --serve to add another
CLI to the same URL. Tool names are prefixed with the CLI name.

  mcp --serve /workspace/skills/jira/jira.jsh
  mcp --serve gh=/workspace/skills/github/scripts/gh.jsh
  mcp --serve --list
  mcp --serve --stop gh
  mcp --serve --stop
`;
}

async function addTargets(
  targets: ServeTarget[],
  current: McpPublication | null,
  deps: McpServeCommandDeps
): Promise<ExecResult> {
  const base = current ?? { url: '', token: '', grantGeneration: 0, clis: [] };
  const additions: PublishedCli[] = [];
  const names = new Set(base.clis.map((cli) => cli.name));
  for (const target of targets) {
    if (base.clis.some((cli) => cli.path === target.path)) continue;
    const discovered = await discoverOne(target, deps);
    if ('error' in discovered) return err(discovered.error);
    if (names.has(discovered.cli.name)) {
      return err(
        `mcp --serve: ${discovered.cli.name} is already published; pass name=path to rename one`
      );
    }
    names.add(discovered.cli.name);
    additions.push(discovered.cli);
  }
  if (additions.length === 0) {
    if (!current?.url) return err('mcp --serve: missing path');
    return ok(`${current.url}\n`);
  }
  const clis = base.clis.concat(additions);
  try {
    return await saveAdded(current, clis, deps);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'mcp --serve: publish failed';
    return err(message);
  }
}

async function saveAdded(
  current: McpPublication | null,
  clis: PublishedCli[],
  deps: McpServeCommandDeps
): Promise<ExecResult> {
  if (!current) {
    const minted = await deps.publish(1);
    const publication = { url: minted.url, token: minted.token, grantGeneration: 1, clis };
    await deps.save(publication);
    return ok(`${publication.url}\n`);
  }
  const grantGeneration = current.grantGeneration + 1;
  const minted = await deps.setGeneration(grantGeneration);
  const publication = {
    ...current,
    url: minted.url || current.url,
    token: minted.token || current.token,
    grantGeneration,
    clis,
  };
  await deps.save(publication);
  return ok(`${publication.url}\n`);
}

async function discoverOne(
  target: ServeTarget,
  deps: McpServeCommandDeps
): Promise<{ cli: PublishedCli } | { error: string }> {
  try {
    return { cli: await deps.discover(target.path, target.name) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'mcp --serve: discovery failed' };
  }
}

async function stopPublished(
  stop: string | true,
  current: McpPublication | null,
  deps: McpServeCommandDeps
): Promise<ExecResult> {
  if (!current) return err('mcp --serve: nothing is published');
  if (typeof stop !== 'string') return await stopAll(deps);

  const clis = current.clis.filter((cli) => cli.name !== stop);
  if (clis.length === current.clis.length) return err(`mcp --serve: no CLI named ${stop}`);
  if (clis.length === 0) return await stopAll(deps);
  await deps.save({ ...current, clis });
  return ok(`${current.url}\n`);
}

async function stopAll(deps: McpServeCommandDeps): Promise<ExecResult> {
  try {
    await deps.stopRemote();
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'mcp --serve: stop failed';
    return err(message);
  }
  await deps.save(null);
  return ok('stopped\n');
}

function formatList(current: McpPublication | null): string {
  if (!current) return 'mcp --serve: nothing is published\n';
  const lines = [current.url, ...current.clis.map((cli) => `${cli.name}\t${cli.path}`)];
  return `${lines.join('\n')}\n`;
}

async function scriptRunner(ctx: CommandContext): Promise<RunFn> {
  const { executeJshFile } = await import('../jsh-executor.js');
  const { textAsStdin } = await import('../just-bash-compat.js');
  return (filePath, argv, stdin) => {
    const result = executeJshFile(filePath, argv, { ...ctx, stdin: textAsStdin(stdin ?? '') });
    return result.then((value) => toRunResult(value));
  };
}

function toRunResult(value: { stdout: string; stderr: string; exitCode: number }): RunResult {
  return { stdout: value.stdout, stderr: value.stderr, exitCode: value.exitCode };
}

function adaptFs(fs: CommandContext['fs']): TextFs {
  return {
    readFile: (path) => fs.readFile(path),
    writeFile: (path, content) => fs.writeFile(path, content),
    exists: (path) => fs.exists(path),
    mkdir: async (path) => {
      if (await fs.exists(path)) return;
      await fs.mkdir(path);
    },
  };
}

function canonicalizeServeArgs(args: string[], cwd: string): string[] {
  const canonical: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    canonical.push(arg);
    if (arg !== '--serve') continue;
    const next = args[i + 1];
    if (!next || next.startsWith('--')) continue;
    canonical.push(canonicalizeTarget(next, cwd));
    i++;
  }
  return canonical;
}

function canonicalizeTarget(raw: string, cwd: string): string {
  const eq = raw.indexOf('=');
  if (eq > 0 && !raw.slice(0, eq).includes('/')) {
    return `${raw.slice(0, eq)}=${resolvePath(cwd, raw.slice(eq + 1))}`;
  }
  return resolvePath(cwd, raw);
}

function resolvePath(cwd: string, path: string): string {
  if (path.startsWith('/')) return path;
  const base = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd;
  return `${base}/${path}`;
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function err(message: string): ExecResult {
  return { stdout: '', stderr: message.endsWith('\n') ? message : `${message}\n`, exitCode: 1 };
}
