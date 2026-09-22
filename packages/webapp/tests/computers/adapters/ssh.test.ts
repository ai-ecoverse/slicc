import type { ComputerFrame } from '@slicc/shared-ts';
import { describe, expect, it, vi } from 'vitest';
import {
  parseSshProbe,
  probeSsh,
  SSH_B64_CHUNK,
  SshComputerBackend,
  sshB64ChunkCommands,
  sshCaptureScript,
  sshComputerId,
  sshTempBase,
} from '../../../src/computers/adapters/ssh.js';
import { shQuote, sshInputCommands } from '../../../src/computers/adapters/ssh-input.js';
import { base64FromBytes } from '../../../src/computers/encode-frame.js';
import { DECODABLE_PNG } from '../../../src/computers/frame-bytes.js';
import { mapPoint, scaleFromEncoded, toLastShot } from '../../../src/computers/scale.js';

vi.mock('../../../src/computers/encode-frame.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/computers/encode-frame.js')>();
  return {
    ...actual,
    async fitComputerFrame(frame: ComputerFrame, maxWidth: number) {
      if (!maxWidth || frame.width <= maxWidth) return frame;
      const scale = maxWidth / frame.width;
      return {
        seq: frame.seq,
        mime: frame.mime,
        width: Math.max(1, Math.round(frame.width * scale)),
        height: Math.max(1, Math.round(frame.height * scale)),
        bytes: frame.bytes,
      };
    },
  };
});

function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 };
}

function pngWithSize(width: number, height: number): Uint8Array {
  const bytes = DECODABLE_PNG.slice();
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return bytes;
}

describe('ssh adapter helpers', () => {
  it('builds namespaced ids and temp paths', () => {
    expect(sshComputerId('follower-abc')).toBe('ssh:follower-abc');
    expect(sshComputerId('follower-abc', 'UDID-1')).toBe('ssh:follower-abc:sim:UDID-1');
    expect(sshTempBase('ssh:follower-abc')).toBe('/tmp/slicc-ssh_follower-abc');
  });

  it('parses a Darwin probe and prefers screencapture+cliclick', () => {
    const probe = parseSshProbe('noise\nSLICC_SSH_PROBE Darwin screencapture cliclick xcrun \n');
    expect(probe).toMatchObject({
      platform: 'darwin',
      capture: 'screencapture',
      input: 'cliclick',
    });
  });

  it('parses a Linux probe and prefers grim+xdotool', () => {
    const probe = parseSshProbe('SLICC_SSH_PROBE Linux grim scrot xdotool ydotool');
    expect(probe).toMatchObject({
      platform: 'linux',
      capture: 'grim',
      input: 'xdotool',
    });
  });

  it('splits base64 into ≤3 MiB dd chunks', () => {
    expect(SSH_B64_CHUNK).toBe(3 * 1024 * 1024);
    const cmds = sshB64ChunkCommands('/tmp/shot.b64', 10, 4);
    expect(cmds).toHaveLength(3);
    expect(cmds[0]).toContain('skip=0');
    expect(cmds[1]).toContain('bs=4');
    expect(cmds[2]).toContain('skip=2');
  });

  it('captures with screencapture -x then prints SLICC_SSH_B64', () => {
    const script = sshCaptureScript({ capture: 'screencapture', tmpBase: '/tmp/s' });
    expect(script).toContain('screencapture -x');
    expect(script).toContain('SLICC_SSH_B64');
  });
});

describe('ssh probe', () => {
  it('promotes --sim to simctl+idb on Darwin with xcrun', async () => {
    const exec = vi.fn(async (command: string) => {
      if (command.includes('SLICC_SSH_PROBE')) {
        return ok('SLICC_SSH_PROBE Darwin screencapture cliclick xcrun idb \n');
      }
      return ok('    iPhone 16 (UDID-1) (Booted)\n');
    });
    const probe = await probeSsh(exec, 'UDID-1');
    expect(probe).toMatchObject({ capture: 'simctl', input: 'idb', sim: 'UDID-1' });
  });

  it('refuses --sim on Linux', async () => {
    const exec = vi.fn(async () => ok('SLICC_SSH_PROBE Linux grim xdotool\n'));
    await expect(probeSsh(exec, 'UDID-1')).rejects.toThrow('--sim requires a Mac follower');
  });
});

