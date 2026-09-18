import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getPanelRpcClient } from '../../kernel/panel-rpc.js';
import { bytesAsStdout } from '../just-bash-compat.js';
import { type StdioTtyHints, stdoutIsTty } from './stdio-tty.js';

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutKind?: 'text' | 'bytes';
  stdoutEncoding?: 'binary';
};

interface SayBridge {
  local: boolean;
  panelRpc: ReturnType<typeof getPanelRpcClient>;
}

function sayHelp(): CommandResult {
  return {
    stdout:
      'usage: say [-v voice] [-r rate] [-l lang] [-o file] [--list] <text>\n' +
      '       say --status | --warmup\n\n' +
      '  Speaks the given text. Uses on-device Kokoro voices when the model\n' +
      '  has downloaded (run say --warmup, or it chains after the whisper\n' +
      '  download) for supported languages (English, Spanish, French,\n' +
      '  Italian, Hindi, Portuguese); the Web Speech API otherwise.\n' +
      '  -v voice   Voice name (partial match; kokoro ids like af_heart work\n' +
      '             once the model is ready)\n' +
      '  -r rate    Speech rate (0.1 to 10, default 1)\n' +
      '  -l lang    Language tag (required, BCP 47, e.g. en-US, es-ES, fr-FR)\n' +
      '  -o file    Write 16-bit mono WAV to <file> instead of playing it out\n' +
      '             loud (kokoro-only, English-only; --out is an alias).\n' +
      '             `-o -` writes the same bytes to stdout; a non-TTY stdout\n' +
      '             without -o does too. Web Speech cannot produce bytes.\n' +
      '  --list     List voices with an engine marker ([kokoro] = on-device,\n' +
      '             [web speech] otherwise); kokoro voices lead when ready\n' +
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
  outFile: string | null;
  text: string;
}

const VALUE_FLAG_HINTS: Record<string, string> = {
  '-v': 'a voice name',
  '-r': 'a rate value',
  '-l': 'a language tag',
  '-o': 'an output file path',
  '--out': 'an output file path',
};

function isFlagValue(arg: string | undefined): arg is string {
  return arg != null && (!arg.startsWith('-') || arg === '-');
}

function applySayValueFlag(parsed: SayArgs, flag: string, value: string): string | null {
  switch (flag) {
    case '-v':
      parsed.voiceName = value;
      return null;
    case '-l':
      parsed.lang = value;
      return null;
    case '-o':
    case '--out':
      parsed.outFile = value;
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
  const parsed: SayArgs = { voiceName: null, rate: 1, lang: null, outFile: null, text: '' };
  const textParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg in VALUE_FLAG_HINTS) {
      const next = i + 1 < args.length ? args[i + 1] : undefined;
      const value = isFlagValue(next) ? args[++i] : null;
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

function formatVoiceLine(v: {
  name: string;
  lang: string;
  onDevice: boolean;
  default?: boolean;
}): string {
  const engine = v.onDevice ? '[kokoro]' : '[web speech]';
  return `${v.name} (${v.lang}) ${engine}${v.default ? ' [default]' : ''}`;
}

async function runList(bridge: SayBridge): Promise<CommandResult> {
  if (bridge.local) {
    const { kokoroVoicesIfReady } = await import('../../speech/speak.js');
    const kokoro = kokoroVoicesIfReady().map((v) =>
      formatVoiceLine({ name: v.id, lang: v.lang, onDevice: v.onDevice })
    );
    const voices = await getVoices();
    const web = voices.map((v) =>
      formatVoiceLine({ name: v.name, lang: v.lang, onDevice: false, default: v.default })
    );
    return { stdout: [...kokoro, ...web].join('\n') + '\n', stderr: '', exitCode: 0 };
  }
  try {
    const r = await bridge.panelRpc!.call('list-voices', undefined);
    const lines = r.voices.map((v) => formatVoiceLine(v));
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
  } catch (err) {
    return fail(errText(err));
  }
}

async function listMatchableVoices(bridge: SayBridge): Promise<Array<{ name: string }>> {
  if (!bridge.local) {
    return (await bridge.panelRpc!.call('list-voices', undefined)).voices;
  }
  const { kokoroVoicesIfReady } = await import('../../speech/speak.js');
  const kokoro = kokoroVoicesIfReady().map((v) => ({ name: v.id }));
  const web = (await getVoices()).map((v) => ({ name: v.name }));
  return [...kokoro, ...web];
}

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

async function runSubcommand(bridge: SayBridge, args: string[]): Promise<CommandResult | null> {
  if (args.includes('--list')) return runList(bridge);
  if (args.includes('--status')) return runStatusOrWarmup(bridge, false);
  if (args.includes('--warmup')) return runStatusOrWarmup(bridge, true);
  return null;
}

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

async function speakViaRpc(
  bridge: SayBridge,
  req: { text: string; lang: string; voice?: string; rate: number }
): Promise<CommandResult> {
  try {
    await bridge.panelRpc!.call('speak-text', req, { timeoutMs: 5 * 60_000 });
    return { stdout: '', stderr: '', exitCode: 0 };
  } catch (err) {
    return fail(errText(err));
  }
}

async function synthesizeWavLocal(req: {
  text: string;
  lang: string;
  voice?: string;
  rate: number;
}): Promise<{ bytes: Uint8Array } | CommandResult> {
  const { synthesizeToWav } = await import('../../speech/speak.js');
  try {
    const bytes = await synthesizeToWav(req);
    return { bytes };
  } catch (err) {
    return fail(errText(err));
  }
}

async function synthesizeWavViaRpc(
  bridge: SayBridge,
  req: { text: string; lang: string; voice?: string; rate: number }
): Promise<{ bytes: Uint8Array } | CommandResult> {
  try {
    const r = await bridge.panelRpc!.call(
      'synthesize-to-wav',
      {
        text: req.text,
        lang: req.lang,
        ...(req.voice ? { voice: req.voice } : {}),
        rate: req.rate,
      },
      { timeoutMs: 5 * 60_000 }
    );
    return { bytes: new Uint8Array(r.bytes) };
  } catch (err) {
    return fail(errText(err));
  }
}

interface SayWriteCtx {
  cwd: string;
  fs: {
    resolvePath(base: string, path: string): string;
    writeFile(path: string, bytes: Uint8Array): Promise<void>;
  };
}

async function synthesizeWav(
  bridge: SayBridge,
  req: { text: string; lang: string; voice?: string; rate: number }
): Promise<{ bytes: Uint8Array } | CommandResult> {
  return bridge.local ? synthesizeWavLocal(req) : synthesizeWavViaRpc(bridge, req);
}

async function runSayToStdout(
  bridge: SayBridge,
  req: { text: string; lang: string; voice?: string; rate: number }
): Promise<CommandResult> {
  const result = await synthesizeWav(bridge, req);
  if ('exitCode' in result) return result;
  return { ...bytesAsStdout(result.bytes), stderr: '', exitCode: 0 };
}

async function runSayToFile(
  bridge: SayBridge,
  ctx: SayWriteCtx,
  outFile: string,
  req: { text: string; lang: string; voice?: string; rate: number }
): Promise<CommandResult> {
  const result = await synthesizeWav(bridge, req);
  if ('exitCode' in result) return result;
  const outPath = ctx.fs.resolvePath(ctx.cwd, outFile);
  try {
    await ctx.fs.writeFile(outPath, result.bytes);
  } catch (err) {
    return fail(`failed to write ${outFile}: ${errText(err)}`);
  }
  const sizeKB = Math.max(1, Math.round(result.bytes.byteLength / 1024));
  return { stdout: `wrote ${sizeKB} KB to ${outPath}\n`, stderr: '', exitCode: 0 };
}

async function runSpeakOrWrite(
  bridge: SayBridge,
  ctx: SayWriteCtx & StdioTtyHints,
  parsed: Omit<SayArgs, 'lang'> & { lang: string }
): Promise<CommandResult> {
  let resolvedVoice: string | undefined;
  if (parsed.voiceName) {
    const { resolved, error } = await resolveVoiceName(bridge, parsed.voiceName);
    if (error) return error;
    resolvedVoice = resolved;
  }
  const req = {
    text: parsed.text,
    lang: parsed.lang,
    voice: resolvedVoice,
    rate: parsed.rate,
  };
  const toStdout = parsed.outFile === '-' || (!parsed.outFile && !stdoutIsTty(ctx));
  if (toStdout) return runSayToStdout(bridge, req);
  if (parsed.outFile) return runSayToFile(bridge, ctx, parsed.outFile, req);
  return bridge.local ? speakLocal(req) : speakViaRpc(bridge, req);
}

export function createSayCommand(): Command {
  return defineCommand('say', async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) {
      return sayHelp();
    }

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
    return runSpeakOrWrite(bridge, ctx as SayWriteCtx & StdioTtyHints, {
      ...parsed,
      lang: parsed.lang,
    });
  });
}
