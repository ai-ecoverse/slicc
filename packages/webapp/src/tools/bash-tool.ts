/**
 * Bash tool — Execute shell commands via just-bash.
 *
 * Provides a single "bash" tool that runs commands and returns
 * stdout/stderr output. Uses AlmostBashShell's executeCommand() API,
 * which delegates to just-bash's Bash interpreter.
 */

import {
  formatSize,
  truncateTail,
} from '@earendil-works/pi-coding-agent/dist/core/tools/truncate.js';
import type { LickEvent } from '@slicc/shared-ts';
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

/**
 * Default `background_after`: how long the agent waits for a `bash` command
 * before the run is detached and the turn continues. A command that never
 * returns used to wedge the whole turn — merely annoying in the cone (the user
 * cancels), unrecoverable in a scoop, where there is no user to cancel and the
 * scoop's caller is blocked on it. Ten minutes is longer than any legitimate
 * interactive command and short enough that a stuck run does not eat the
 * session.
 */
export const DEFAULT_BASH_BACKGROUND_AFTER_SECONDS = 600;

/** Bytes of a backgrounded job's output carried inline in its completion lick. */
const BASH_LICK_PREVIEW_MAX_BYTES = 2 * 1024;

/**
 * Cap on bash output returned to the model. An unbounded tool result can
 * dominate the whole context window and wedge compaction — a single ~482K-token
 * Signal CDP dump did exactly that in production (#2010). We re-use
 * pi-coding-agent's own output-bounding contract (`truncateTail` + `formatSize`)
 * rather than reinventing it, so SLICC's browser bash tool stays converged with
 * pi's built-in bash tool. pi's *executor* can't be reused here (it spawns an OS
 * shell via `child_process`; SLICC runs `just-bash` over the VFS in the kernel
 * worker), but its `truncate` module is pure and browser-safe (#2009).
 */
const BASH_OUTPUT_MAX_BYTES = 40 * 1024;

/**
 * Budget for *accumulated* `<img:…>` markers carried past
 * {@link BASH_OUTPUT_MAX_BYTES}.
 *
 * Markers are exempt from the text cap — a tail truncation that cuts through
 * one destroys it, so the model gets the base64 tail and no image, and the
 * chat row loses the inline preview too (#2217). Accumulation still needs a
 * bound: `open --view --size medium` is ~270 KB, and a loop over a directory
 * of screenshots would otherwise dwarf the text cap it bypassed. Newest
 * markers win, matching the tail-keeping convention for text.
 *
 * This is NOT a per-image ceiling. The newest marker is always kept, however
 * large — a single `open --view --size high` on a photo can exceed 1MB on its
 * own, and dropping it would just relocate #2217's failure. The real ceiling
 * for one image is `processImageContent`'s 5MB API limit.
 */
const BASH_IMAGE_MARKER_MAX_BYTES = 1024 * 1024;

/** NUL-delimited stand-in for a lifted marker: never present in real output. */
const IMAGE_PLACEHOLDER_PREFIX = '\u0000slicc-img:';
const IMAGE_PLACEHOLDER_SUFFIX = '\u0000';

/**
 * Replace well-formed image markers in `output` with short placeholders, so
 * the base64 is neither measured against the text cap nor cut in half by it,
 * and drop the oldest markers over {@link BASH_IMAGE_MARKER_MAX_BYTES}.
 *
 * Only markers the vision path can actually use are lifted. A marker-shaped
 * run of prose, or a marker already sliced by an upstream `head`, stays in the
 * text, where it is inert and where the byte cap may legitimately trim it.
 *
 * Placeholders keep each image at its original position, so the label a
 * command printed above its image still precedes it after bounding.
 */
