/**
 * The mediabunny fast path of the `ffmpeg` command.
 *
 * Loaded with `import()` from `ffmpeg-command.ts` so mediabunny and the
 * translator stay out of the boot-critical supplemental-commands graph.
 * Decides, runs, and writes the output; hands back either a finished
 * shell result or the reason the wasm core should take over.
 */

import type { IFileSystem } from 'just-bash';
import type { ParsedFfmpegInvocation } from '../ffmpeg-command.js';
import { runViaMediabunny } from './bunny-run.js';
import { translateToMediabunny } from './bunny-translate.js';
import type { FfmpegEngine } from './engine.js';

type CmdResult = { stdout: string; stderr: string; exitCode: number };

export type FastPathOutcome =
  /** The fast path handled the command; return this. */
  | { result: CmdResult }
  /** Run the wasm core. `note` (when set) is worth a stderr line. */
  | { fallback: true; note: string | null };

function fail(stderr: string): { result: CmdResult } {
  return { result: { stdout: '', stderr, exitCode: 1 } };
}

/**
 * Try `parsed` on mediabunny. `input` is the single resolved input's
 * `Blob`; `outputPath` is the absolute VFS path to write.
 */
export async function runFfmpegFastPath(args: {
  parsed: ParsedFfmpegInvocation;
  input: Blob;
  outputPath: string;
  fs: IFileSystem;
  engine: FfmpegEngine;
}): Promise<FastPathOutcome> {
  const forced = args.engine === 'mediabunny';
  const translated = translateToMediabunny(args.parsed);
  if (!translated.ok) {
    if (forced)
      return fail(`ffmpeg: FFMPEG_ENGINE=mediabunny cannot run this: ${translated.reason}\n`);
    // An argv shape mediabunny does not express is the wasm core's normal
    // job, not something to warn about on every lavfi / filtergraph run.
    return { fallback: true, note: null };
  }

  let stderr = 'ffmpeg: engine mediabunny (WebCodecs)\n';
  const run = await runViaMediabunny({
    plan: translated.plan,
    input: args.input,
    onLog: (line) => {
      stderr += `${line}\n`;
    },
  });
  if (run.kind === 'declined') {
    if (forced) return fail(`${stderr}ffmpeg: mediabunny declined: ${run.reason}\n`);
    return { fallback: true, note: `mediabunny declined (${run.reason}); using the wasm core` };
  }
  if (run.kind === 'failed') return fail(`${stderr}ffmpeg: ${run.message}\n`);

  try {
    await args.fs.writeFile(args.outputPath, run.bytes);
  } catch (err) {
    return fail(
      `${stderr}ffmpeg: cannot write ${args.parsed.outputPath}: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
  stderr += `ffmpeg: wrote ${args.parsed.outputPath} (${run.summary}, ${run.bytes.byteLength} bytes)\n`;
  return { result: { stdout: '', stderr, exitCode: 0 } };
}
