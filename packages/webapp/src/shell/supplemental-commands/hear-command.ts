import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getPanelRpcClient, hasLocalDom } from '../../kernel/panel-rpc.js';
import { detectMimeType } from './shared.js';

type CommandContext = Parameters<Parameters<typeof defineCommand>[1]>[1];
type CommandResult = { stdout: string; stderr: string; exitCode: number };

const RPC_MARGIN_MS = 30_000;

const TRANSCRIBE_RPC_TIMEOUT_MS = 10 * 60_000;

function hearHelp(): CommandResult {
  return {
    stdout:
      'usage: hear [-i file] [-l lang] [-T seconds] [-d deviceId] [--engine name]\n' +
      '       hear --devices | --status | --warmup\n\n' +
      '  Speech recognition: listens on the microphone until you pause, then\n' +
      '  prints the transcript (modeled on the macOS `hear` CLI).\n\n' +
      '  -i file          Transcribe an audio file (wav/mp3/ogg/webm) instead of\n' +
      '                   listening; uses the enhanced on-device model (downloads\n' +
      '                   it on first use)\n' +
      '  -l lang          BCP-47 language tag (default: auto-detect)\n' +
      '  -T seconds       Max listening time (default 30)\n' +
      '  -d deviceId      Microphone device id (see --devices); applies to the\n' +
      '                   enhanced capture path — the built-in recognizer always\n' +
      '                   uses the system default input\n' +
      '  --engine name    builtin | enhanced (default: enhanced when ready)\n' +
      '  --devices        List audio input devices\n' +
      '  --status         Show the enhanced model state (downloading/ready + ETA)\n' +
      '  --warmup         Start the enhanced model download in the background\n',
    stderr: '',
    exitCode: 0,
  };
}

interface HearArgs {
  inputFile: string | null;
  lang: string | undefined;
  timeoutSeconds: number;
  deviceId: string | undefined;
  engine: 'auto' | 'builtin' | 'enhanced';
  devices: boolean;
  status: boolean;
  warmup: boolean;
}

const MODE_FLAGS: Record<string, 'devices' | 'status' | 'warmup'> = {
  '--devices': 'devices',
  '--status': 'status',
  '--warmup': 'warmup',
};

const VALUE_FLAG_HINTS: Record<string, string> = {
  '-i': 'a file path',
  '-l': 'a language tag',
  '-T': 'a timeout in seconds',
  '-d': 'a device id',
  '--engine': 'an engine name',
};

function applyValueFlag(parsed: HearArgs, flag: string, value: string): string | null {
  switch (flag) {
    case '-i':
      parsed.inputFile = value;
      return null;
    case '-l':
      parsed.lang = value;
      return null;
    case '-d':
      parsed.deviceId = value;
      return null;
    case '-T': {
      const seconds = Number.parseFloat(value);
      if (Number.isNaN(seconds) || seconds <= 0 || seconds > 600) {
        return '-T requires a timeout between 0 and 600 seconds';
      }
      parsed.timeoutSeconds = seconds;
      return null;
    }
    case '--engine':
      if (value !== 'builtin' && value !== 'enhanced') {
        return '--engine must be builtin or enhanced';
      }
      parsed.engine = value;
      return null;
    default:
      return `unknown option: ${flag}`;
  }
}

function parseHearArgs(args: string[]): HearArgs | CommandResult {
  const parsed: HearArgs = {
    inputFile: null,
    lang: undefined,
    timeoutSeconds: 30,
    deviceId: undefined,
    engine: 'auto',
    devices: false,
    status: false,
    warmup: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const mode = MODE_FLAGS[arg];
    if (mode) {
      parsed[mode] = true;
      continue;
    }
    if (!(arg in VALUE_FLAG_HINTS)) return fail(`unknown option: ${arg}`);
    const value = i + 1 < args.length ? args[++i] : null;
    if (value == null) return fail(`${arg} requires ${VALUE_FLAG_HINTS[arg]}`);
    const error = applyValueFlag(parsed, arg, value);
    if (error) return fail(error);
  }
  return parsed;
}

interface HearStatusShape {
  state: 'idle' | 'loading' | 'ready' | 'failed';
  loaded?: number;
  total?: number;
  etaSeconds?: number | null;
}

function formatStatus(status: HearStatusShape): string {
  switch (status.state) {
    case 'ready':
      return 'enhanced engine: ready\n';
    case 'failed':
      return 'enhanced engine: failed (re-run hear --warmup to retry)\n';
    case 'idle':
      return 'enhanced engine: not downloaded (run hear --warmup)\n';
    case 'loading': {
      const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
      const progress =
        status.loaded != null && status.total ? ` ${mb(status.loaded)}/${mb(status.total)} MB` : '';
      const eta =
        status.etaSeconds != null && Number.isFinite(status.etaSeconds)
          ? ` · ready in ~${Math.max(1, Math.round(status.etaSeconds))}s`
          : '';
      return `enhanced engine: downloading${progress}${eta}\n`;
    }
  }
}

