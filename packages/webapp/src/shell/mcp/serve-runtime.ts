import { createLogger } from '../../base/logger.js';
import { installMcpServeKernel, requestPublish } from './serve-bridge.js';
import {
  argvForCommand,
  attachGlobalFlags,
  buildTools,
  type CliCommand,
  cliPrefix,
  isGroupCandidate,
  nestGroup,
  parseHelp,
  parseMcpOverride,
  readToolArguments,
  type ServeTool,
} from './serve-catalog.js';
import { type ConsentTool, renderConsentPage } from './serve-consent.js';
import { handleJsonRpc } from './serve-jsonrpc.js';
import {
  loadPublication,
  type McpPublication,
  type PublishedCli,
  savePublication,
  type TextFs,
} from './serve-store.js';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type RunFn = (filePath: string, argv: string[], stdin?: string) => Promise<RunResult>;

export interface McpCallResult {
  status: number;
  contentType: string;
  body: string;
}

const TOOL_BUDGET_MS = 100_000;
const JSON_TYPE = 'application/json; charset=utf-8';
const log = createLogger('mcp-serve');

let publication: McpPublication | null = null;
let runner: RunFn | null = null;
let textFs: TextFs | null = null;
let installed = false;
let pageReady = false;
const tails = new Map<string, Promise<unknown>>();

export function bindMcpRunner(run: RunFn): void {
  runner = run;
}

export function currentPublication(): McpPublication | null {
  return publication;
}

export async function restoreMcpServe(fs: TextFs, run: RunFn): Promise<void> {
  runner = run;
  textFs = fs;
  publication = await loadPublication(fs);
  ensureMcpServeInstalled();
  if (pageReady && publication) void republish();
}

export async function setPublication(fs: TextFs, next: McpPublication | null): Promise<void> {
  textFs = fs;
  publication = next;
  await savePublication(fs, next);
}

export function ensureMcpServeInstalled(): void {
  if (installed) return;
  installed = true;
  installMcpServeKernel(
    (op, body) => handleMcpServeOp(op, body),
    () => {
      pageReady = true;
      if (publication) void republish();
    }
  );
}

export async function discoverCli(
  filePath: string,
  explicitName: string | undefined,
  run: RunFn
): Promise<PublishedCli> {
  const mcp = await run(filePath, ['--mcp']);
  const override = mcp.exitCode === 0 ? parseMcpOverride(mcp.stdout) : null;
  const helped = await runHelp(filePath, run);
  if (!helped && !override) throw new Error(`mcp --serve: ${filePath} did not print help`);
  const helpText = helped?.stdout ?? '';
  const parsed = override ?? parseHelp(helpText);
  const commands = override
    ? parsed.commands
    : attachGlobalFlags(await expandGroups(filePath, parsed.commands, run), parsed.globalFlags);
  return { name: cliPrefix(helpText, filePath, explicitName), path: filePath, helpText, commands };
}

export async function handleMcpServeOp(
  op: 'rpc' | 'consent',
  body: string
): Promise<McpCallResult> {
  if (!publication) return jsonResult(503, { error: 'not published' });
  if (op === 'consent') return consentResult(body, publication);
  const tools = publication.clis.flatMap((cli) => buildTools(cli.name, cli.commands));
  const outcome = await handleJsonRpc(body, tools, (name, args) => invokeTool(name, args));
  return { status: outcome.status, contentType: outcome.contentType, body: outcome.body };
}

async function expandGroups(
  filePath: string,
  commands: CliCommand[],
  run: RunFn
): Promise<CliCommand[]> {
  const topNames = new Set(commands.map((command) => command.path[0] ?? ''));
  let current = commands;
  for (const command of commands) {
    if (!isGroupCandidate(command)) continue;
    const group = command.path[0] ?? '';
    const nestedRun = await run(filePath, [group, '--help']);
    if (nestedRun.exitCode !== 0 || !nestedRun.stdout.trim()) continue;
    const replaced = nestGroup(current, group, parseHelp(nestedRun.stdout), topNames);
    if (replaced) current = replaced;
  }
  return current;
}

async function runHelp(filePath: string, run: RunFn): Promise<RunResult | null> {
  const dashed = await run(filePath, ['--help']);
  if (dashed.exitCode === 0 && dashed.stdout.trim()) return dashed;
  const plain = await run(filePath, ['help']);
  if (plain.exitCode === 0 && plain.stdout.trim()) return plain;
  return dashed.stdout.trim() ? dashed : null;
}

