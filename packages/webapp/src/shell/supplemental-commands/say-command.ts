import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getPanelRpcClient } from '../../kernel/panel-rpc.js';

type CommandResult = { stdout: string; stderr: string; exitCode: number };

/** How the command reaches the speech stack: in-realm or over panel-RPC. */
interface SayBridge {
  local: boolean;
  panelRpc: ReturnType<typeof getPanelRpcClient>;
}

function sayHelp(): CommandResult {
  return {
    stdout:
      'usage: say [-v voice] [-r rate] [-l lang] [--list] <text>\n' +
      '       say --status | --warmup\n\n' +
      '  Speaks the given text. Uses the on-device Kokoro voice when its\n' +
      '  model has downloaded (run say --warmup, or it chains after the\n' +
      '  whisper download) and English text; the Web Speech API otherwise.\n' +
      '  -v voice   Voice name (partial match; kokoro ids like af_heart work\n' +
      '             once the model is ready)\n' +
      '  -r rate    Speech rate (0.1 to 10, default 1)\n' +
      '  -l lang    Language tag (required, BCP 47, e.g. en-US, de-DE, fr-FR)\n' +
      '  --list     List available voices (kokoro voices first when ready)\n' +
      '  --status   Show the on-device voice state (downloading/ready + ETA)\n' +
      '  --warmup   Stage + start the on-device voice download in the background\n',
    stderr: '',
    exitCode: 0,
  };
}

interface KokoroStatusShape {
  state: 'idle' | 'loading' | 'ready' | 'failed';
  loaded?: number;
  total?: number;
  etaSeconds?: number | null;
}

function formatStatus(status: KokoroStatusShape): string {
  switch (status.state) {
    case 'ready':
      return 'voice engine: ready\n';
    case 'failed':
      return 'voice engine: failed (re-run say --warmup to retry)\n';
    case 'idle':
      return 'voice engine: not downloaded (run say --warmup)\n';
    case 'loading': {
      const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
      const progress =
        status.loaded != null && status.total ? ` ${mb(status.loaded)}/${mb(status.total)} MB` : '';
      const eta =
        status.etaSeconds != null && Number.isFinite(status.etaSeconds)
          ? ` · ready in ~${Math.max(1, Math.round(status.etaSeconds))}s`
          : '';
      return `voice engine: downloading${progress}${eta}\n`;
    }
  }
}

function fail(message: string): CommandResult {
  return { stdout: '', stderr: `say: ${message}\n`, exitCode: 1 };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

interface SayArgs {
  voiceName: string | null;
  rate: number;
  lang: string | null;
  text: string;
}

/** Value-taking flags → the "requires …" wording for a missing value. */
const VALUE_FLAG_HINTS: Record<string, string> = {
  '-v': 'a voice name',
  '-r': 'a rate value',
  '-l': 'a language tag',
};

/** Apply one value flag onto the parse state; returns an error message or null. */
function applySayValueFlag(parsed: SayArgs, flag: string, value: string): string | null {
  switch (flag) {
    case '-v':
      parsed.voiceName = value;
      return null;
    case '-l':
      parsed.lang = value;
      return null;
    case '-r': {
      const rate = parseFloat(value);
      if (Number.isNaN(rate) || rate < 0.1 || rate > 10) {
        return 'rate must be between 0.1 and 10';
      }
      parsed.rate = rate;
      return null;
    }
    default:
      return `unknown option: ${flag}`;
  }
}

function parseSayArgs(args: string[]): SayArgs | CommandResult {
  const parsed: SayArgs = { voiceName: null, rate: 1, lang: null, text: '' };
  const textParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg in VALUE_FLAG_HINTS) {
      const value = i + 1 < args.length && !args[i + 1].startsWith('-') ? args[++i] : null;
      if (value == null) return fail(`${arg} requires ${VALUE_FLAG_HINTS[arg]}`);
      const error = applySayValueFlag(parsed, arg, value);
      if (error) return fail(error);
    } else if (arg.startsWith('-') && arg !== '--list') {
      return fail(`unknown option: ${arg}`);
    } else if (!arg.startsWith('-')) {
      textParts.push(arg);
    }
  }

  parsed.text = textParts.join(' ');
  return parsed;
}

/** `--list`: kokoro voices lead when the on-device engine is warm — listed
 *  by their stable ids so `-v af_heart` round-trips. */
async function runList(bridge: SayBridge): Promise<CommandResult> {
  if (bridge.local) {
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
    const r = await bridge.panelRpc!.call('list-voices', undefined);
    const lines = r.voices.map((v) => `${v.name} (${v.lang})${v.default ? ' [default]' : ''}`);
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
  } catch (err) {
    return fail(errText(err));
  }
}

