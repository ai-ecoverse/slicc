/**
 * `ffprobe` shell command — media introspection backed by the same
 * `@ffmpeg/core` wasm instance that powers `ffmpeg`.
 *
 * `@ffmpeg/core` 0.12.x ships the ffmpeg entry point only; there is no
 * separate ffprobe wasm / ipk artifact for this pin. We therefore
 * emulate by staging the input into MEMFS, running
 * `ffmpeg -hide_banner -i <file>` (which exits non-zero with "At least
 * one output file must be specified" after printing the Input #N
 * banner), and parsing that banner into structured fields.
 *
 * This is an honest subset: duration, container/format name, and
 * per-stream codec/type/sample rate/channels/resolution/fps. Flags we
 * cannot honour are rejected by name rather than silently dropped.
 */

import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { readInputBlob } from '../ffmpeg/input-blob.js';
import { mountStagedInputs, newStage, stagedPath, unmountStagedInputs } from '../ffmpeg/staging.js';
import { createIpkContextFromCtx } from '../ffmpeg-command.js';
import {
  describeFfmpegCore,
  ffmpegCoreNotInstalledMessage,
  getFfmpeg,
  isCoreFault,
  recycleFfmpeg,
  tryLoadFfmpegCoreFromNodeModules,
} from '../ffmpeg-wasm.js';
import {
  type ProbeFormat,
  type ProbeInfo,
  type ProbeStream,
  parseFfmpegProbeLog,
} from './log-parse.js';

type CmdResult = { stdout: string; stderr: string; exitCode: number };

type OutputFormat =
  | { kind: 'json' }
  | { kind: 'csv'; printSection: boolean }
  | { kind: 'default'; noWrappers: boolean; noKey: boolean };

interface ShowEntries {
  format?: Set<string>;
  stream?: Set<string>;
}

interface ParsedFfprobeArgs {
  inputPath: string | null;
  showFormat: boolean;
  showStreams: boolean;
  showEntries: ShowEntries | null;
  selectStreams: string | null;
  outputFormat: OutputFormat;
  /** Quiet enough that ffmpeg progress noise stays off stdout. */
  quiet: boolean;
  /**
   * True when the user passed `-show_format`, `-show_streams`,
   * `-show_entries`, or a non-default `-of`. Drives machine-readable
   * output; bare `ffprobe FILE` stays a human summary.
   */
  structured: boolean;
}

const VALUE_FLAGS = new Set([
  '-i',
  '-v',
  '-loglevel',
  '-of',
  '-print_format',
  '-show_entries',
  '-select_streams',
]);

const BOOL_FLAGS = new Set([
  '-show_format',
  '-show_streams',
  '-hide_banner',
  '-h',
  '--help',
  '-version',
  '--version',
]);

function ffprobeHelp(): CmdResult {
  return {
    stdout: `ffprobe - media probe (mediabunny, with a wasm fallback)

Usage:
  ffprobe [options] -i <input>
  ffprobe [options] <input>

SLICC does not ship a real ffprobe binary. Containers mediabunny reads
(mp4/mov, webm/mkv, mp3, wav, ogg, flac, aac, mpegts) are probed from
their index — typed fields, no wasm boot, nothing to install. Anything
else falls back to the shared @ffmpeg/core wasm, run with \`-i <input>\`
(no output) and its Input #N banner parsed. Either way the fields are:

  format:  filename, format_name, duration, start_time, bit_rate
  streams: index, codec_type, codec_name, profile, width/height,
           pix_fmt, sample_rate, channels, channel_layout,
           r_frame_rate / avg_frame_rate, bit_rate, duration

Supported options:
  -i FILE                 Input file (VFS path)
  -show_format            Include format section
  -show_streams           Include streams section
  -show_entries SPEC      format=a,b:stream=c,d  (subset of real ffprobe)
  -select_streams SPEC    v / a / v:N / a:N  (first matching stream index N)
  -of / -print_format FMT json | csv[=p=0] | default[=nw=1:nk=1]
                          csv: p=1 (default) prefixes each row with the
                          section name (format|stream); p=0 prints values only.
                          Fields containing commas/quotes are CSV-quoted.
  -v / -loglevel LEVEL    quiet|panic|fatal|error|warning|info|verbose|debug
  -version                Report the wasm core that would back the fallback

Unsupported options are rejected with a non-zero exit (never silently
ignored). FFMPEG_ENGINE=wasm forces the emulation; FFMPEG_ENGINE=mediabunny
refuses containers it cannot read instead of falling back. The fallback
needs the same core pin as \`ffmpeg\` (\`@ffmpeg/core-mt\` on a
cross-origin-isolated leader, else \`@ffmpeg/core\`):
  ipk add -g @ffmpeg/core-mt@<pinned>
  ipk add -g @ffmpeg/core@<pinned>

Examples:
  ffprobe -v error -show_entries stream=channels -select_streams a:0 -of default=nw=1:nk=1 clip.mp4
  ffprobe -v error -show_format -show_streams -of json clip.mp4
`,
    stderr: '',
    exitCode: 0,
  };
}

