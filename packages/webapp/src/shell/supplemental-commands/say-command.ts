import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getPanelRpcClient } from '../../kernel/panel-rpc.js';

function sayHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout:
      'usage: say [-v voice] [-r rate] [-l lang] [--list] <text>\n\n' +
      '  Speaks the given text. Uses the on-device Kokoro voice when its\n' +
      '  model has downloaded (see hear --warmup; kokoro chains after the\n' +
      '  whisper download) and English text; the Web Speech API otherwise.\n' +
      '  -v voice   Voice name (partial match; kokoro ids like af_heart work\n' +
      '             once the model is ready)\n' +
      '  -r rate    Speech rate (0.1 to 10, default 1)\n' +
      '  -l lang    Language tag (required, BCP 47, e.g. en-US, de-DE, fr-FR)\n' +
      '  --list     List available voices (kokoro voices first when ready)\n',
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

    // `say` only needs Web Speech, not the full DOM — using a finer
    // gate than `hasLocalDom()` here keeps existing tests (which stub
    // `window` + `speechSynthesis` only) working under jsdom-free
    // environments while still bridging to the page in the kernel
    // worker where neither global exists.
    const local = typeof window !== 'undefined' && typeof speechSynthesis !== 'undefined';
    const panelRpc = getPanelRpcClient();
    if (!local && !panelRpc) {
      return {
        stdout: '',
        stderr: 'say: Web Speech API unavailable in this environment\n',
        exitCode: 1,
      };
    }

    // Handle --list early (needs voices)
    if (args.includes('--list')) {
      if (local) {
        // Kokoro voices lead when the on-device engine is warm — listed by
        // their stable ids so `-v af_heart` round-trips.
        const { kokoroVoicesIfReady } = await import('../../speech/speak.js');
        const kokoro = kokoroVoicesIfReady().map((v) => `${v.id} (${v.lang}) [kokoro]`);
        const voices = await getVoices();
        const lines = [
          ...kokoro,
          ...voices.map((v) => `${v.name} (${v.lang})${v.default ? ' [default]' : ''}`),
        ];
        return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
      }
      try {
        const r = await panelRpc!.call('list-voices', undefined);
        const lines = r.voices.map((v) => `${v.name} (${v.lang})${v.default ? ' [default]' : ''}`);
        return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
      } catch (err) {
        return {
          stdout: '',
          stderr: `say: ${err instanceof Error ? err.message : String(err)}\n`,
          exitCode: 1,
        };
      }
    }

    // Parse args (no voice loading needed)
    let voiceName: string | null = null;
    let rate = 1;
    let lang: string | null = null;
    const textParts: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-v') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
          return { stdout: '', stderr: 'say: -v requires a voice name\n', exitCode: 1 };
        }
        voiceName = args[++i];
      } else if (arg === '-r') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
          return { stdout: '', stderr: 'say: -r requires a rate value\n', exitCode: 1 };
        }
        rate = parseFloat(args[++i]);
        if (isNaN(rate) || rate < 0.1 || rate > 10) {
          return { stdout: '', stderr: 'say: rate must be between 0.1 and 10\n', exitCode: 1 };
        }
      } else if (arg === '-l') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
          return { stdout: '', stderr: 'say: -l requires a language tag\n', exitCode: 1 };
        }
        lang = args[++i];
      } else if (arg.startsWith('-') && arg !== '--list') {
        return { stdout: '', stderr: `say: unknown option: ${arg}\n`, exitCode: 1 };
      } else if (!arg.startsWith('-')) {
        textParts.push(arg);
      }
    }

    // Validate
    const text = textParts.join(' ');
    if (!text) {
      return sayHelp();
    }

    if (!lang) {
      return { stdout: '', stderr: 'say: -l language tag is required\n', exitCode: 1 };
    }

    // Voice matching for worker context: the page-side handler does the
    // exact-name match on `voice`, so we pre-resolve the partial here.
    // Kokoro voice ids participate in the match on both paths — locally via
    // the merged list, over RPC via the page handler's merged `list-voices`.
    let resolvedVoice: string | undefined;
    if (voiceName) {
      const voices = local
        ? await (async () => {
            const { kokoroVoicesIfReady } = await import('../../speech/speak.js');
            const kokoro = kokoroVoicesIfReady().map((v) => ({
              name: v.id,
              lang: v.lang,
              default: false,
            }));
            const web = (await getVoices()).map((v) => ({
              name: v.name,
              lang: v.lang,
              default: v.default,
            }));
            return [...kokoro, ...web];
          })()
        : (await panelRpc!.call('list-voices', undefined)).voices;
      const match = voices.find((v) => v.name.toLowerCase().includes(voiceName!.toLowerCase()));
      if (!match) {
        return {
          stdout: '',
          stderr: `say: voice "${voiceName}" not found. Use --list to see available voices.\n`,
          exitCode: 1,
        };
      }
      resolvedVoice = match.name;
    }

    if (local) {
      // The speak helper picks the engine: kokoro when its model is warm
      // (or the resolved voice is a kokoro id), Web Speech otherwise.
      try {
        const { speak } = await import('../../speech/speak.js');
        await speak({ text, lang, voice: resolvedVoice, rate });
        return { stdout: '', stderr: '', exitCode: 0 };
      } catch (err) {
        return {
          stdout: '',
          stderr: `say: speech synthesis error: ${err instanceof Error ? err.message : String(err)}\n`,
          exitCode: 1,
        };
      }
    }

    // Worker context: bridge via panel-RPC. `lang` is required for the
    // command contract and must reach the page so the utterance uses
    // the correct locale (regression flagged on PR #626 review).
    try {
      await panelRpc!.call('speak-text', {
        text,
        lang,
        voice: resolvedVoice,
        rate,
      });
      return { stdout: '', stderr: '', exitCode: 0 };
    } catch (err) {
      return {
        stdout: '',
        stderr: `say: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }
  });
}
