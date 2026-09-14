import {
  formatSize,
  truncateTail,
} from '@earendil-works/pi-coding-agent/dist/core/tools/truncate.js';
import type { LickEvent } from '@slicc/shared-ts';
import type { ScriptNode, WordNode } from 'just-bash';
import { classifyImageMarkers } from '../base/image-markers.js';
import { createLogger } from '../base/logger.js';
import type { VirtualFS } from '../fs/index.js';
import type { AlmostBashShellHeadless } from '../shell/almost-bash-shell-headless.js';
import type {
  BashJobHost,
  BashJobProcess,
  ToolDefinition,
  ToolInputSchema,
  ToolResult,
} from './types.js';

const log = createLogger('tool:bash');

export const DEFAULT_BASH_BACKGROUND_AFTER_SECONDS = 600;

const BASH_LICK_PREVIEW_MAX_BYTES = 2 * 1024;

const BASH_OUTPUT_MAX_BYTES = 40 * 1024;

const BASH_IMAGE_MARKER_MAX_BYTES = 1024 * 1024;

const IMAGE_PLACEHOLDER_PREFIX = '\u0000slicc-img:';
const IMAGE_PLACEHOLDER_SUFFIX = '\u0000';

function liftImageMarkers(output: string): { text: string; markers: Map<string, string> } {
  const found = classifyImageMarkers(output).filter((m) => m.kind === 'image');
  if (found.length === 0) return { text: output, markers: new Map() };

  const keptIndices = new Set<number>();
  let budget = BASH_IMAGE_MARKER_MAX_BYTES;
  for (let i = found.length - 1; i >= 0; i--) {
    const size = found[i].marker.length;
    if (size > budget && keptIndices.size > 0) break;
    budget -= size;
    keptIndices.add(i);
  }

  const markers = new Map<string, string>();
  let text = '';
  let lastIndex = 0;
  found.forEach((m, i) => {
    text += output.slice(lastIndex, m.index);
    if (keptIndices.has(i)) {
      const key = `${IMAGE_PLACEHOLDER_PREFIX}${i}${IMAGE_PLACEHOLDER_SUFFIX}`;
      markers.set(key, m.marker);
      text += key;
    } else {
      text += `[image dropped: a newer image in this command used up the ${
        BASH_IMAGE_MARKER_MAX_BYTES / 1024
      }KB image budget. View it on its own to see it.]`;
    }
    lastIndex = m.index + m.marker.length;
  });
  text += output.slice(lastIndex);
  return { text, markers };
}

function replaceImageMarkers(text: string): string {
  const found = classifyImageMarkers(text).filter((m) => m.kind === 'image');
  if (found.length === 0) return text;
  let out = '';
  let lastIndex = 0;
  for (const m of found) {
    out += `${text.slice(lastIndex, m.index)}[image]`;
    lastIndex = m.index + m.marker.length;
  }
  return out + text.slice(lastIndex);
}

function stripImagePlaceholders(text: string): string {
  return text.replaceAll(
    new RegExp(`${IMAGE_PLACEHOLDER_PREFIX}\\d+${IMAGE_PLACEHOLDER_SUFFIX}`, 'g'),
    '[image]'
  );
}

function restoreImageMarkers(text: string, markers: Map<string, string>): string {
  if (markers.size === 0) return text;
  let restored = text;
  for (const [key, marker] of markers) {
    if (restored.includes(key)) restored = restored.replace(key, () => marker);
  }
  return restored;
}

async function boundBashOutput(
  output: string,
  fs: VirtualFS,
  tempDir: string,
  nextSeq: () => number
): Promise<string> {
  const { text, markers } = liftImageMarkers(output);
  const truncation = truncateTail(text, { maxBytes: BASH_OUTPUT_MAX_BYTES });
  if (!truncation.truncated) return restoreImageMarkers(text, markers);

  const shown = `showing the last ${formatSize(truncation.outputBytes)} of ${formatSize(
    truncation.totalBytes
  )} (${truncation.totalLines} lines)`;
  const path = `${tempDir}/bash-output-${nextSeq()}.txt`;
  try {
    await fs.writeFile(path, stripImagePlaceholders(text));
    return restoreImageMarkers(
      `${truncation.content}\n\n[Output truncated: ${shown}. Full output written to ${path} — ` +
        `read specific ranges with \`sed -n 'START,ENDp' ${path}\`, \`tail -n +N ${path}\`, or \`grep\`.]`,
      markers
    );
  } catch (err) {
    log.warn('Failed to persist full bash output', {
      error: err instanceof Error ? err.message : String(err),
    });
    return restoreImageMarkers(
      `${truncation.content}\n\n[Output truncated: ${shown}. Re-run piping through ` +
        '`head`/`tail`/`grep`/`sed -n` to narrow the output.]',
      markers
    );
  }
}