async function ffprobeVersion(ctx: CommandContext): Promise<CmdResult> {
  const loaded = await tryLoadFfmpegCoreFromNodeModules(createIpkContextFromCtx(ctx));
  if (!loaded) {
    return { stdout: '', stderr: `ffprobe: ${ffmpegCoreNotInstalledMessage()}\n`, exitCode: 1 };
  }
  return {
    stdout: `ffprobe (emulated via @ffmpeg/ffmpeg — not a real ffprobe binary)\ncore: ${describeFfmpegCore(loaded)}\n`,
    stderr: '',
    exitCode: 0,
  };
}

function requireValue(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (typeof v !== 'string' || v.startsWith('-')) {
    throw new Error(`ffprobe: ${flag} requires a value`);
  }
  return v;
}

function parseOutputFormat(raw: string): OutputFormat {
  const eq = raw.indexOf('=');
  const name = eq < 0 ? raw : raw.slice(0, eq);
  const opts = eq < 0 ? '' : raw.slice(eq + 1);
  if (name === 'json') return { kind: 'json' };
  if (name === 'csv') {
    // Upstream ffprobe: `p` / `print_section` — print the section name at
    // the start of each line. `csv=p=0` suppresses it. (Not print_filename.)
    return { kind: 'csv', printSection: !/(?:^|:)p=0(?::|$)/.test(opts) };
  }
  if (name === 'default') {
    return {
      kind: 'default',
      noWrappers: /(?:^|:)(?:nw|noprint_wrappers)=1(?::|$)/.test(opts),
      noKey: /(?:^|:)(?:nk|nokey)=1(?::|$)/.test(opts),
    };
  }
  throw new Error(
    `ffprobe: unsupported -of '${raw}' (supported: json, csv[=p=0], default[=nw=1:nk=1])`
  );
}

function parseShowEntries(raw: string): ShowEntries {
  const out: ShowEntries = {};
  for (const section of raw.split(':')) {
    if (!section) continue;
    const eq = section.indexOf('=');
    if (eq < 0) {
      throw new Error(
        `ffprobe: -show_entries section '${section}' needs keys (e.g. format=duration)`
      );
    }
    const name = section.slice(0, eq);
    const keys = section
      .slice(eq + 1)
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    if (name === 'format') out.format = new Set(keys);
    else if (name === 'stream') out.stream = new Set(keys);
    else {
      throw new Error(
        `ffprobe: unsupported -show_entries section '${name}' (supported: format, stream)`
      );
    }
  }
  return out;
}

