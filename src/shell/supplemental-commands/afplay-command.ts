import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
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

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
  }
  return audioContext;
}

async function playAudioFile(
  filePath: string,
  volume: number,
  rate: number,
  ctx: CommandContext
): Promise<CommandResult> {
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') {
    return {
      stdout: '',
      stderr: 'afplay: Web Audio API unavailable in this environment\n',
      exitCode: 1,
    };
  }

  const fullPath = ctx.fs.resolvePath(ctx.cwd, filePath);

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await ctx.fs.readFileBuffer(fullPath));
  } catch {
    return {
      stdout: '',
      stderr: `afplay: cannot open ${filePath}: No such file\n`,
      exitCode: 1,
    };
  }

  const mimeType = detectMimeType(fullPath);
  if (!mimeType.startsWith('audio/')) {
    return {
      stdout: '',
      stderr: `afplay: ${filePath} is not an audio file\n`,
      exitCode: 1,
    };
  }

  try {
    const audioCtx = getAudioContext();
    
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    // Copy to a new ArrayBuffer to avoid SharedArrayBuffer type issues
    const arrayBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(arrayBuffer).set(bytes);
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
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
    return {
      stdout: '',
      stderr: `afplay: failed to play ${filePath}: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }
}

export function createAfplayCommand(): Command {
  return defineCommand('afplay', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return afplayHelp();
    }

    let volume = 1;
    let rate = 1;
    let filePath: string | null = null;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-v') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
          return { stdout: '', stderr: 'afplay: -v requires a volume value\n', exitCode: 1 };
        }
        volume = parseFloat(args[++i]);
        if (isNaN(volume) || volume < 0 || volume > 1) {
          return { stdout: '', stderr: 'afplay: volume must be between 0 and 1\n', exitCode: 1 };
        }
      } else if (arg === '-r') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
          return { stdout: '', stderr: 'afplay: -r requires a rate value\n', exitCode: 1 };
        }
        rate = parseFloat(args[++i]);
        if (isNaN(rate) || rate < 0.25 || rate > 4) {
          return { stdout: '', stderr: 'afplay: rate must be between 0.25 and 4\n', exitCode: 1 };
        }
      } else if (arg.startsWith('-')) {
        return { stdout: '', stderr: `afplay: unknown option: ${arg}\n`, exitCode: 1 };
      } else {
        if (filePath !== null) {
          return { stdout: '', stderr: 'afplay: only one file can be specified\n', exitCode: 1 };
        }
        filePath = arg;
      }
    }

    if (!filePath) {
      return afplayHelp();
    }

    return playAudioFile(filePath, volume, rate, ctx);
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