const SEARCH_COMMANDS = new Set(['grep', 'egrep', 'fgrep', 'rg']);

function literalWordText(word: WordNode): string | null {
  let out = '';
  for (const part of word.parts) {
    switch (part.type) {
      case 'Literal':
      case 'SingleQuoted':
      case 'Escaped':
        out += part.value;
        break;
      case 'DoubleQuoted': {
        for (const p of part.parts) {
          if (p.type !== 'Literal' && p.type !== 'Escaped') return null;
          out += p.value;
        }
        break;
      }
      default:
        return null;
    }
  }
  return out;
}

function lastCommandName(ast: ScriptNode): string | null {
  const stmt = ast.statements[ast.statements.length - 1];
  const pipeline = stmt?.pipelines[stmt.pipelines.length - 1];
  if (!pipeline || pipeline.negated) return null;
  const cmd = pipeline.commands[pipeline.commands.length - 1];
  if (cmd?.type !== 'SimpleCommand' || !cmd.name) return null;
  const name = literalWordText(cmd.name);
  if (name !== 'command') return name;
  const target = cmd.args[0];
  return target ? literalWordText(target) : null;
}

export function isExpectedNoMatchSearch(
  shell: AlmostBashShellHeadless,
  command: string,
  exitCode: number,
  stderr: string
): boolean {
  if (exitCode !== 1 || stderr.trim()) return false;
  let name: string | null;
  try {
    name = lastCommandName(shell.getBash().transform(command).ast);
  } catch {
    return false;
  }
  return name !== null && SEARCH_COMMANDS.has(name);
}

export interface BashToolInput {
  command?: unknown;
  timeout?: unknown;
  background_after?: unknown;
}

interface ShellRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type SettledRun = { ok: true; result: ShellRunResult } | { ok: false; error: string };

export interface BashToolOptions {
  defaultBackgroundAfterSeconds?: number;

  fireLick?: (event: LickEvent) => void;

  targetScoop?: string;

  jobHost?: BashJobHost;

  scrubOutput?: (text: string) => Promise<string>;
}

interface BashRunContext {
  shell: AlmostBashShellHeadless;
  fs: VirtualFS;
  tempDir: string;
  options: BashToolOptions;
  defaultBackgroundAfter: number;
  nextOutputSeq: () => number;
  nextJobId: () => string;
}

interface StartedRun {
  job: BashJobProcess | null;
  controller: AbortController;
  settled: Promise<SettledRun>;

  releaseTurnSignal: () => void;

  getTeedOutput: () => string;

  startPersisting: (outputPath: string, jobId: string) => void;

  flushPersist: () => Promise<void>;

  killedByTimeout: boolean;
}

