import type { IFileSystem } from 'just-bash';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelRpcClient } from '../../../src/kernel/panel-rpc.js';
import { createHearCommand } from '../../../src/shell/supplemental-commands/hear-command.js';

type RpcCall = ReturnType<typeof vi.fn>;

const globalRef = globalThis as unknown as { __slicc_panelRpc?: PanelRpcClient };

/** Publish a stubbed panel-RPC client (the worker-context bridge seam). */
function installRpc(call: RpcCall): void {
  globalRef.__slicc_panelRpc = { call } as unknown as PanelRpcClient;
}

function createMockCtx(files: Record<string, Uint8Array> = {}) {
  return {
    fs: {
      resolvePath: (cwd: string, p: string) => (p.startsWith('/') ? p : `${cwd}/${p}`),
      readFileBuffer: async (p: string) => {
        const bytes = files[p];
        if (!bytes) throw new Error('ENOENT');
        return bytes.buffer;
      },
    } as unknown as IFileSystem,
    cwd: '/workspace',
    env: new Map<string, string>(),
    stdin: '',
  };
}

const run = (args: string[], ctx = createMockCtx()) => createHearCommand().execute(args, ctx);

afterEach(() => {
  delete globalRef.__slicc_panelRpc;
});

describe('hear command', () => {
  it('has the right name and prints help', async () => {
    expect(createHearCommand().name).toBe('hear');
    const result = await run(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: hear');
    expect(result.stdout).toContain('--warmup');
  });

  it('rejects unknown options and bad timeouts', async () => {
    expect((await run(['--frobnicate'])).exitCode).toBe(1);
    expect((await run(['-T', 'nope'])).stderr).toContain('-T requires a timeout');
    expect((await run(['-T', '-5'])).exitCode).toBe(1);
    expect((await run(['--engine', 'cloud'])).stderr).toContain('builtin or enhanced');
  });

  it('fails cleanly when neither a DOM nor the panel-RPC bridge exists', async () => {
    const result = await run([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unavailable');
  });

  it('lists audio input devices over the bridge (--devices)', async () => {
    const call = vi.fn().mockResolvedValue({
      videoinputs: [{ deviceId: 'cam', label: 'FaceTime' }],
      audioinputs: [
        { deviceId: 'a', label: 'Built-in Microphone' },
        { deviceId: 'b', label: '' },
      ],
    });
    installRpc(call);

    const result = await run(['--devices']);
    expect(call).toHaveBeenCalledWith('enumerate-media-devices', undefined);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('a\tBuilt-in Microphone\nb\tMicrophone 2\n');
  });

  it('reports the enhanced-engine status with progress + ETA (--status)', async () => {
    const call = vi.fn().mockResolvedValue({
      state: 'loading',
      loaded: 52_428_800,
      total: 157_286_400,
      etaSeconds: 42.4,
    });
    installRpc(call);

    const result = await run(['--status']);
    expect(call).toHaveBeenCalledWith('hear-status', undefined);
    expect(result.stdout).toBe('enhanced engine: downloading 50.0/150.0 MB · ready in ~42s\n');
  });

  it('kicks the model download over the bridge (--warmup)', async () => {
    const call = vi.fn().mockResolvedValue({ state: 'idle' });
    installRpc(call);

    const result = await run(['--warmup']);
    expect(call).toHaveBeenCalledWith('hear-warmup', undefined);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('not downloaded');
  });

  it('captures over the bridge, threading lang/timeout/device/engine + a timeout margin', async () => {
    const call = vi.fn().mockResolvedValue({ transcript: 'hello world', engine: 'enhanced' });
    installRpc(call);

    const result = await run(['-l', 'de-DE', '-T', '10', '-d', 'usb', '--engine', 'enhanced']);
    expect(call).toHaveBeenCalledWith(
      'hear-capture',
      { lang: 'de-DE', timeoutMs: 10_000, deviceId: 'usb', engine: 'enhanced' },
      { timeoutMs: 10_000 + 30_000 }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world\n');
  });

  it('exits 1 with "no speech detected" on an empty capture', async () => {
    installRpc(vi.fn().mockResolvedValue({ transcript: '', engine: 'builtin' }));
    const result = await run([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no speech detected');
  });

  it('surfaces capture errors from the bridge', async () => {
    installRpc(vi.fn().mockRejectedValue(new Error('enhanced engine not ready')));
    const result = await run(['--engine', 'enhanced']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('enhanced engine not ready');
  });

  it('transcribes a VFS audio file over the bridge with a long timeout (-i)', async () => {
    const call = vi.fn().mockResolvedValue({ transcript: 'file words', engine: 'enhanced' });
    installRpc(call);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const ctx = createMockCtx({ '/workspace/clip.wav': bytes });

    const result = await run(['-i', 'clip.wav'], ctx);
    expect(call).toHaveBeenCalledWith(
      'hear-transcribe',
      expect.objectContaining({ lang: undefined }),
      { timeoutMs: 600_000 }
    );
    const sent = call.mock.calls[0][1] as { bytes: ArrayBuffer };
    expect(new Uint8Array(sent.bytes)).toEqual(bytes);
    expect(result.stdout).toBe('file words\n');
  });

  it('rejects -i targets that are not audio, and missing files', async () => {
    installRpc(vi.fn());
    const ctx = createMockCtx({ '/workspace/notes.txt': new Uint8Array([1]) });
    expect((await run(['-i', 'notes.txt'], ctx)).stderr).toContain('not an audio file');
    expect((await run(['-i', 'missing.wav'], ctx)).stderr).toContain('No such file');
  });
});
