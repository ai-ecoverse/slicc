/**
 * Follower-desktop computer. Frames and input ride tray-exec (`ssh` /
 * `SshExec`); this adapter stays DOM-free and out of the worker first-load
 * graph (lazy `await import` from `computer add ssh`).
 */

import type {
  ComputerCapabilities,
  ComputerDescriptor,
  ComputerFrame,
  ComputerInputEvent,
} from '@slicc/shared-ts';
import type { ComputerBackend, ComputerScreenshotOpts } from '../backend.js';
import {
  bytesFromBase64,
  fitComputerFrame,
  jpegSize,
  pngBytesToJpeg,
  pngSize,
} from '../encode-frame.js';
import { applyPointerToEvents, createPointer } from '../pointer.js';
import { type SshInputTool, shQuote, sshInputCommands } from './ssh-input.js';

/** Tray-exec stdout is buffered whole; keep each base64 piece under this. */
export const SSH_B64_CHUNK = 3 * 1024 * 1024;

export type SshExecResult = { stdout: string; stderr: string; exitCode: number };
export type SshExec = (command: string, opts?: { timeoutMs?: number }) => Promise<SshExecResult>;

/** Injected native capture/input for a `capabilities.computer` follower. */
export interface NativeComputerChannel {
  capture(opts: {
    fps?: number;
    maxWidth?: number;
    /** 1-based OS display index on the follower; omitted means its main display. */
    display?: number;
    watch?: boolean;
  }): Promise<{
    bytes: Uint8Array;
    mime: 'image/jpeg';
    width: number;
    height: number;
    nativeWidth: number;
    nativeHeight: number;
  }>;
  unwatch(): void;
  /** `display` names the screen the events target — the same index `capture` used. */
  input(events: ComputerInputEvent[], opts?: { display?: number }): Promise<void> | void;
}

export type SshPlatform = 'darwin' | 'linux' | 'unknown';
export type SshCaptureTool = 'screencapture' | 'grim' | 'scrot' | 'import' | 'simctl';
export type { SshInputTool };

export interface SshProbe {
  platform: SshPlatform;
  tools: string[];
  capture: SshCaptureTool | null;
  input: SshInputTool;
  sim?: string;
}

export interface SshComputerOptions {
  runtimeId: string;
  title: string;
  probe: SshProbe;
  inputAllowed: boolean;
  sim?: string;
  /**
   * 1-based OS display index for native capture (`computer add ssh --display`).
   * Omitted means the follower's main display.
   */
  display?: number;
  native?: NativeComputerChannel;
}

export function sshComputerId(runtimeId: string, sim?: string, display?: number): string {
  if (sim) return `ssh:${runtimeId}:sim:${sim}`;
  // Only a non-default pick widens the id, so registering one display keeps the
  // plain `ssh:<runtime>` name while a second display can coexist beside it.
  return display ? `ssh:${runtimeId}:display:${display}` : `ssh:${runtimeId}`;
}

export function sshTempBase(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]+/gu, '_');
  return `/tmp/slicc-${safe}`;
}

export const SSH_PROBE_SCRIPT = `u=$(uname -s 2>/dev/null || echo unknown)
tools=""
for t in screencapture cliclick grim scrot import xdotool ydotool idb xcrun; do
  command -v "$t" >/dev/null 2>&1 && tools="$tools$t "
done
printf 'SLICC_SSH_PROBE %s %s\\n' "$u" "$tools"`;

function platformOf(uname: string): SshPlatform {
  const u = uname.toLowerCase();
  if (u.startsWith('darwin')) return 'darwin';
  if (u.startsWith('linux')) return 'linux';
  return 'unknown';
}

const CAPTURE_PREF: SshCaptureTool[] = ['screencapture', 'grim', 'scrot', 'import'];
const INPUT_PREF: SshInputTool[] = ['cliclick', 'xdotool', 'ydotool'];

function firstTool<T extends string>(tools: string[], pref: T[]): T | null {
  for (const name of pref) {
    if (tools.includes(name)) return name;
  }
  return null;
}

export function parseSshProbe(stdout: string): SshProbe | { error: string } {
  const match = /SLICC_SSH_PROBE\s+(\S+)\s*(.*)/u.exec(stdout);
  if (!match) return { error: 'probe: unexpected follower output' };
  const tools = match[2].trim().split(/\s+/u).filter(Boolean);
  return {
    platform: platformOf(match[1]),
    tools,
    capture: firstTool(tools, CAPTURE_PREF),
    input: firstTool(tools, INPUT_PREF) ?? 'none',
  };
}