function readSeconds(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function buildDescription(defaultBackgroundAfter: number): string {
  return (
    'Execute a bash command. Full shell with pipes, redirects, chaining, control flow. ' +
    'Includes: grep, rg, sed, awk, jq, find, curl, git, node, python3, sqlite3, ' +
    'open (--view for vision), playwright-cli (browser automation). Run `commands` for full list. ' +
    `Output is capped at ${BASH_OUTPUT_MAX_BYTES / 1024}KB (the tail is kept); when truncated the ` +
    'full output is written to a temp file named in the result so you can page it. ' +
    `Inline images (\`open --view\`) do not count against that cap — up to ${
      BASH_IMAGE_MARKER_MAX_BYTES / 1024
    }KB of images per command reaches you as pictures, not base64. ` +
    `A command still running after background_after seconds (default ${defaultBackgroundAfter}) is ` +
    'detached: you get a job id at once and a Background Command lick delivers its exit code and ' +
    'output later, so a stuck command never wedges the turn.'
  );
}

function buildInputSchema(defaultBackgroundAfter: number): ToolInputSchema {
  return {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to execute.',
      },
      timeout: {
        type: 'number',
        description:
          'Hard ceiling in seconds: the command is killed and this call returns an error — no ' +
          'job, no lick. Omit for no ceiling (the default), which detaches a slow command ' +
          'instead of killing it.',
      },
      background_after: {
        type: 'number',
        description:
          `Seconds to wait before detaching the command. Defaults to ${defaultBackgroundAfter}. ` +
          'Use 0 to detach immediately (dev servers, watchers), or a large value when you must ' +
          'have the output in this turn. A smaller timeout wins: the command is killed, not detached.',
      },
    },
    required: ['command'],
  };
}

function timeoutResult(waitSeconds: number): ToolResult {
  return {
    content:
      `Command timed out after ${waitSeconds}s and was killed; no output was captured. Re-run it ` +
      'with a larger timeout, a larger background_after so it detaches instead of dying, or narrow ' +
      'the command so it finishes sooner.',
    isError: true,
  };
}

