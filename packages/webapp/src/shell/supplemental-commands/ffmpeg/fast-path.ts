import type { IFileSystem } from 'just-bash';
import { runViaMediabunny } from './bunny-run.js';
import { translateToMediabunny } from './bunny-translate.js';
import type { FfmpegEngine } from './engine.js';
import type { ParsedFfmpegInvocation } from './run.js';

type CmdResult = { stdout: string; stderr: string; exitCode: number };

export type FastPathOutcome = { result: CmdResult } | { fallback: true; note: string | null };

function fail(stderr: string): { result: CmdResult } {
  return { result: { stdout: '', stderr, exitCode: 1 } };
}

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