export async function probeSsh(exec: SshExec, sim?: string): Promise<SshProbe> {
  const result = await exec(SSH_PROBE_SCRIPT, { timeoutMs: 15_000 });
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || 'probe failed').trim());
  }
  const parsed = parseSshProbe(result.stdout);
  if ('error' in parsed) throw new Error(parsed.error);
  if (sim) {
    if (parsed.platform !== 'darwin') throw new Error('--sim requires a Mac follower');
    if (!parsed.tools.includes('xcrun')) throw new Error('xcrun not found on the follower');
    const listed = await exec(
      `xcrun simctl list devices 2>/dev/null | grep -F ${shQuote(sim)} || true`,
      { timeoutMs: 15_000 }
    );
    if (!listed.stdout.includes(sim)) throw new Error(`simulator '${sim}' not found`);
    return {
      ...parsed,
      capture: 'simctl',
      input: parsed.tools.includes('idb') ? 'idb' : 'none',
      sim,
    };
  }
  if (!parsed.capture) {
    throw new Error('no screenshot tool (need screencapture, grim, scrot, or import)');
  }
  return parsed;
}

export function sshB64ChunkCommands(
  b64Path: string,
  nchars: number,
  chunk = SSH_B64_CHUNK
): string[] {
  if (nchars <= 0) return [];
  const n = Math.ceil(nchars / chunk);
  const cmds: string[] = [];
  for (let i = 0; i < n; i++) {
    cmds.push(`dd if=${shQuote(b64Path)} bs=${chunk} skip=${i} count=1 2>/dev/null`);
  }
  return cmds;
}

export function sshCaptureScript(opts: {
  capture: SshCaptureTool;
  tmpBase: string;
  udid?: string;
}): string {
  const png = shQuote(`${opts.tmpBase}.png`);
  const b64 = shQuote(`${opts.tmpBase}.b64`);
  let capture: string;
  switch (opts.capture) {
    case 'screencapture':
      capture = `screencapture -x ${png}`;
      break;
    case 'grim':
      capture = `grim ${png}`;
      break;
    case 'scrot':
      capture = `scrot ${png}`;
      break;
    case 'import':
      capture = `import -window root ${png}`;
      break;
    case 'simctl':
      capture = `xcrun simctl io ${shQuote(opts.udid ?? '')} screenshot ${png}`;
      break;
    default: {
      const _never: never = opts.capture;
      void _never;
      capture = `false`;
    }
  }
  return `${capture} && base64 < ${png} | tr -d '\\n' > ${b64} && n=$(wc -c < ${b64} | tr -d ' ') && printf 'SLICC_SSH_B64 %s\\n' "$n"`;
}

export function sshCapabilities(
  probe: SshProbe,
  inputAllowed: boolean,
  native = false
): ComputerCapabilities {
  const canType = inputAllowed && (probe.input !== 'none' || native);
  const mouse: ComputerCapabilities['mouse'] = !canType
    ? 'none'
    : probe.input === 'idb'
      ? 'touch'
      : 'absolute';
  return {
    screenshot: true,
    text: false,
    frames: 'poll',
    keyboard: canType,
    mouse,
    scroll: canType && (native || probe.input !== 'cliclick'),
    exec: false,
    inputAllowed: canType,
  };
}

function parseB64Length(stdout: string): number {
  const match = /SLICC_SSH_B64\s+(\d+)/u.exec(stdout);
  return match ? Number(match[1]) : Number.NaN;
}

export class SshComputerBackend implements ComputerBackend {
  private seq = 0;
  private size: { width: number; height: number } | null = null;
  private readonly pointer = createPointer();
  private readonly tmpBase: string;
  readonly runtimeId: string;
  readonly sim?: string;
  readonly display?: number;
  private readonly probe: SshProbe;
  private readonly inputAllowed: boolean;
  private readonly title: string;
  private readonly native?: NativeComputerChannel;