/** Apply one argv token; returns the next index to process. */
function applyFfprobeArg(parsed: ParsedFfprobeArgs, args: string[], i: number): number {
  const arg = args[i];
  if (arg === '-i') {
    parsed.inputPath = requireValue(args, i, '-i');
    return i + 1;
  }
  if (arg === '-show_format') {
    parsed.showFormat = true;
    parsed.structured = true;
    return i;
  }
  if (arg === '-show_streams') {
    parsed.showStreams = true;
    parsed.structured = true;
    return i;
  }
  if (arg === '-show_entries') {
    parsed.showEntries = parseShowEntries(requireValue(args, i, '-show_entries'));
    parsed.structured = true;
    return i + 1;
  }
  if (arg === '-select_streams') {
    parsed.selectStreams = requireValue(args, i, '-select_streams');
    return i + 1;
  }
  if (arg === '-of' || arg === '-print_format') {
    parsed.outputFormat = parseOutputFormat(requireValue(args, i, arg));
    parsed.structured = true;
    return i + 1;
  }
  if (arg === '-v' || arg === '-loglevel') {
    const level = requireValue(args, i, arg).toLowerCase();
    parsed.quiet = ['quiet', 'panic', 'fatal', 'error', 'warning'].includes(level);
    return i + 1;
  }
  if (arg === '-hide_banner') return i;
  if (BOOL_FLAGS.has(arg) || VALUE_FLAGS.has(arg)) {
    throw new Error(`ffprobe: internal parse gap for '${arg}'`);
  }
  if (arg.startsWith('-')) {
    throw new Error(
      `ffprobe: unsupported option '${arg}' (this is an emulated probe — see --help)`
    );
  }
  if (parsed.inputPath !== null) {
    throw new Error(`ffprobe: unexpected argument '${arg}'`);
  }
  parsed.inputPath = arg;
  return i;
}

/**
 * Parse ffprobe-style argv. Exported for unit tests.
 */
export function parseFfprobeArgs(args: string[]): ParsedFfprobeArgs {
  const parsed: ParsedFfprobeArgs = {
    inputPath: null,
    showFormat: false,
    showStreams: false,
    showEntries: null,
    selectStreams: null,
    outputFormat: { kind: 'default', noWrappers: false, noKey: false },
    quiet: false,
    structured: false,
  };

  for (let i = 0; i < args.length; i++) {
    i = applyFfprobeArg(parsed, args, i);
  }

  // Bare `ffprobe FILE` still probes both sections for the human view.
  if (!parsed.showFormat && !parsed.showStreams && !parsed.showEntries) {
    parsed.showFormat = true;
    parsed.showStreams = true;
  }
  return parsed;
}

/**
 * Filter streams by an ffprobe-style `-select_streams` spec
 * (`v`, `a`, `v:0`, `a:1`). Exported for unit tests.
 */
export function selectProbeStreams(streams: ProbeStream[], spec: string | null): ProbeStream[] {
  if (!spec) return streams;
  const m = /^([va])(?::(\d+))?$/i.exec(spec.trim());
  if (!m) {
    throw new Error(`ffprobe: unsupported -select_streams '${spec}' (supported: v, a, v:N, a:N)`);
  }
  const wantType = m[1].toLowerCase() === 'v' ? 'video' : 'audio';
  const typed = streams.filter((s) => s.codec_type === wantType);
  if (m[2] === undefined) return typed;
  const idx = Number(m[2]);
  const hit = typed[idx];
  return hit ? [hit] : [];
}

/**
 * Flat key→scalar bag for `-show_entries` projection and `-of`
 * rendering. Nested `tags` are omitted — call sites that need them
 * read {@link ProbeFormat.tags} / {@link ProbeStream.tags} directly.
 */
interface ProbeFieldBag {
  [key: string]: string | number | undefined;
}

interface RenderSections {
  format?: ProbeFieldBag;
  streams?: ProbeFieldBag[];
}

const FORMAT_SCALAR_KEYS = [
  'filename',
  'format_name',
  'duration',
  'start_time',
  'bit_rate',
] as const satisfies ReadonlyArray<keyof ProbeFormat>;

const STREAM_SCALAR_KEYS = [
  'index',
  'codec_type',
  'codec_name',
  'codec_tag_string',
  'profile',
  'width',
  'height',
  'pix_fmt',
  'sample_aspect_ratio',
  'display_aspect_ratio',
  'r_frame_rate',
  'avg_frame_rate',
  'sample_rate',
  'channels',
  'channel_layout',
  'bit_rate',
  'duration',
] as const satisfies ReadonlyArray<keyof ProbeStream>;