function startRun(
  ctx: BashRunContext,
  command: string,
  turnSignal: AbortSignal | undefined
): StartedRun {
  const controller = new AbortController();
  const job = ctx.options.jobHost?.spawn(command) ?? null;

  const onTurnAbort = () => controller.abort();
  if (turnSignal?.aborted) controller.abort();
  else turnSignal?.addEventListener('abort', onTurnAbort, { once: true });

  if (job) {
    if (job.signal.aborted) controller.abort();
    else job.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const teedChunks: string[] = [];
  let persistPath: string | undefined;
  let persistJobId: string | undefined;
  let persistChain: Promise<void> = Promise.resolve();

  const persistTeed = (): void => {
    if (persistPath === undefined || persistJobId === undefined) return;
    const path = persistPath;
    const jobId = persistJobId;
    const raw = teedChunks.join('');
    persistChain = persistChain
      .then(async () => {
        const scrubbed = await scrubJobOutput(ctx, jobId, raw);
        await ctx.fs.writeFile(path, scrubbed);
      })
      .catch((err) =>
        log.warn('Failed to tee background bash output', {
          jobId,
          outputPath: path,
          error: err instanceof Error ? err.message : String(err),
        })
      );
  };

  const settled: Promise<SettledRun> = ctx.shell
    .executeCommand(command, controller.signal, job?.pid, undefined, {
      onOutput: (chunk) => {
        teedChunks.push(chunk);
        persistTeed();
      },
    })
    .then(
      (result) => ({ ok: true, result }) as SettledRun,
      (err) =>
        ({ ok: false, error: err instanceof Error ? err.message : String(err) }) as SettledRun
    );

  return {
    job,
    controller,
    settled,
    releaseTurnSignal: () => turnSignal?.removeEventListener('abort', onTurnAbort),
    getTeedOutput: () => teedChunks.join(''),
    startPersisting: (outputPath, jobId) => {
      persistPath = outputPath;
      persistJobId = jobId;
      persistTeed();
    },
    flushPersist: () => persistChain,
    killedByTimeout: false,
  };
}

function hardKill(run: StartedRun, reason?: 'timeout'): void {
  if (reason === 'timeout') run.killedByTimeout = true;
  run.job?.kill();
  run.controller.abort();
  run.job?.exit(null);
}

function finishJob(run: StartedRun, exitCode: number): void {
  run.job?.exit(run.job.signal.aborted ? null : exitCode);
}

function detachedResult(
  jobId: string,
  pid: number | undefined,
  waitSeconds: number,
  outputPath: string,
  timeoutSeconds: number | undefined
): ToolResult {
  const killNote =
    timeoutSeconds === undefined ? '' : ` Its ${timeoutSeconds}s timeout still applies.`;

  const pidNote =
    pid === undefined ? '' : ` Pid ${pid}: \`ps\` lists it, \`kill ${pid}\` stops it.`;
  return {
    content:
      `Still running after ${waitSeconds}s — detached as background job ${jobId}. ` +
      'This turn is NOT blocked on it: continue with other work, and do not re-run the command. ' +
      'A "Background Command" lick will arrive with the exit code and a preview once it finishes, ' +
      `and its full output is being written to ${outputPath} as it runs.${pidNote}${killNote}`,
  };
}

export function createBashTool(
  shell: AlmostBashShellHeadless,
  fs: VirtualFS,
  tempDir: string,
  options: BashToolOptions = {}
): ToolDefinition {
  let outputSeq = 0;
  let jobSeq = 0;
  const ctx: BashRunContext = {
    shell,
    fs,
    tempDir,
    options,
    defaultBackgroundAfter:
      readSeconds(options.defaultBackgroundAfterSeconds) ?? DEFAULT_BASH_BACKGROUND_AFTER_SECONDS,
    nextOutputSeq: () => (outputSeq += 1),
    nextJobId: () => `bg-${(jobSeq += 1)}`,
  };

  return {
    name: 'bash',
    description: buildDescription(ctx.defaultBackgroundAfter),
    inputSchema: buildInputSchema(ctx.defaultBackgroundAfter),
    execute: (input: BashToolInput, signal?: AbortSignal) => runBashCommand(ctx, input, signal),
  };
}

async function scrubJobOutput(ctx: BashRunContext, jobId: string, output: string): Promise<string> {
  const scrub = ctx.options.scrubOutput;
  if (!scrub || !output) return output;
  try {
    return await scrub(output);
  } catch (err) {
    log.warn('Background bash output scrub failed; withholding output', {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
    return '[output withheld: secret scrub unavailable]';
  }
}

function isJustBashExecutionAbort(settled: SettledRun): boolean {
  if (!settled.ok) return /execution aborted/i.test(settled.error);
  return settled.result.exitCode === 124 && /execution aborted/i.test(settled.result.stderr);
}

function killTrailer(timeoutSeconds: number | undefined, exitCode: number): string {
  if (timeoutSeconds === undefined) {
    return `--- killed (exit ${exitCode}) ---\n`;
  }
  return `--- killed after ${timeoutSeconds}s (exit ${exitCode}) ---\n`;
}

async function deliverBackgroundJob(
  ctx: BashRunContext,
  jobId: string,
  pid: number | undefined,
  command: string,
  outputPath: string,
  settled: SettledRun,
  run: StartedRun,
  timeoutSeconds: number | undefined
): Promise<void> {
  await run.flushPersist();

  const timeoutAbort = run.killedByTimeout || isJustBashExecutionAbort(settled);
  let raw: string;
  let exitCode: number;
  if (timeoutAbort) {
    const teed = run.getTeedOutput();
    exitCode = 124;
    const body = teed.endsWith('\n') || teed.length === 0 ? teed : `${teed}\n`;
    raw = `${body}${killTrailer(timeoutSeconds, exitCode)}`;
  } else if (settled.ok) {
    raw =
      [settled.result.stdout, settled.result.stderr].filter(Boolean).join('') ||
      `(exit code: ${settled.result.exitCode})`;
    exitCode = settled.result.exitCode;
  } else {
    const teed = run.getTeedOutput();
    exitCode = 1;
    if (teed) {
      const body = teed.endsWith('\n') ? teed : `${teed}\n`;
      raw = `${body}Shell error: ${settled.error}`;
    } else {
      raw = `Shell error: ${settled.error}`;
    }
  }

  const output = await scrubJobOutput(ctx, jobId, raw);

  let persistedPath: string | undefined;
  try {
    await ctx.fs.writeFile(outputPath, output);
    persistedPath = outputPath;
  } catch (err) {
    log.warn('Failed to persist background bash output', {
      jobId,
      outputPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!ctx.options.fireLick) {
    log.warn('Background bash job finished with no lick sink', { jobId, exitCode });
    return;
  }

  const preview = truncateTail(replaceImageMarkers(output), {
    maxBytes: BASH_LICK_PREVIEW_MAX_BYTES,
  });
  ctx.options.fireLick({
    type: 'bash',
    bashJobId: jobId,
    bashCommand: command,
    bashExitCode: exitCode,
    ...(pid !== undefined ? { bashJobPid: pid } : {}),
    resultPath: persistedPath,
    preview: preview.content,
    ...(ctx.options.targetScoop ? { targetScoop: ctx.options.targetScoop } : {}),
    timestamp: new Date().toISOString(),
    body: { jobId, pid: pid ?? null, command, exitCode, resultPath: persistedPath ?? null },
  });
}

function detachRun(
  ctx: BashRunContext,
  run: StartedRun,
  command: string,
  waitSeconds: number,
  timeoutSeconds: number | undefined,
  backgroundAfter: number
): ToolResult {
  const jobId = ctx.nextJobId();
  const pid = run.job?.pid;
  const outputPath = `${ctx.tempDir}/bash-${jobId}.txt`;

  run.startPersisting(outputPath, jobId);
  const killAfter = timeoutSeconds === undefined ? undefined : timeoutSeconds - backgroundAfter;
  const killTimer =
    killAfter === undefined
      ? undefined
      : setTimeout(() => hardKill(run, 'timeout'), killAfter * 1000);

  void run.settled
    .then((settled) => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      const exitCode = run.killedByTimeout ? 124 : settled.ok ? settled.result.exitCode : 1;
      finishJob(run, exitCode);
      return deliverBackgroundJob(
        ctx,
        jobId,
        pid,
        command,
        outputPath,
        settled,
        run,
        timeoutSeconds
      );
    })
    .catch((err) => log.error('Background bash delivery failed', { jobId, error: err }));

  log.info('Bash command detached to background', { command, jobId, pid, killAfter });
  return detachedResult(jobId, pid, waitSeconds, outputPath, timeoutSeconds);
}

async function foregroundResult(
  ctx: BashRunContext,
  command: string,
  result: ShellRunResult
): Promise<ToolResult> {
  log.debug('Result', {
    exitCode: result.exitCode,
    stdoutLength: result.stdout.length,
    stderrLength: result.stderr.length,
  });

  let output = '';
  if (result.stdout) output += result.stdout;
  if (result.stderr) output += result.stderr;
  if (!output) output = `(exit code: ${result.exitCode})`;

  return {
    content: await boundBashOutput(output, ctx.fs, ctx.tempDir, ctx.nextOutputSeq),
    isError:
      result.exitCode !== 0 &&
      !isExpectedNoMatchSearch(ctx.shell, command, result.exitCode, result.stderr),
  };
}

async function runBashCommand(
  ctx: BashRunContext,
  input: BashToolInput,
  turnSignal?: AbortSignal
): Promise<ToolResult> {
  const command = input.command as string;
  const timeoutSeconds = readSeconds(input.timeout);
  const backgroundAfter = readSeconds(input.background_after) ?? ctx.defaultBackgroundAfter;
  log.debug('Execute', { command, timeoutSeconds, backgroundAfter });

  const run = startRun(ctx, command, turnSignal);

  const timeoutFirst = timeoutSeconds !== undefined && timeoutSeconds <= backgroundAfter;
  const waitSeconds = timeoutFirst ? (timeoutSeconds as number) : backgroundAfter;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed: Promise<'elapsed'> = new Promise((resolve) => {
    timer = setTimeout(() => resolve('elapsed'), waitSeconds * 1000);
  });

  try {
    const outcome = await Promise.race([run.settled, elapsed]);

    if (outcome === 'elapsed' && timeoutFirst) {
      hardKill(run, 'timeout');
      log.warn('Bash command timed out', {
        command,
        timeoutSeconds: waitSeconds,
        pid: run.job?.pid,
      });
      return timeoutResult(waitSeconds);
    }

    if (outcome === 'elapsed') {
      return detachRun(ctx, run, command, waitSeconds, timeoutSeconds, backgroundAfter);
    }

    finishJob(run, outcome.ok ? outcome.result.exitCode : 1);

    if (!outcome.ok) {
      log.error('Error', { command, error: outcome.error });
      return { content: `Shell error: ${outcome.error}`, isError: true };
    }
    return await foregroundResult(ctx, command, outcome.result);
  } finally {
    if (timer !== undefined) clearTimeout(timer);

    run.releaseTurnSignal();
  }
}