function fail(message: string): CommandResult {
  return { stdout: '', stderr: `hear: ${message}\n`, exitCode: 1 };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface SpeechBridge {
  local: boolean;
  panelRpc: NonNullable<ReturnType<typeof getPanelRpcClient>> | null;
}

function formatDeviceLines(devices: Array<{ deviceId: string; label: string }>): string {
  const lines = devices.map((d, i) => `${d.deviceId}\t${d.label || `Microphone ${i + 1}`}`);
  return lines.join('\n') + (lines.length ? '\n' : '');
}

async function runDevices(bridge: SpeechBridge): Promise<CommandResult> {
  try {
    if (bridge.local) {
      if (!navigator.mediaDevices?.enumerateDevices) {
        return fail('device enumeration unavailable');
      }
      const all = await navigator.mediaDevices.enumerateDevices();
      const mics = all.filter((d) => d.kind === 'audioinput');
      return { stdout: formatDeviceLines(mics), stderr: '', exitCode: 0 };
    }
    const r = await bridge.panelRpc!.call('enumerate-media-devices', undefined);
    return { stdout: formatDeviceLines(r.audioinputs), stderr: '', exitCode: 0 };
  } catch (err) {
    return fail(errText(err));
  }
}

async function runStatusOrWarmup(bridge: SpeechBridge, warmup: boolean): Promise<CommandResult> {
  try {
    if (bridge.local) {
      const { hearStatus, hearWarmup } = await import('../../speech/hear.js');
      const status = warmup ? hearWarmup() : hearStatus();
      return { stdout: formatStatus(status), stderr: '', exitCode: 0 };
    }
    const status = warmup
      ? await bridge.panelRpc!.call('hear-warmup', undefined)
      : await bridge.panelRpc!.call('hear-status', undefined);
    return { stdout: formatStatus(status), stderr: '', exitCode: 0 };
  } catch (err) {
    return fail(errText(err));
  }
}

async function runTranscribeFile(
  bridge: SpeechBridge,
  parsed: HearArgs,
  ctx: CommandContext
): Promise<CommandResult> {
  const inputFile = parsed.inputFile!;
  const fullPath = ctx.fs.resolvePath(ctx.cwd, inputFile);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await ctx.fs.readFileBuffer(fullPath));
  } catch {
    return fail(`cannot open ${inputFile}: No such file`);
  }
  const mimeType = detectMimeType(fullPath);
  if (!mimeType.startsWith('audio/') && !mimeType.startsWith('video/')) {
    return fail(`${inputFile} is not an audio file`);
  }
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  try {
    const result = bridge.local
      ? await (await import('../../speech/hear.js')).hearTranscribe(buf, parsed.lang)
      : await bridge.panelRpc!.call(
          'hear-transcribe',
          { bytes: buf, lang: parsed.lang },
          { timeoutMs: TRANSCRIBE_RPC_TIMEOUT_MS }
        );
    return { stdout: result.transcript + '\n', stderr: '', exitCode: 0 };
  } catch (err) {
    return fail(`transcription failed: ${errText(err)}`);
  }
}

async function runCapture(bridge: SpeechBridge, parsed: HearArgs): Promise<CommandResult> {
  const timeoutMs = Math.round(parsed.timeoutSeconds * 1000);
  try {
    const payload = {
      lang: parsed.lang,
      timeoutMs,
      deviceId: parsed.deviceId,
      engine: parsed.engine,
    };
    const result = bridge.local
      ? await (await import('../../speech/hear.js')).hearCapture(payload)
      : await bridge.panelRpc!.call('hear-capture', payload, {
          timeoutMs: timeoutMs + RPC_MARGIN_MS,
        });
    if (!result.transcript) {
      return { stdout: '', stderr: 'hear: no speech detected\n', exitCode: 1 };
    }
    return { stdout: result.transcript + '\n', stderr: '', exitCode: 0 };
  } catch (err) {
    return fail(errText(err));
  }
}

export function createHearCommand(): Command {
  return defineCommand('hear', async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) {
      return hearHelp();
    }
    const parsed = parseHearArgs(args);
    if ('exitCode' in parsed) return parsed;

    const bridge: SpeechBridge = { local: hasLocalDom(), panelRpc: getPanelRpcClient() };
    if (!bridge.local && !bridge.panelRpc) {
      return fail('speech recognition unavailable in this environment');
    }

    if (parsed.devices) return runDevices(bridge);
    if (parsed.status || parsed.warmup) return runStatusOrWarmup(bridge, parsed.warmup);
    if (parsed.inputFile) return runTranscribeFile(bridge, parsed, ctx);
    return runCapture(bridge, parsed);
  });
}