async function invokeTool(name: string, args: unknown): Promise<RunResult> {
  const found = findTool(name);
  const run = runner;
  if (!found || !run) return { stdout: '', stderr: `unknown tool ${name}\n`, exitCode: 1 };

  const execution = enqueue(found.cli.name, () => executeTool(found.tool, found.cli, args, run));
  return awaitBudget(execution);
}

function executeTool(
  tool: ServeTool,
  cli: PublishedCli,
  args: unknown,
  run: RunFn
): Promise<RunResult> {
  if (tool.kind === 'help') return runHelpTool(cli.path, run);
  const planned = planInvocation(tool, cli, args);
  if ('error' in planned) {
    return Promise.resolve({ stdout: '', stderr: `${planned.error}\n`, exitCode: 2 });
  }
  return run(cli.path, planned.argv, planned.stdin);
}

async function runHelpTool(filePath: string, run: RunFn): Promise<RunResult> {
  const dashed = await run(filePath, ['--help']).catch(timedOut);
  if (dashed.exitCode === 0) return dashed;
  return run(filePath, ['help']).catch(() => dashed);
}

function timedOut(): RunResult {
  return { stdout: '', stderr: 'timed out\n', exitCode: 124 };
}

async function awaitBudget(work: Promise<RunResult>): Promise<RunResult> {
  try {
    return await withTimeout(work, TOOL_BUDGET_MS);
  } catch {
    return timedOut();
  }
}

function planInvocation(
  tool: ServeTool,
  cli: PublishedCli,
  args: unknown
): { argv: string[]; stdin?: string } | { error: string } {
  const parsed = readToolArguments(args ?? {});
  if (parsed.error) return { error: parsed.error };
  if (tool.kind === 'invoke') {
    if (!parsed.argv) return { error: 'argv is required' };
    return { argv: parsed.argv, ...(parsed.stdin !== undefined ? { stdin: parsed.stdin } : {}) };
  }
  const command = cli.commands.find((item) => item.path.join('_') === tool.commandPath.join('_'));
  if (!command) return { error: `unknown command ${tool.name}` };
  return argvForCommand(command, parsed);
}

function findTool(name: string): { tool: ServeTool; cli: PublishedCli } | null {
  if (!publication) return null;
  for (const cli of publication.clis) {
    const tool = buildTools(cli.name, cli.commands).find((item) => item.name === name);
    if (tool) return { tool, cli };
  }
  return null;
}

function consentResult(body: string, current: McpPublication): McpCallResult {
  const challenge = readChallenge(body);
  if (!challenge) return jsonResult(400, { error: 'bad consent request' });
  const tools: ConsentTool[] = current.clis.flatMap((cli) =>
    buildTools(cli.name, cli.commands).map((tool) => ({
      name: tool.name,
      description: tool.description,
      cli: cli.name,
    }))
  );
  log.info('mcp consent page served', { generation: challenge.generation, tools: tools.length });
  return {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: renderConsentPage({ ...challenge, tools }),
  };
}

function readChallenge(
  body: string
): { pendingId: string; generation: number; clientName: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pendingId = readString(value, 'pendingId');
  const clientName = readString(value, 'clientName') ?? 'MCP client';
  const generation = Object.getOwnPropertyDescriptor(value, 'generation')?.value;
  if (!pendingId || typeof generation !== 'number') return null;
  return { pendingId, generation, clientName };
}

async function republish(): Promise<void> {
  if (!publication) return;
  try {
    const minted = await requestPublish(publication.grantGeneration, 3_000);
    if (!publication || !textFs || !minted.url) return;
    if (minted.url !== publication.url || minted.token !== publication.token) {
      publication = { ...publication, url: minted.url, token: minted.token };
      await savePublication(textFs, publication);
    }
  } catch {}
}

function enqueue<T>(name: string, job: () => Promise<T>): Promise<T> {
  const previous = tails.get(name) ?? Promise.resolve();
  const run = previous.then(job, job);
  tails.set(
    name,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function jsonResult(status: number, payload: unknown): McpCallResult {
  return { status, contentType: JSON_TYPE, body: JSON.stringify(payload) };
}

function readString(value: object, key: string): string | undefined {
  const found = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof found === 'string' ? found : undefined;
}