function formatToFields(format: ProbeFormat, keys?: Set<string>): ProbeFieldBag {
  const out: ProbeFieldBag = {};
  for (const key of FORMAT_SCALAR_KEYS) {
    if (keys && !keys.has(key)) continue;
    const value = format[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function streamToFields(stream: ProbeStream, keys?: Set<string>): ProbeFieldBag {
  const out: ProbeFieldBag = {};
  for (const key of STREAM_SCALAR_KEYS) {
    if (keys && !keys.has(key)) continue;
    const value = stream[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function formatAsObject(info: ProbeInfo, parsed: ParsedFfprobeArgs): RenderSections {
  const streams = selectProbeStreams(info.streams, parsed.selectStreams);
  const out: RenderSections = {};

  if (parsed.showEntries) {
    if (parsed.showEntries.format) {
      out.format = formatToFields(info.format, parsed.showEntries.format);
    }
    if (parsed.showEntries.stream) {
      out.streams = streams.map((s) => streamToFields(s, parsed.showEntries?.stream));
    }
    return out;
  }

  if (parsed.showFormat) out.format = formatToFields(info.format);
  if (parsed.showStreams) out.streams = streams.map((s) => streamToFields(s));
  return out;
}

function renderDefault(
  sections: RenderSections,
  fmt: Extract<OutputFormat, { kind: 'default' }>
): string {
  const lines: string[] = [];
  const emitSection = (name: string, obj: ProbeFieldBag): void => {
    if (!fmt.noWrappers) lines.push(`[${name}]`);
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      lines.push(fmt.noKey ? String(v) : `${k}=${v}`);
    }
    if (!fmt.noWrappers) lines.push(`[/${name}]`);
  };
  if (sections.format) emitSection('FORMAT', sections.format);
  if (sections.streams) {
    for (const stream of sections.streams) emitSection('STREAM', stream);
  }
  return `${lines.join('\n')}\n`;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function renderCsv(sections: RenderSections, fmt: Extract<OutputFormat, { kind: 'csv' }>): string {
  const lines: string[] = [];
  const row = (section: string, obj: ProbeFieldBag): void => {
    const values = Object.values(obj)
      .filter((v): v is string | number => v !== undefined)
      .map((v) => csvEscape(String(v)));
    // Streams that lack every requested key (e.g. video under
    // `-show_entries stream=channels`) would otherwise print a bare
    // section name with no values — skip those empty rows.
    if (values.length === 0) return;
    if (fmt.printSection) values.unshift(section);
    lines.push(values.join(','));
  };
  if (sections.format) row('format', sections.format);
  if (sections.streams) for (const s of sections.streams) row('stream', s);
  return `${lines.join('\n')}\n`;
}

function formatHumanStream(s: ProbeStream): string {
  const codec = s.codec_name ?? '?';
  if (s.codec_type === 'video') {
    const size = s.width && s.height ? `, ${s.width}x${s.height}` : '';
    const fps = s.r_frame_rate ? `, ${s.r_frame_rate} fps` : '';
    return `  Stream #0:${s.index}: Video: ${codec}${size}${fps}`;
  }
  if (s.codec_type === 'audio') {
    const rate = s.sample_rate ? `, ${s.sample_rate} Hz` : '';
    const layout = s.channel_layout ? `, ${s.channel_layout}` : '';
    const ch = s.channels !== undefined ? ` (${s.channels} ch)` : '';
    return `  Stream #0:${s.index}: Audio: ${codec}${rate}${layout}${ch}`;
  }
  return `  Stream #0:${s.index}: ${s.codec_type}: ${codec}`;
}

function renderHuman(info: ProbeInfo): string {
  const f = info.format;
  const lines = [`Input #0, ${f.format_name ?? 'unknown'}, from '${f.filename ?? ''}':`];
  if (f.duration !== undefined || f.bit_rate !== undefined) {
    const dur = f.duration ?? 'N/A';
    const br = f.bit_rate ? `${Math.round(Number(f.bit_rate) / 1000)} kb/s` : 'N/A';
    lines.push(`  Duration: ${dur} s, bitrate: ${br}`);
  }
  for (const s of info.streams) lines.push(formatHumanStream(s));
  return `${lines.join('\n')}\n`;
}

function renderOutput(info: ProbeInfo, parsed: ParsedFfprobeArgs): string {
  if (!parsed.structured) return renderHuman(info);

  const sections = formatAsObject(info, parsed);
  if (parsed.outputFormat.kind === 'json') {
    return `${JSON.stringify(sections, null, 4)}\n`;
  }
  if (parsed.outputFormat.kind === 'csv') {
    return renderCsv(sections, parsed.outputFormat);
  }
  return renderDefault(sections, parsed.outputFormat);
}

/**
 * Probe jobs share one realm-scoped `@ffmpeg/core` instance. Concurrent
 * probes would otherwise register overlapping `log` listeners (and can
 * clobber the same MEMFS basename), silently mixing banners. Serialize
 * every probe through this chain — a rejected job must not poison later
 * ones (`then(run, run)`).
 */
let probeChain: Promise<void> = Promise.resolve();

function withProbeLock<T>(run: () => Promise<T>): Promise<T> {
  const next = probeChain.then(run, run);
  probeChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/** Monotonic stem so concurrent (or sequential) probes never share a MEMFS path. */
let probeSeq = 0;

/** Test-only — reset the probe serializer between cases. */
export function resetFfprobeLockForTests(): void {
  probeChain = Promise.resolve();
  probeSeq = 0;
}

/**
 * Opaque staging name. Carrying the VFS basename through verbatim
 * breaks when it contains `'` (ffmpeg echoes `from '…'` and our banner
 * parser only accepts `[^']*`). Keep a sanitized extension so the
 * demuxer still sniffs the container.
 */
export function inferMemfsName(path: string): string {
  const base = path.split('/').pop() || 'input.bin';
  const extMatch = /\.([A-Za-z0-9]{1,8})$/.exec(base);
  const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : '.bin';
  probeSeq = (probeSeq + 1) >>> 0;
  return `__probe_${probeSeq}_${Date.now()}${ext}`;
}

async function loadProbeCore(
  ctx: CommandContext
): Promise<{ ffmpeg: Awaited<ReturnType<typeof getFfmpeg>>; loadLog: string } | CmdResult> {
  let loadLog = '';
  try {
    const ffmpeg = await getFfmpeg({
      onProgress: (msg) => {
        loadLog += `${msg}\n`;
      },
      ipk: createIpkContextFromCtx(ctx),
    });
    return { ffmpeg, loadLog };
  } catch (err) {
    return {
      stdout: '',
      stderr: `ffprobe: failed to load wasm: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }
}

async function execProbeBanner(
  ffmpeg: Awaited<ReturnType<typeof getFfmpeg>>,
  memfsName: string,
  probeLog: { text: string }
): Promise<CmdResult | null> {
  try {
    await ffmpeg.exec(['-hide_banner', '-i', memfsName]);
  } catch (err) {
    if (isCoreFault(err)) {
      recycleFfmpeg(ffmpeg);
      return {
        stdout: '',
        stderr: `ffprobe: wasm core faulted (${err instanceof Error ? err.message : String(err)}); recycled shared instance\n`,
        exitCode: 1,
      };
    }
    // Non-trap exec failures still often carry a useful banner.
    probeLog.text += `${err instanceof Error ? err.message : String(err)}\n`;
  }
  return null;
}

/** Render `info` the way the user asked, or the usual exit-1 shell error. */
function renderResult(info: ProbeInfo, parsed: ParsedFfprobeArgs, stderr: string): CmdResult {
  info.format.filename = parsed.inputPath ?? info.format.filename;
  try {
    const stdout = renderOutput(info, parsed);
    return { stdout, stderr: parsed.quiet ? '' : stderr, exitCode: 0 };
  } catch (err) {
    return {
      stdout: '',
      stderr: `ffprobe: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }
}

/**
 * mediabunny reads the container index lazily and answers with typed
 * fields — no 31 MB wasm boot, no banner scraping. `null` hands the probe
 * to the wasm emulation (container mediabunny does not read, or
 * `FFMPEG_ENGINE=wasm`). The module is `import()`ed so mediabunny never
 * rides the boot graph.
 */
async function tryMediabunnyProbe(
  parsed: ParsedFfprobeArgs,
  data: Blob,
  ctx: CommandContext
): Promise<CmdResult | null> {
  const { ffmpegEngineFromEnv } = await import('../ffmpeg/engine.js');
  const engine = ffmpegEngineFromEnv(ctx.env);
  if (engine === 'wasm') return null;
  const { probeViaMediabunny } = await import('../ffmpeg/bunny-probe.js');
  const info = await probeViaMediabunny(data, parsed.inputPath ?? '');
  if (info) return renderResult(info, parsed, '');
  if (engine === 'mediabunny') {
    return {
      stdout: '',
      stderr: 'ffprobe: FFMPEG_ENGINE=mediabunny: input is not a container mediabunny reads\n',
      exitCode: 1,
    };
  }
  return null;
}

async function runProbe(parsed: ParsedFfprobeArgs, ctx: CommandContext): Promise<CmdResult> {
  if (!parsed.inputPath) {
    return {
      stdout: '',
      stderr: 'ffprobe: at least one input file must be specified\n',
      exitCode: 1,
    };
  }
  const resolved = ctx.fs.resolvePath(ctx.cwd, parsed.inputPath);
  if (!(await ctx.fs.exists(resolved))) {
    return {
      stdout: '',
      stderr: `ffprobe: input file not found: ${parsed.inputPath}\n`,
      exitCode: 1,
    };
  }
  // Lazily-read Blob: mediabunny slices it; the wasm path mounts it via
  // WORKERFS. Either way the probe only touches the container headers, so
  // a multi-GB input costs no heap.
  const data = await readInputBlob(ctx.fs, resolved);
  const fast = await tryMediabunnyProbe(parsed, data, ctx);
  if (fast) return fast;
  return withProbeLock(() => runProbeExclusive(parsed, data, ctx));
}

async function runProbeExclusive(
  parsed: ParsedFfprobeArgs,
  data: Blob,
  ctx: CommandContext
): Promise<CmdResult> {
  const stage = newStage();
  const stagedName = inferMemfsName(parsed.inputPath ?? '');
  const memfsName = stagedPath(stage, stagedName);

  const loaded = await loadProbeCore(ctx);
  if ('exitCode' in loaded) return loaded;
  const { ffmpeg, loadLog } = loaded;

  const probeLog = { text: '' };
  const logHandler = (event: { type: string; message: string }): void => {
    probeLog.text += `${event.message}\n`;
  };
  ffmpeg.on('log', logHandler);

  // Same invariant as `runWasmFfmpeg` (#2766): after recycle the worker
  // is gone, so MEMFS cleanup must not re-enter the terminated core.
  let faulted = false;
  try {
    await mountStagedInputs(ffmpeg, stage, [{ name: stagedName, data }]);
    const fault = await execProbeBanner(ffmpeg, memfsName, probeLog);
    if (fault) {
      faulted = true;
      return fault;
    }

    const info = parseFfmpegProbeLog(probeLog.text, parsed.inputPath ?? '');
    if (!info) {
      return {
        stdout: '',
        stderr: `ffprobe: could not parse media info from ffmpeg log\n${parsed.quiet ? '' : probeLog.text || loadLog}`,
        exitCode: 1,
      };
    }
    return renderResult(info, parsed, loadLog);
  } catch (err) {
    if (isCoreFault(err)) {
      faulted = true;
      recycleFfmpeg(ffmpeg);
    }
    return {
      stdout: '',
      stderr: `ffprobe: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  } finally {
    try {
      ffmpeg.off('log', logHandler);
    } catch {
      /* noop */
    }
    // A terminated worker has no FS left to tidy, and every
    // `unmount` would re-enter the trapped module.
    if (!faulted) {
      try {
        await unmountStagedInputs(ffmpeg, stage);
      } catch {
        /* noop */
      }
    }
  }
}

export async function runFfprobe(args: string[], ctx: CommandContext): Promise<CmdResult> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    return ffprobeHelp();
  }
  if (args.includes('-version') || args.includes('--version')) {
    return ffprobeVersion(ctx);
  }
  let parsed: ParsedFfprobeArgs;
  try {
    parsed = parseFfprobeArgs(args);
  } catch (err) {
    return {
      stdout: '',
      stderr: `${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }
  return runProbe(parsed, ctx);
}

/** Test helper — same surface as other create*Command factories. */
export function createFfprobeCommand(): Command {
  return defineCommand('ffprobe', (args, ctx) => runFfprobe(args, ctx));
}

// Re-export parse helpers used by tests that assert field shaping.
export type { ProbeFormat, ProbeInfo, ProbeStream };