describe('ssh backend', () => {
  it('reassembles chunked PNG frames and stays view-only without input', async () => {
    const b64 = base64FromBytes(DECODABLE_PNG);
    const exec = vi.fn(async (command: string) => {
      if (command.includes('screencapture') || command.includes('SLICC_SSH_B64')) {
        return ok(`SLICC_SSH_B64 ${b64.length}\n`);
      }
      if (command.startsWith('dd ')) return ok(b64);
      if (command.startsWith('rm ')) return ok('');
      return ok('');
    });
    const backend = new SshComputerBackend(exec, {
      runtimeId: 'follower-abc',
      title: 'desk',
      probe: {
        platform: 'darwin',
        tools: ['screencapture', 'cliclick'],
        capture: 'screencapture',
        input: 'cliclick',
      },
      inputAllowed: false,
    });
    const d = backend.describe();
    expect(d).toMatchObject({
      id: 'ssh:follower-abc',
      kind: 'ssh',
      capabilities: { inputAllowed: false, keyboard: false, mouse: 'none' },
    });
    const frame = await backend.screenshot({ format: 'jpeg', maxWidth: 768 });
    expect(frame.seq).toBe(1);
    expect(frame.width).toBe(1);
    expect(frame.height).toBe(1);
    expect(exec.mock.calls.some((c) => String(c[0]).startsWith('dd '))).toBe(true);
    await expect(
      backend.input([{ type: 'click', button: 1, count: 1, x: 1, y: 2 }])
    ).rejects.toThrow('input is not allowed');
    await backend.close();
  });

  it('emits cliclick after --allow-input', async () => {
    const exec = vi.fn(async () => ok(''));
    const backend = new SshComputerBackend(exec, {
      runtimeId: 'follower-abc',
      title: 'desk',
      probe: {
        platform: 'darwin',
        tools: ['screencapture', 'cliclick'],
        capture: 'screencapture',
        input: 'cliclick',
      },
      inputAllowed: true,
    });
    expect(backend.describe().capabilities).toMatchObject({
      inputAllowed: true,
      keyboard: true,
      mouse: 'absolute',
    });
    await backend.input([{ type: 'click', button: 1, count: 1, x: 10, y: 20 }]);
    expect(exec).toHaveBeenCalledWith("cliclick 'c:10,20'", { timeoutMs: 15_000 });
  });

  it('keeps native 1920×1080 after a 768-wide encode so lastShot remaps', async () => {
    const png = pngWithSize(1920, 1080);
    const b64 = base64FromBytes(png);
    const exec = vi.fn(async (command: string) => {
      if (command.includes('screencapture') || command.includes('SLICC_SSH_B64')) {
        return ok(`SLICC_SSH_B64 ${b64.length}\n`);
      }
      if (command.startsWith('dd ')) return ok(b64);
      if (command.startsWith('rm ')) return ok('');
      return ok('');
    });
    const backend = new SshComputerBackend(exec, {
      runtimeId: 'follower-abc',
      title: 'desk',
      probe: {
        platform: 'darwin',
        tools: ['screencapture', 'cliclick'],
        capture: 'screencapture',
        input: 'cliclick',
      },
      inputAllowed: true,
    });
    const frame = await backend.screenshot({ format: 'jpeg', maxWidth: 768 });
    expect(frame.width).toBe(768);
    expect(frame.height).toBe(432);
    expect(backend.describe().size).toEqual({ width: 1920, height: 1080 });
    const mapping = scaleFromEncoded(backend.describe().size!, {
      width: frame.width,
      height: frame.height,
    });
    expect(mapping.scale).toBeCloseTo(768 / 1920);
    expect(mapPoint(384, 216, toLastShot(mapping, 1), false)).toEqual({ x: 960, y: 540 });
  });

  it('prefers native capture and input over tray-exec', async () => {
    const exec = vi.fn(async () => ok(''));
    const capture = vi.fn(async () => ({
      bytes: new Uint8Array([9, 8, 7]),
      mime: 'image/jpeg' as const,
      width: 480,
      height: 270,
      nativeWidth: 1920,
      nativeHeight: 1080,
    }));
    const input = vi.fn();
    const unwatch = vi.fn();
    const backend = new SshComputerBackend(exec, {
      runtimeId: 'sliccstart-computer-1',
      title: 'desk',
      probe: { platform: 'darwin', tools: [], capture: null, input: 'none' },
      inputAllowed: true,
      native: { capture, input, unwatch },
    });
    expect(backend.describe().capabilities).toMatchObject({
      screenshot: true,
      inputAllowed: true,
      keyboard: true,
      mouse: 'absolute',
      scroll: true,
    });
    const frame = await backend.screenshot({ format: 'jpeg', maxWidth: 480 });
    expect(frame).toMatchObject({ mime: 'image/jpeg', width: 480, height: 270 });
    expect(capture).toHaveBeenCalledWith({
      fps: 2,
      maxWidth: 480,
      display: undefined,
      watch: false,
    });
    expect(exec).not.toHaveBeenCalled();
    await backend.input([{ type: 'click', button: 1, count: 1, x: 10, y: 20 }]);
    expect(input).toHaveBeenCalledWith([{ type: 'click', button: 1, count: 1, x: 10, y: 20 }]);
    await backend.close();
    expect(unwatch).toHaveBeenCalled();
  });

  it('carries the picked display into every native capture and into the id', async () => {
    const capture = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'image/jpeg' as const,
      width: 768,
      height: 1365,
      // Pixels of a 2x portrait Studio Display, not its 1440x2560 points.
      nativeWidth: 2880,
      nativeHeight: 5120,
    }));
    const backend = new SshComputerBackend(
      vi.fn(async () => ok('')),
      {
        runtimeId: 'sliccstart-computer-1',
        title: 'desk display 3',
        probe: { platform: 'darwin', tools: [], capture: null, input: 'none' },
        inputAllowed: false,
        display: 3,
        native: { capture, input: vi.fn(), unwatch: vi.fn() },
      }
    );
    expect(backend.describe().id).toBe('ssh:sliccstart-computer-1:display:3');
    await backend.screenshot({ format: 'jpeg', maxWidth: 768 });
    expect(capture).toHaveBeenCalledWith({ fps: 2, maxWidth: 768, display: 3, watch: false });
    expect(backend.describe().size).toEqual({ width: 2880, height: 5120 });
  });

  it('keeps the plain id for the default display so one registration is unchanged', () => {
    expect(sshComputerId('rt')).toBe('ssh:rt');
    expect(sshComputerId('rt', undefined, 2)).toBe('ssh:rt:display:2');
    expect(sshComputerId('rt', 'UDID', 2)).toBe('ssh:rt:sim:UDID');
  });
});

