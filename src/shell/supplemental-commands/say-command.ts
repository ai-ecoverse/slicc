import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

function sayHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout:
      'usage: say [-v voice] [-r rate] [--list] <text>\n\n' +
      '  Speaks the given text using the Web Speech API.\n' +
      '  -v voice   Voice name (partial match supported)\n' +
      '  -r rate    Speech rate (0.1 to 10, default 1)\n' +
      '  --list     List available voices\n',
    stderr: '',
    exitCode: 0,
  };
}

let voicesLoaded = false;
let voicesPromise: Promise<SpeechSynthesisVoice[]> | null = null;

function getVoices(): Promise<SpeechSynthesisVoice[]> {
  if (voicesLoaded) {
    return Promise.resolve(speechSynthesis.getVoices());
  }
  if (!voicesPromise) {
    voicesPromise = new Promise((resolve) => {
      const voices = speechSynthesis.getVoices();
      if (voices.length > 0) {
        voicesLoaded = true;
        resolve(voices);
        return;
      }
      const handler = () => {
        voicesLoaded = true;
        speechSynthesis.removeEventListener('voiceschanged', handler);
        resolve(speechSynthesis.getVoices());
      };
      speechSynthesis.addEventListener('voiceschanged', handler);
      // Timeout fallback in case voiceschanged never fires
      setTimeout(() => {
        speechSynthesis.removeEventListener('voiceschanged', handler);
        voicesLoaded = true;
        resolve(speechSynthesis.getVoices());
      }, 1000);
    });
  }
  return voicesPromise;
}

export function createSayCommand(): Command {
  return defineCommand('say', async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return sayHelp();
    }

    if (typeof window === 'undefined' || typeof speechSynthesis === 'undefined') {
      return {
        stdout: '',
        stderr: 'say: Web Speech API unavailable in this environment\n',
        exitCode: 1,
      };
    }

    const voices = await getVoices();

    if (args.includes('--list')) {
      const lines = voices.map((v) => `${v.name} (${v.lang})${v.default ? ' [default]' : ''}`);
      return {
        stdout: lines.join('\n') + '\n',
        stderr: '',
        exitCode: 0,
      };
    }

    let voiceName: string | null = null;
    let rate = 1;
    const textParts: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-v' && i + 1 < args.length) {
        voiceName = args[++i];
      } else if (arg === '-r' && i + 1 < args.length) {
        rate = parseFloat(args[++i]);
        if (isNaN(rate) || rate < 0.1 || rate > 10) {
          return {
            stdout: '',
            stderr: 'say: rate must be between 0.1 and 10\n',
            exitCode: 1,
          };
        }
      } else if (!arg.startsWith('-')) {
        textParts.push(arg);
      }
    }

    const text = textParts.join(' ');
    if (!text) {
      return sayHelp();
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rate;

    if (voiceName) {
      const match = voices.find(
        (v) => v.name.toLowerCase().includes(voiceName!.toLowerCase())
      );
      if (match) {
        utterance.voice = match;
      } else {
        return {
          stdout: '',
          stderr: `say: voice "${voiceName}" not found. Use --list to see available voices.\n`,
          exitCode: 1,
        };
      }
    }

    return new Promise((resolve) => {
      utterance.onend = () => {
        resolve({ stdout: '', stderr: '', exitCode: 0 });
      };
      utterance.onerror = (event) => {
        resolve({
          stdout: '',
          stderr: `say: speech synthesis error: ${event.error}\n`,
          exitCode: 1,
        });
      };
      speechSynthesis.speak(utterance);
    });
  });
}
