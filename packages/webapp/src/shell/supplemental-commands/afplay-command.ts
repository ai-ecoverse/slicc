import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getPanelRpcClient, hasLocalDom } from '../../kernel/panel-rpc.js';
import { detectMimeType } from './shared.js';

type CommandContext = Parameters<Parameters<typeof defineCommand>[1]>[1];
type CommandResult = { stdout: string; stderr: string; exitCode: number };

function afplayHelp(): CommandResult {
  return {
    stdout:
      'usage: afplay [-v volume] [-r rate] <file>\n\n' +
      '  Plays an audio file using the Web Audio API.\n' +
      '  -v volume  Volume level (0 to 1, default 1)\n' +
      '  -r rate    Playback rate (0.25 to 4, default 1)\n',
    stderr: '',
    exitCode: 0,
  };
}

function fail(message: string): CommandResult {
  return { stdout: '', stderr: `afplay: ${message}\n`, exitCode: 1 };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface AfplayArgs {
  volume: number;
  rate: number;
  filePath: string | null;
}

/** Value-taking flags → the "requires …" wording for a missing value. */
const VALUE_FLAG_HINTS: Record<string, string> = {
  '-v': 'a volume value',
  '-r': 'a rate value',
};

function parseVolume(value: string): string | null {
  const volume = Number.parseFloat(value);
  if (Number.isNaN(volume) || volume < 0 || volume > 1) {
    return 'volume must be between 0 and 1';
  }
  return null;
}

function parseRate(value: string): string | null {
  const rate = Number.parseFloat(value);
  if (Number.isNaN(rate) || rate < 0.25 || rate > 4) {
    return 'rate must be between 0.25 and 4';
  }
  return null;
}

/** Apply one value flag onto the parse state; returns an error message or null. */
function applyValueFlag(parsed: AfplayArgs, flag: string, value: string): string | null {
  switch (flag) {
    case '-v': {
      const error = parseVolume(value);
      if (error) return error;
      parsed.volume = Number.parseFloat(value);
      return null;
    }
    case '-r': {
      const error = parseRate(value);
      if (error) return error;
      parsed.rate = Number.parseFloat(value);
      return null;
    }
    default:
      return `unknown option: ${flag}`;
  }
}

function parseAfplayArgs(args: string[]): AfplayArgs | CommandResult {
  const parsed: AfplayArgs = { volume: 1, rate: 1, filePath: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg in VALUE_FLAG_HINTS) {
      const value = i + 1 < args.length && !args[i + 1].startsWith('-') ? args[++i] : null;
      if (value == null) return fail(`${arg} requires ${VALUE_FLAG_HINTS[arg]}`);
      const error = applyValueFlag(parsed, arg, value);
      if (error) return fail(error);
      continue;
    }
    if (arg.startsWith('-')) return fail(`unknown option: ${arg}`);
    if (parsed.filePath !== null) return fail('only one file can be specified');
    parsed.filePath = arg;
  }
  return parsed;
}

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
  }
  return audioContext;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return arrayBuffer;
}

async function readAudioBytes(
  filePath: string,
  ctx: CommandContext
): Promise<{ bytes: Uint8Array; fullPath: string } | CommandResult> {
  const fullPath = ctx.fs.resolvePath(ctx.cwd, filePath);
  try {
    return { bytes: new Uint8Array(await ctx.fs.readFileBuffer(fullPath)), fullPath };
  } catch {
    return fail(`cannot open ${filePath}: No such file`);
  }
}

function validateAudioMime(fullPath: string, filePath: string): CommandResult | null {
  const mimeType = detectMimeType(fullPath);
  if (!mimeType.startsWith('audio/')) {
    return fail(`${filePath} is not an audio file`);
  }
  return null;
}

async function playViaPanelRpc(
  bytes: Uint8Array,
  fullPath: string,
  filePath: string,
  volume: number,
  panelRpc: NonNullable<ReturnType<typeof getPanelRpcClient>>
): Promise<CommandResult> {
  // Worker context: send the bytes to the page via panel-RPC.
  // `rate` is dropped on this path (the bridge plays at native rate)
  // — almost no callers use `-r` and supporting it would mean
  // building the BufferSource graph on the page side too.
  try {
    const mimeType = detectMimeType(fullPath);
    await panelRpc.call(
      'play-audio',
      { bytes: copyToArrayBuffer(bytes), mimeType, volume },
      { timeoutMs: 5 * 60_000 }
    );
    return { stdout: '', stderr: '', exitCode: 0 };
  } catch (err) {
    return fail(`failed to play ${filePath}: ${errText(err)}`);
  }
}

async function playViaWebAudio(
  bytes: Uint8Array,
  filePath: string,
  volume: number,
  rate: number
): Promise<CommandResult> {
  try {
    const audioCtx = getAudioContext();
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    const audioBuffer = await audioCtx.decodeAudioData(copyToArrayBuffer(bytes));
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = rate;

    const gainNode = audioCtx.createGain();
    gainNode.gain.value = volume;

    source.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    return new Promise((resolve) => {
      source.onended = () => {
        resolve({ stdout: '', stderr: '', exitCode: 0 });
      };
      source.start();
    });
  } catch (err) {
    return fail(`failed to play ${filePath}: ${errText(err)}`);
  }
}

async function playAudioFile(
  filePath: string,
  volume: number,
  rate: number,
  ctx: CommandContext
): Promise<CommandResult> {
  const local = hasLocalDom() && typeof AudioContext !== 'undefined';
  const panelRpc = getPanelRpcClient();
  if (!local && !panelRpc) {
    return fail('Web Audio API unavailable in this environment');
  }

  const read = await readAudioBytes(filePath, ctx);
  if ('exitCode' in read) return read;

  const mimeError = validateAudioMime(read.fullPath, filePath);
  if (mimeError) return mimeError;

  if (!local) {
    return playViaPanelRpc(read.bytes, read.fullPath, filePath, volume, panelRpc!);
  }

  return playViaWebAudio(read.bytes, filePath, volume, rate);
}

export function createAfplayCommand(): Command {
  return defineCommand('afplay', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return afplayHelp();
    }

    const parsed = parseAfplayArgs(args);
    if ('exitCode' in parsed) return parsed;
    if (!parsed.filePath) return afplayHelp();

    return playAudioFile(parsed.filePath, parsed.volume, parsed.rate, ctx);
  });
}

export function createChimeCommand(): Command {
  return defineCommand('chime', async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) {
      return {
        stdout:
          'usage: chime\n\n' +
          '  Plays a notification chime sound.\n' +
          '  Alias for: afplay /shared/sounds/chime.mp3\n',
        stderr: '',
        exitCode: 0,
      };
    }

    return playAudioFile('/shared/sounds/chime.mp3', 1, 1, ctx);
  });
}