function liftImageMarkers(output: string): { text: string; markers: Map<string, string> } {
  const found = classifyImageMarkers(output).filter((m) => m.kind === 'image');
  if (found.length === 0) return { text: output, markers: new Map() };

  // Walk newest-first so the byte budget keeps the tail of the image stream,
  // matching the tail-keeping convention for text. The newest marker is kept
  // unconditionally: one deliberately-requested `open --view --size high` can
  // exceed the budget by itself, and dropping it would just relocate the bug
  // this budget sits next to. `processImageContent`'s 5MB API limit is the
  // real ceiling for a single image; this budget only bounds *accumulation*.
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

/**
 * Replace usable image markers with `[image]`. For text destinations that can
 * never carry a picture — the paging file, a backgrounded job's lick preview —
 * where the base64 would just be noise the reader has to scroll past.
 */
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

/** Render placeholders as `[image]` for the plain-text paging file. */
function stripImagePlaceholders(text: string): string {
  return text.replaceAll(
    new RegExp(`${IMAGE_PLACEHOLDER_PREFIX}\\d+${IMAGE_PLACEHOLDER_SUFFIX}`, 'g'),
    '[image]'
  );
}

/**
 * Put lifted markers back where their placeholders survived bounding. A
 * placeholder the tail cut away takes its image with it — the text that
 * introduced it is gone too, and the truncation footer already says so.
 */
function restoreImageMarkers(text: string, markers: Map<string, string>): string {
  if (markers.size === 0) return text;
  let restored = text;
  for (const [key, marker] of markers) {
    if (restored.includes(key)) restored = restored.replace(key, () => marker);
  }
  return restored;
}

/**
 * Bound bash output to {@link BASH_OUTPUT_MAX_BYTES}, keeping the TAIL (errors and
 * final results live at the end), matching pi's bash convention. When truncated,
 * the full output is written to a temp file under `tempDir` and a footer tells
 * the model exactly what was dropped and how to page the rest.
 *
 * `tempDir` MUST be writable AND readable in the caller's context, and unique to
 * it: the cone uses `/tmp`, but a scoop's sandbox exposes only `/scoops/<folder>/`
 * and `/shared/`, so `/tmp` there is neither writable (RestrictedFS rejects it,
 * or sudo prompts) nor readable by the follow-up `sed`/`tail`. A per-context
 * `tempDir` also means two parallel scoops never collide on the same filename
 * (they write into their own folders). If the temp write still fails, degrade to
 * a re-run hint.
 */
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

const SEARCH_COMMAND_PREFIX =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(?:command\s+)?(?:grep|egrep|fgrep|rg)\b/;

/**
 * Split a command line into its top-level segments, honoring quotes and
 * escapes. Segments are separated by `;`, `|`, `&&`, and `||`; a lone `&`
 * (background) is not treated as a separator. Raw (untrimmed) segments are
 * returned, including any empty trailing segment after a final separator.
 *
 * Shared by `getLastCommandSegment` (search-output heuristic) and the
 * command-level sudo guard, which matches each non-empty segment against the
 * `Cmnd` policy.
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const flush = () => {
    segments.push(current);
    current = '';
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      current += char;
      quote = char;
      continue;
    }

    if ((char === '&' || char === '|') && command[i + 1] === char) {
      flush();
      i++;
      continue;
    }

    if (char === ';' || char === '|') {
      flush();
      continue;
    }

    current += char;
  }

  flush();
  return segments;
}

function getLastCommandSegment(command: string): string {
  const segments = splitCommandSegments(command);
  return (segments[segments.length - 1] ?? '').trim();
}

function isExpectedNoMatchSearch(command: string, exitCode: number, stderr: string): boolean {
  if (exitCode !== 1 || stderr.trim()) return false;
  return SEARCH_COMMAND_PREFIX.test(getLastCommandSegment(command));
}

/**
 * The `bash` tool's own argument bag — its `inputSchema` above is the contract.
 * Every value arrives from the model, so each is validated here rather than
 * trusted (`command` is the one required field; the two budgets are optional
 * numbers whose invalid values fall back to the context default).
 */
export interface BashToolInput {
  command?: unknown;
  timeout?: unknown;
  background_after?: unknown;
}

/** Shell result shape shared by the foreground and background paths. */
interface ShellRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Terminal state of a shell run, normalized so neither race branch rejects. */
type SettledRun = { ok: true; result: ShellRunResult } | { ok: false; error: string };

/** Options accepted by {@link createBashTool}. */
export interface BashToolOptions {
  /**
   * Seconds the agent waits before a still-running command is detached to the
   * background. Defaults to {@link DEFAULT_BASH_BACKGROUND_AFTER_SECONDS}; a
   * per-call `background_after` argument overrides it. `0` detaches
   * immediately. Set by `ScoopContext` from `ScoopConfig.backgroundAfterSeconds`
   * so a spawned scoop can be given a tighter (or looser) budget than the cone.
   */
  defaultBackgroundAfterSeconds?: number;
  /**
   * Emit the completion lick for a detached job. `ScoopContext` wires this to
   * the orchestrator's lick handler; when absent (tests, contexts without a
   * lick manager) a job still detaches and still writes its output file — only
   * the notification is dropped, with a warning.
   */
  fireLick?: (event: LickEvent) => void;
  /**
   * Scoop this tool belongs to, as `LickEvent.targetScoop` — the lick is routed
   * back to the scoop that spawned the run. `undefined` for the cone (untargeted
   * licks route to the cone by default).
   */
  targetScoop?: string;
  /**
   * Registers each invocation as a kernel process. Without it a run is invisible
   * to `ps`, unreachable by `kill`, and — the reason this exists — a `timeout`
   * cannot do more than ask just-bash to stop at its next statement boundary,
   * which never interrupts a realm-backed `node` / `python3` command.
   */
  jobHost?: BashJobHost;
  /**
   * Secret scrubber for a DETACHED job's output.
   *
   * A foreground result is scrubbed for free at the `adaptTools` boundary
   * (`core/tool-adapter.ts`), but a detached job's output reaches the agent as a
   * lick preview and a file on disk, neither of which crosses that boundary — so
   * the same real→masked pass is applied here instead. Wired by `ScoopContext`
   * from `getToolResultScrubber()`; absent (tests, floats with no pipeline) means
   * no scrub, matching the identity scrubber that surface already returns.
   */
  scrubOutput?: (text: string) => Promise<string>;
}

/**
 * Per-instance wiring the module-level run helpers need. Passed explicitly
 * rather than closed over so the orchestration below stays testable and
 * `createBashTool` stays thin.
 */
interface BashRunContext {
  shell: AlmostBashShellHeadless;
  fs: VirtualFS;
  tempDir: string;
  options: BashToolOptions;
  defaultBackgroundAfter: number;
  nextOutputSeq: () => number;
  nextJobId: () => string;
}

/** A started run: its kernel process, its cancel handle, and its outcome. */
interface StartedRun {
  job: BashJobProcess | null;
  controller: AbortController;
  settled: Promise<SettledRun>;
  /** Drops the TURN's abort listener (kept out of `finally` on the detach path). */
  releaseTurnSignal: () => void;
  /**
   * Raw stdout/stderr accumulated from each registry-dispatched command as it
   * settles (#2415). Survives a timeout kill that just-bash reports as an
   * empty abort result.
   */
  getTeedOutput: () => string;
  /**
   * Begin rewriting the durable output path with scrubbed teed content on each
   * new chunk. Called once from {@link detachRun}.
   */
  startPersisting: (outputPath: string, jobId: string) => void;
  /** Wait for any in-flight persist writes before a final settle write. */
  flushPersist: () => Promise<void>;
  /** Set when {@link hardKill} fires for a detached job's timeout ceiling. */
  killedByTimeout: boolean;
}

/** Read an optional non-negative number argument; invalid values are ignored. */
function readSeconds(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * Tool description. Built per instance because the detach budget is per context
 * (a scoop may run with a tighter one) and the model needs the real number.
 */
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

/** Input schema; also per instance, for the same reason as the description. */
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

/** Result text for a run killed at its hard ceiling. */
function timeoutResult(waitSeconds: number): ToolResult {
  return {
    content:
      `Command timed out after ${waitSeconds}s and was killed; no output was captured. Re-run it ` +
      'with a larger timeout, a larger background_after so it detaches instead of dying, or narrow ' +
      'the command so it finishes sooner.',
    isError: true,
  };
}

/**
 * Start a run: register it as a kernel process, funnel every cancel source into
 * one controller, and hand back its (never-rejecting) outcome.
 *
 * Two cancel sources reach the run, and they have different lifetimes:
 *  - The TURN's signal — the `kind:'tool'` record the tool adapter spawned.
 *    Dropped when a run detaches, because a detached job outlives the turn.
 *  - The JOB pid's own signal — `kill <pid>` from any shell plus the fan-out a
 *    turn cancel / `drop_scoop` sends down the ppid tree. Kept for the whole
 *    run, detached included: this is what makes a background job killable.
 */
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

  // Incremental tee (#2415): each registry-dispatched command's stdout/stderr
  // is appended here as it settles. just-bash's abort settlement discards
  // accumulated output (exit 124 + "bash: execution aborted"), so this buffer
  // is what a killed detached job still has to show.
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

  // Never rejects: both branches of the race read this, and an unobserved
  // rejection from a detached run would surface as an unhandled rejection in
  // the kernel worker.
  //
  // `job.pid` is the third argument for a reason: the shell stamps it as the
  // parent of any realm-backed command this run spawns, so the realm worker is
  // a descendant of THIS job rather than of the whole turn. That is what makes
  // the SIGKILL below reach it.
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

/**
 * Hard-kill a run. SIGKILL on the job pid fans out over the ppid tree, and the
 * realm runner turns that into a synchronous `worker.terminate()` — the only
 * uncatchable stop for a CPU-tight `node -e 'while(true){}'`. The cooperative
 * abort is still raised for the in-worker just-bash path, which has no worker to
 * terminate and can only stop at a statement boundary.
 */
function hardKill(run: StartedRun, reason?: 'timeout'): void {
  if (reason === 'timeout') run.killedByTimeout = true;
  run.job?.kill();
  run.controller.abort();
  run.job?.exit(null);
}

/**
 * Reap the job record on completion. A job that was SIGNALLED passes `null` so
 * the manager derives the conventional signal exit code (130 / 137), matching
 * what the tool adapter does for tool pids. The test is the JOB's signal, not the
 * combined controller: a cancelled turn aborts the run without ever signalling
 * the job pid, and that should record the interrupted command's own code rather
 * than a "clean exit" the manager would derive from an absent signal.
 */
function finishJob(run: StartedRun, exitCode: number): void {
  run.job?.exit(run.job.signal.aborted ? null : exitCode);
}

/**
 * Result text for a detached run. States plainly that the turn is not blocked
 * and that re-running is wrong, because "still running" otherwise reads to a
 * model as a failure worth retrying.
 */
function detachedResult(
  jobId: string,
  pid: number | undefined,
  waitSeconds: number,
  outputPath: string,
  timeoutSeconds: number | undefined
): ToolResult {
  const killNote =
    timeoutSeconds === undefined ? '' : ` Its ${timeoutSeconds}s timeout still applies.`;
  // The pid is the whole point of registering the job: without naming it here
  // the model has a job id it cannot act on.
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

/**
 * Create the bash tool bound to a AlmostBashShell instance. `fs` (ungated — NOT
 * the sudo-wrapped handle) backs the temp-file paging for truncated output and
 * the durable output file of a detached job, and `tempDir` is the context's
 * writable+readable temp directory (`/tmp` for the cone, `/scoops/<folder>` for
 * a scoop). See {@link boundBashOutput}.
 */
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

/**
 * Persist a detached job's full (untruncated) output and announce it as a `bash`
 * lick carrying a bounded preview. Runs long after the tool call returned, so
 * every failure is contained here: a lost output file must not cost the agent
 * its completion notification.
 */
/**
 * Apply the configured secret scrub to a detached job's output.
 *
 * A throwing scrubber must not cost the agent its completion notification, but
 * it must not leak either: on failure the output is replaced wholesale rather
 * than passed through. (The scrubbers built by `getToolResultScrubber()` already
 * degrade internally — this covers the unexpected throw.)
 */
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

/**
 * True when just-bash settled as a cooperatively aborted run (timeout / signal
 * abort inside the interpreter). just-bash 3.4.x returns
 * `{ exitCode: 124, stderr: "bash: execution aborted\n", stdout: "" }` and
 * drops any prior output — the tee is what recovers it.
 *
 * Match the abort *message*, not bare exit 124: a successful `timeout(1)` /
 * other command that exits 124 must keep its real output and must not get a
 * kill trailer. A generic thrown `"aborted"` (external `kill <pid>`) is NOT
 * this path — that is handled below with optional teed prefix.
 */
function isJustBashExecutionAbort(settled: SettledRun): boolean {
  if (!settled.ok) return /execution aborted/i.test(settled.error);
  return /execution aborted/i.test(settled.result.stderr);
}

/** Trailer appended to a killed detached job's durable output (#2415). */
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
    // Prefer the incremental tee over just-bash's empty abort settlement —
    // that is the whole point of #2415.
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
    // Thrown error (e.g. external `kill <pid>` → "aborted"): keep any teed
    // output ahead of the error string so a mid-flight kill is not silent.
    const teed = run.getTeedOutput();
    exitCode = 1;
    if (teed) {
      const body = teed.endsWith('\n') ? teed : `${teed}\n`;
      raw = `${body}Shell error: ${settled.error}`;
    } else {
      raw = `Shell error: ${settled.error}`;
    }
  }
  // Scrub BEFORE the write, so the persisted file the agent is told to `cat` is
  // masked too — a `preview`-only scrub would just move the leak to disk.
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
  // The preview is a text teaser, not a vision channel: 2KB of a marker's
  // base64 is unreadable and would crowd out the lines that matter (#2217).
  // The persisted output file still holds the marker for a follow-up read.
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

/**
 * Stop waiting on a still-running command and let it finish on its own pid.
 *
 * The job record stays `running`, so `ps` lists the background job and `kill`
 * reaches it; only the agent's wait ends here. A `timeout` above the detach
 * point keeps applying — its remaining budget becomes a hard kill against the
 * detached job.
 */
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
  // Start teeing to disk immediately so a kill before the next command settles
  // still leaves whatever already landed in the buffer.
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

/** Format a completed run's output for the model. */
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
      result.exitCode !== 0 && !isExpectedNoMatchSearch(command, result.exitCode, result.stderr),
  };
}

/**
 * Run one `bash` invocation: wait up to the smaller of its two budgets, then
 * either hard-kill it (`timeout` wins) or detach it (`background_after` wins).
 */
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

  // A timeout at or below the detach point pre-empts detaching entirely; above
  // it, the command detaches first and the ceiling keeps applying to the
  // detached job (that is what makes `timeout` a kill and not a "stop waiting").
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
    // Dropped on every path, detach included: a detached job intentionally
    // outlives the turn, so it must not be aborted by the turn's signal. Its
    // own pid stays signal-reachable — that is the supported way to stop it.
    run.releaseTurnSignal();
  }
}