  constructor(
    private readonly sshExec: SshExec,
    opts: SshComputerOptions
  ) {
    this.runtimeId = opts.runtimeId;
    this.sim = opts.sim;
    this.display = opts.display;
    this.probe = opts.probe;
    this.native = opts.native;
    this.inputAllowed = opts.inputAllowed && (opts.probe.input !== 'none' || !!opts.native);
    this.title = opts.title;
    this.tmpBase = sshTempBase(sshComputerId(opts.runtimeId, opts.sim, opts.display));
  }

  describe(): ComputerDescriptor {
    const caps = sshCapabilities(this.probe, this.inputAllowed, !!this.native);
    return {
      id: sshComputerId(this.runtimeId, this.sim, this.display),
      kind: 'ssh',
      title: this.title,
      size: this.size,
      state: 'live',
      capabilities: caps,
      pid: null,
      ...(this.sim ? { softKeys: [{ label: 'Home', keysym: 'Home' }] } : {}),
    };
  }

  async screenshot(opts: ComputerScreenshotOpts): Promise<ComputerFrame> {
    if (this.native) {
      const shot = await this.native.capture({
        fps: 2,
        maxWidth: opts.maxWidth,
        display: this.display,
        watch: false,
      });
      this.seq += 1;
      let frame: ComputerFrame = {
        seq: this.seq,
        mime: shot.mime,
        width: shot.width,
        height: shot.height,
        bytes: shot.bytes,
      };
      if (opts.maxWidth) frame = await fitComputerFrame(frame, opts.maxWidth);
      this.size = { width: shot.nativeWidth, height: shot.nativeHeight };
      return frame;
    }
    if (!this.probe.capture) throw new Error('no screenshot tool on the follower');
    const script = sshCaptureScript({
      capture: this.probe.capture,
      tmpBase: this.tmpBase,
      udid: this.sim,
    });
    const cap = await this.sshExec(script, { timeoutMs: 60_000 });
    if (cap.exitCode !== 0) {
      throw new Error((cap.stderr || cap.stdout || 'screenshot failed').trim());
    }
    const nchars = parseB64Length(cap.stdout);
    if (!Number.isFinite(nchars) || nchars <= 0) throw new Error('empty screenshot from follower');
    const parts: string[] = [];
    for (const cmd of sshB64ChunkCommands(`${this.tmpBase}.b64`, nchars)) {
      const chunk = await this.sshExec(cmd, { timeoutMs: 30_000 });
      if (chunk.exitCode !== 0) {
        throw new Error((chunk.stderr || 'screenshot chunk failed').trim());
      }
      parts.push(chunk.stdout.replace(/\s+/gu, ''));
    }
    const raw = bytesFromBase64(parts.join(''));
    const png = pngSize(raw);
    const jpg = jpegSize(raw);
    const native = png ?? jpg;
    if (!native) throw new Error('follower screenshot was not PNG or JPEG');
    let bytes = raw;
    let mime: ComputerFrame['mime'] = png ? 'image/png' : 'image/jpeg';
    if (opts.format === 'jpeg' && png) {
      bytes = await pngBytesToJpeg(raw);
      mime = 'image/jpeg';
    }
    this.seq += 1;
    let frame: ComputerFrame = {
      seq: this.seq,
      mime,
      width: native.width,
      height: native.height,
      bytes,
    };
    if (opts.maxWidth) frame = await fitComputerFrame(frame, opts.maxWidth);
    this.size = { width: native.width, height: native.height };
    return frame;
  }

  async input(events: ComputerInputEvent[]): Promise<void> {
    if (!this.inputAllowed) throw new Error('input is not allowed');
    const filled = applyPointerToEvents(this.pointer, events);
    if (this.native) {
      await this.native.input(filled, { display: this.display });
      return;
    }
    for (const event of filled) {
      const commands = sshInputCommands(event, this.probe.input, this.sim);
      for (const command of commands) {
        const result = await this.sshExec(command, { timeoutMs: 15_000 });
        if (result.exitCode !== 0) {
          throw new Error((result.stderr || result.stdout || `input failed: ${command}`).trim());
        }
      }
    }
  }

  async close(): Promise<void> {
    this.native?.unwatch();
    if (!this.probe.capture) return;
    try {
      await this.sshExec(
        `rm -f ${shQuote(`${this.tmpBase}.png`)} ${shQuote(`${this.tmpBase}.b64`)}`,
        {
          timeoutMs: 5_000,
        }
      );
    } catch {
      // best-effort temp cleanup
    }
  }
}