describe('ssh input emitters', () => {
  it('maps click/key/text onto xdotool and idb', () => {
    expect(sshInputCommands({ type: 'click', button: 1, count: 1, x: 4, y: 5 }, 'xdotool')[1]).toBe(
      "xdotool click --repeat '1' '1'"
    );
    expect(sshInputCommands({ type: 'key', keysym: 'Return' }, 'xdotool')).toEqual([
      "xdotool key 'Return'",
    ]);
    expect(sshInputCommands({ type: 'text', text: 'hi' }, 'cliclick')[0]).toContain('t:hi');
    expect(
      sshInputCommands({ type: 'click', button: 1, count: 1, x: 1, y: 2 }, 'idb', 'UDID')[0]
    ).toContain("idb ui tap '1' '2'");
  });

  it('preserves cliclick middle and right press/release prefixes', () => {
    expect(
      sshInputCommands({ type: 'button', button: 2, down: true, x: 1, y: 2 }, 'cliclick')
    ).toEqual(["cliclick 'md:1,2'"]);
    expect(
      sshInputCommands({ type: 'button', button: 2, down: false, x: 1, y: 2 }, 'cliclick')
    ).toEqual(["cliclick 'mu:1,2'"]);
    expect(
      sshInputCommands({ type: 'button', button: 3, down: true, x: 3, y: 4 }, 'cliclick')
    ).toEqual(["cliclick 'rd:3,4'"]);
    expect(
      sshInputCommands({ type: 'button', button: 3, down: false, x: 3, y: 4 }, 'cliclick')
    ).toEqual(["cliclick 'ru:3,4'"]);
    expect(
      sshInputCommands({ type: 'button', button: 1, down: true, x: 0, y: 0 }, 'cliclick')
    ).toEqual(["cliclick 'dd:0,0'"]);
  });

  it('quotes hostile chords and type payloads so they cannot break out of sh', () => {
    const hostileText = `'; rm -rf /; echo '`;
    expect(sshInputCommands({ type: 'text', text: hostileText }, 'xdotool')).toEqual([
      `xdotool type -- ${shQuote(hostileText)}`,
    ]);
    expect(sshInputCommands({ type: 'text', text: hostileText }, 'ydotool')).toEqual([
      `ydotool type -- ${shQuote(hostileText)}`,
    ]);
    expect(sshInputCommands({ type: 'text', text: hostileText }, 'cliclick')).toEqual([
      `cliclick ${shQuote(`t:${hostileText}`)}`,
    ]);
    expect(sshInputCommands({ type: 'key', keysym: ';' }, 'xdotool')).toEqual(["xdotool key ';'"]);
    expect(sshInputCommands({ type: 'key', keysym: '`' }, 'xdotool')).toEqual(["xdotool key '`'"]);
    expect(sshInputCommands({ type: 'key', keysym: ';' }, 'cliclick')).toEqual(["cliclick 'kp:;'"]);
    const ydotoolA = sshInputCommands({ type: 'key', keysym: 'a' }, 'ydotool');
    expect(ydotoolA).toHaveLength(1);
    expect(ydotoolA[0]).toMatch(/^ydotool key '/);
    expect(ydotoolA[0]?.endsWith("'")).toBe(true);
  });
});
