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

export const SSH_B64_CHUNK = 3 * 1024 * 1024;

export const SSH_NATIVE_FRAME_TIMEOUT_MS = 8_000;

export const SSH_POST_INPUT_FRAME_MS = 2_000;

export type SshExecResult = { stdout: string; stderr: string; exitCode: number };
export type SshExec = (command: string, opts?: { timeoutMs?: number }) => Promise<SshExecResult>;

export interface NativeComputerShot {
  bytes: Uint8Array;
  mime: 'image/jpeg';
  width: number;
  height: number;
  nativeWidth: number;
  nativeHeight: number;
}

export interface NativeComputerChannel {
  capture(opts: {
    fps?: number;
    maxWidth?: number;

    display?: number;
    watch?: boolean;
  }): Promise<NativeComputerShot>;

  onFrame?(
    listener: (shot: NativeComputerShot) => void,
    opts?: { display?: number; onEnd?: (error: Error) => void }
  ): () => void;

  unwatch(opts?: { display?: number }): void;

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

  display?: number;
  native?: NativeComputerChannel;

  frameTimeoutMs?: number;
}

export function sshComputerId(runtimeId: string, sim?: string, display?: number): string {
  if (sim) return `ssh:${runtimeId}:sim:${sim}`;

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

type StreamSink = { onFrame: (frame: ComputerFrame) => void; fps: number; maxWidth?: number };
type StreamWaiter = { settle: (frame: ComputerFrame | null, error?: Error) => void };

export class SshComputerBackend implements ComputerBackend {
  private seq = 0;
  private size: { width: number; height: number } | null = null;
  private readonly pointer = createPointer();
  private readonly tmpBase: string;
  readonly runtimeId: string;
  readonly sim?: string;
  readonly display?: number;

  readonly subscribe?: (
    fps: number,
    onFrame: (frame: ComputerFrame) => void,
    maxWidth?: number
  ) => () => void;
  readonly screenshotServesStream: boolean;
  private readonly probe: SshProbe;
  private readonly inputAllowed: boolean;
  private readonly title: string;
  private readonly native?: NativeComputerChannel;
  private readonly frameTimeoutMs: number;

  private readonly sinks = new Set<StreamSink>();
  private readonly waiters = new Set<StreamWaiter>();
  private offNativeFrame: (() => void) | null = null;
  private lastFrame: ComputerFrame | null = null;

  private stream: { gen: number; fps: number; maxWidth?: number } | null = null;
  private streamGen = 0;

  private freshness: { afterSeq: number; fallback: boolean } | null = null;

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
    this.frameTimeoutMs = opts.frameTimeoutMs ?? SSH_NATIVE_FRAME_TIMEOUT_MS;
    this.tmpBase = sshTempBase(sshComputerId(opts.runtimeId, opts.sim, opts.display));
    this.screenshotServesStream = !!opts.native?.onFrame;
    if (this.screenshotServesStream) {
      this.subscribe = (fps, onFrame, maxWidth) => this.bindSubscribe(fps, onFrame, maxWidth);
    }
  }

  describe(): ComputerDescriptor {
    const caps = sshCapabilities(this.probe, this.inputAllowed, !!this.native);
    return {
      id: sshComputerId(this.runtimeId, this.sim, this.display),
      kind: 'ssh',
      title: this.title,
      size: this.size,
      state: 'live',
      capabilities: this.subscribe ? { ...caps, frames: 'push' } : caps,
      pid: null,
      ...(this.sim ? { softKeys: [{ label: 'Home', keysym: 'Home' }] } : {}),
    };
  }

  private bindSubscribe(
    fps: number,
    onFrame: (frame: ComputerFrame) => void,
    maxWidth?: number
  ): () => void {
    const sink: StreamSink = { onFrame, fps, maxWidth };
    this.sinks.add(sink);
    if (this.lastFrame) onFrame(this.lastFrame);
    this.ensureStream();
    return () => {
      this.sinks.delete(sink);
      if (this.sinks.size === 0) this.stopStream();
    };
  }

  private demand(): { fps: number; maxWidth?: number } {
    let fps = 0;
    let maxWidth: number | undefined = 0;
    for (const sink of this.sinks) {
      fps = Math.max(fps, sink.fps);

      maxWidth =
        maxWidth === undefined || sink.maxWidth === undefined
          ? undefined
          : Math.max(maxWidth, sink.maxWidth);
    }
    return { fps, maxWidth };
  }

  private ensureStream(): void {
    if (this.sinks.size === 0) return;
    const want = this.demand();
    const live = this.stream;
    if (live) {
      const widthOk =
        live.maxWidth === undefined ||
        (want.maxWidth !== undefined && live.maxWidth >= want.maxWidth);
      if (live.fps >= want.fps && widthOk) return;
      this.detachStream(true);
    }
    this.startStream(want.fps, want.maxWidth);
  }

  private startStream(fps: number, maxWidth?: number): void {
    const native = this.native;
    if (!native?.onFrame) return;
    const gen = ++this.streamGen;
    this.stream = { gen, fps, maxWidth };
    this.offNativeFrame = native.onFrame(
      (shot) => {
        if (this.stream?.gen === gen) this.pushNativeFrame(shot);
      },
      {
        display: this.display,

        onEnd: (error) => {
          if (this.stream?.gen === gen) this.stopStream(error, { unwatch: false });
        },
      }
    );

    void native
      .capture({ fps, maxWidth, display: this.display, watch: true })
      .catch((err: unknown) => {
        if (this.stream?.gen !== gen) return;
        this.stopStream(err instanceof Error ? err : new Error(String(err)));
      });
  }

  private detachStream(unwatch: boolean): void {
    this.stream = null;
    this.offNativeFrame?.();
    this.offNativeFrame = null;
    if (unwatch) this.native?.unwatch({ display: this.display });
  }

  private stopStream(error?: Error, opts: { unwatch?: boolean } = {}): void {
    if (!this.stream) return;
    this.detachStream(opts.unwatch ?? true);
    this.freshness = { afterSeq: this.seq, fallback: false };
    const reason = error ?? new Error('native computer stream stopped');
    for (const waiter of [...this.waiters]) waiter.settle(null, reason);
  }

  private pushNativeFrame(shot: NativeComputerShot): void {
    this.seq += 1;
    const frame: ComputerFrame = {
      seq: this.seq,
      mime: shot.mime,
      width: shot.width,
      height: shot.height,
      bytes: shot.bytes,
    };
    this.size = { width: shot.nativeWidth, height: shot.nativeHeight };
    this.lastFrame = frame;
    if (this.freshness && frame.seq > this.freshness.afterSeq) this.freshness = null;
    for (const sink of [...this.sinks]) sink.onFrame(frame);
    for (const waiter of [...this.waiters]) waiter.settle(frame);
  }

  private waitForStreamFrame(
    timeoutMs: number,
    fallback: ComputerFrame | null,
    signal?: AbortSignal
  ): Promise<ComputerFrame> {
    return new Promise((resolve, reject) => {
      const waiter: StreamWaiter = {
        settle: (frame, error) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          this.waiters.delete(waiter);
          if (frame) resolve(frame);
          else reject(error ?? new Error('native computer frame timed out'));
        },
      };
      const timer = setTimeout(() => waiter.settle(fallback), timeoutMs);
      const onAbort = (): void => waiter.settle(null, new Error('screenshot aborted'));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  private async streamScreenshot(signal?: AbortSignal): Promise<ComputerFrame> {
    const last = this.lastFrame;
    const need = this.freshness;
    if (last && (!need || last.seq > need.afterSeq)) return last;
    if (last && need?.fallback) {
      return await this.waitForStreamFrame(
        Math.min(this.frameTimeoutMs, SSH_POST_INPUT_FRAME_MS),
        last,
        signal
      );
    }
    return await this.waitForStreamFrame(this.frameTimeoutMs, null, signal);
  }

  async screenshot(opts: ComputerScreenshotOpts): Promise<ComputerFrame> {
    if (!this.stream && this.sinks.size > 0) this.ensureStream();
    if (this.stream) return await this.streamScreenshot(opts.signal);
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

      if (this.stream) this.freshness = { afterSeq: this.seq, fallback: true };
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
    this.sinks.clear();
    if (this.stream) this.stopStream(new Error('computer closed'));
    else this.native?.unwatch({ display: this.display });
    if (!this.probe.capture) return;
    try {
      await this.sshExec(
        `rm -f ${shQuote(`${this.tmpBase}.png`)} ${shQuote(`${this.tmpBase}.b64`)}`,
        {
          timeoutMs: 5_000,
        }
      );
    } catch {}
  }
}