/** The voices a `-v` partial can match: kokoro ids + web voices (local), or
 *  the page handler's merged `list-voices` (worker). */
async function listMatchableVoices(bridge: SayBridge): Promise<Array<{ name: string }>> {
  if (!bridge.local) {
    return (await bridge.panelRpc!.call('list-voices', undefined)).voices;
  }
  const { kokoroVoicesIfReady } = await import('../../speech/speak.js');
  const kokoro = kokoroVoicesIfReady().map((v) => ({ name: v.id }));
  const web = (await getVoices()).map((v) => ({ name: v.name }));
  return [...kokoro, ...web];
}

/**
 * Pre-resolve a `-v` partial to an exact voice name (the page-side handler
 * and the speak helper both match exact names). Kokoro voice ids participate
 * on both paths.
 */
async function resolveVoiceName(
  bridge: SayBridge,
  voiceName: string
): Promise<{ resolved?: string; error?: CommandResult }> {
  const voices = await listMatchableVoices(bridge);
  const match = voices.find((v) => v.name.toLowerCase().includes(voiceName.toLowerCase()));
  if (!match) {
    return { error: fail(`voice "${voiceName}" not found. Use --list to see available voices.`) };
  }
  return { resolved: match.name };
}

/**
 * `--status` / `--warmup`: report the on-device voice (kokoro) state — and,
 * for `--warmup`, stage the weights (R10) then kick the engine load in the
 * background. Mirrors `hear --status` / `hear --warmup`.
 */
async function runStatusOrWarmup(bridge: SayBridge, warmup: boolean): Promise<CommandResult> {
  try {
    if (bridge.local) {
      const { kokoroStatus, kokoroWarmup } = await import('../../speech/speak.js');
      const status = warmup ? kokoroWarmup() : kokoroStatus();
      return { stdout: formatStatus(status), stderr: '', exitCode: 0 };
    }
    const status = warmup
      ? await bridge.panelRpc!.call('speak-warmup', undefined)
      : await bridge.panelRpc!.call('speak-status', undefined);
    return { stdout: formatStatus(status), stderr: '', exitCode: 0 };
  } catch (err) {
    return fail(errText(err));
  }
}

/** Handle the standalone subcommands (`--list` / `--status` / `--warmup`);
 *  returns null when args carry none so the caller proceeds to the speak path. */
async function runSubcommand(bridge: SayBridge, args: string[]): Promise<CommandResult | null> {
  if (args.includes('--list')) return runList(bridge);
  if (args.includes('--status')) return runStatusOrWarmup(bridge, false);
  if (args.includes('--warmup')) return runStatusOrWarmup(bridge, true);
  return null;
}

/** Speak in-realm: the speak helper picks the engine — kokoro when its model
 *  is warm (or the resolved voice is a kokoro id), Web Speech otherwise. */
async function speakLocal(req: {
  text: string;
  lang: string;
  voice?: string;
  rate: number;
}): Promise<CommandResult> {
  try {
    const { speak } = await import('../../speech/speak.js');
    await speak(req);
    return { stdout: '', stderr: '', exitCode: 0 };
  } catch (err) {
    return fail(`speech synthesis error: ${errText(err)}`);
  }
}

/** Worker context: bridge via panel-RPC. `lang` is required for the command
 *  contract and must reach the page so the utterance uses the correct locale
 *  (regression flagged on PR #626 review). */
async function speakViaRpc(
  bridge: SayBridge,
  req: { text: string; lang: string; voice?: string; rate: number }
): Promise<CommandResult> {
  try {
    await bridge.panelRpc!.call('speak-text', req);
    return { stdout: '', stderr: '', exitCode: 0 };
  } catch (err) {
    return fail(errText(err));
  }
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
    const bridge: SayBridge = {
      local: typeof window !== 'undefined' && typeof speechSynthesis !== 'undefined',
      panelRpc: getPanelRpcClient(),
    };
    if (!bridge.local && !bridge.panelRpc) {
      return fail('Web Speech API unavailable in this environment');
    }

    const sub = await runSubcommand(bridge, args);
    if (sub) return sub;

    const parsed = parseSayArgs(args);
    if ('exitCode' in parsed) return parsed;
    if (!parsed.text) return sayHelp();
    if (!parsed.lang) return fail('-l language tag is required');

    let resolvedVoice: string | undefined;
    if (parsed.voiceName) {
      const { resolved, error } = await resolveVoiceName(bridge, parsed.voiceName);
      if (error) return error;
      resolvedVoice = resolved;
    }

    const req = { text: parsed.text, lang: parsed.lang, voice: resolvedVoice, rate: parsed.rate };
    return bridge.local ? speakLocal(req) : speakViaRpc(bridge, req);
  });
}
