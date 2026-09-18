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
import { sshInputCommands } from '../../../src/computers/adapters/ssh-input.js';
import { base64FromBytes } from '../../../src/computers/encode-frame.js';
import { DECODABLE_PNG } from '../../../src/computers/frame-bytes.js';

function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 };
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
    expect(exec).toHaveBeenCalledWith('cliclick c:10,20', { timeoutMs: 15_000 });
  });
});

describe('ssh input emitters', () => {
  it('maps click/key/text onto xdotool and idb', () => {
    expect(sshInputCommands({ type: 'click', button: 1, count: 1, x: 4, y: 5 }, 'xdotool')[1]).toBe(
      'xdotool click --repeat 1 1'
    );
    expect(sshInputCommands({ type: 'key', keysym: 'Return' }, 'xdotool')).toEqual([
      'xdotool key Return',
    ]);
    expect(sshInputCommands({ type: 'text', text: 'hi' }, 'cliclick')[0]).toContain('t:hi');
    expect(
      sshInputCommands({ type: 'click', button: 1, count: 1, x: 1, y: 2 }, 'idb', 'UDID')[0]
    ).toContain('idb ui tap 1 2');
  });
});
