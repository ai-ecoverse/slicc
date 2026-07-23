import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { VirtualFS } from '../../src/fs/index.js';
import type { LickEvent } from '../../src/scoops/lick-manager.js';
import {
  buildJshNodeCommand,
  type CaptureScreenResult,
  JSH_RESULT_PREFIX,
  parseJshResult,
  runJshOp,
  SprinkleBridge,
  type SprinkleExecResult,
} from '../../src/ui/sprinkle-bridge.js';

/** Build a worker-shell stdout payload carrying a successful jsh result. */
function jshOk(value: unknown): SprinkleExecResult {
  return {
    stdout: JSH_RESULT_PREFIX + JSON.stringify({ ok: true, value }),
    stderr: '',
    exitCode: 0,
  };
}

/** Build a worker-shell stdout payload carrying a failed jsh result. */
function jshErr(message: string): SprinkleExecResult {
  return {
    stdout: JSH_RESULT_PREFIX + JSON.stringify({ ok: false, error: message }),
    stderr: '',
    exitCode: 0,
  };
}

describe('SprinkleBridge', () => {
  let bridge: SprinkleBridge;
  let lickHandler: (event: LickEvent) => void;
  let lickHandlerMock: ReturnType<typeof vi.fn>;
  let closeHandler: (name: string) => void;
  let closeHandlerMock: ReturnType<typeof vi.fn>;
  let minimizeHandlerMock: Mock<(name: string) => void>;
  let stopConeHandlerMock: Mock<() => void>;
  let attachImageHandlerMock: Mock<(base64: string, name?: string, mimeType?: string) => void>;
  let captureScreenHandlerMock: Mock<() => Promise<CaptureScreenResult>>;
  let mockFs: VirtualFS;

  beforeEach(() => {
    lickHandlerMock = vi.fn();
    lickHandler = lickHandlerMock as unknown as (event: LickEvent) => void;
    closeHandlerMock = vi.fn();
    closeHandler = closeHandlerMock as unknown as (name: string) => void;
    minimizeHandlerMock = vi.fn<(name: string) => void>();
    stopConeHandlerMock = vi.fn<() => void>();
    attachImageHandlerMock = vi.fn<(base64: string, name?: string, mimeType?: string) => void>();
    captureScreenHandlerMock = vi.fn<() => Promise<CaptureScreenResult>>().mockResolvedValue({
      base64: 'defaultBase64',
      width: 800,
      height: 600,
      mimeType: 'image/png',
    });
    mockFs = {
      readFile: vi.fn().mockResolvedValue('file content'),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readDir: vi.fn().mockResolvedValue([
        { name: 'test.txt', type: 'file' },
        { name: 'subdir', type: 'directory' },
      ]),
      exists: vi.fn().mockResolvedValue(true),
      stat: vi.fn().mockResolvedValue({ type: 'file', size: 42, mtime: 1000, ctime: 1000 }),
      mkdir: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
    } as unknown as VirtualFS;
    bridge = new SprinkleBridge(
      mockFs,
      lickHandler,
      closeHandler,
      minimizeHandlerMock,
      stopConeHandlerMock,
      attachImageHandlerMock,
      captureScreenHandlerMock
    );
  });

  it('creates an API with the sprinkle name', () => {
    const api = bridge.createAPI('test-sprinkle');
    expect(api.name).toBe('test-sprinkle');
  });

  it('lick() sends a LickEvent through the handler', () => {
    const api = bridge.createAPI('test-sprinkle');
    api.lick({ action: 'click', data: { id: 42 } });

    expect(lickHandlerMock).toHaveBeenCalledTimes(1);
    const event: LickEvent = lickHandlerMock.mock.calls[0][0];
    expect(event.type).toBe('sprinkle');
    expect(event.sprinkleName).toBe('test-sprinkle');
    expect(event.body).toEqual({ action: 'click', data: { id: 42 } });
  });

  it('lick() accepts a plain string as action shorthand', () => {
    const api = bridge.createAPI('test-sprinkle');
    api.lick('add-year');

    expect(lickHandlerMock).toHaveBeenCalledTimes(1);
    const event: LickEvent = lickHandlerMock.mock.calls[0][0];
    expect(event.type).toBe('sprinkle');
    expect(event.body).toEqual({ action: 'add-year', data: undefined });
  });

  it('close() calls the close handler', () => {
    const api = bridge.createAPI('test-sprinkle');
    api.close();
    expect(closeHandlerMock).toHaveBeenCalledWith('test-sprinkle');
  });

  it('minimize() calls the minimize handler with the sprinkle name', () => {
    const api = bridge.createAPI('test-sprinkle');
    api.minimize();
    expect(minimizeHandlerMock).toHaveBeenCalledWith('test-sprinkle');
  });

  it('readFile() delegates to VFS', async () => {
    const api = bridge.createAPI('test-sprinkle');
    const content = await api.readFile('/test.txt');
    expect(content).toBe('file content');
    expect(mockFs.readFile).toHaveBeenCalledWith('/test.txt', { encoding: 'utf-8' });
  });

  it('writeFile() delegates to VFS', async () => {
    const api = bridge.createAPI('test-sprinkle');
    await api.writeFile('/out.txt', 'hello');
    expect(mockFs.writeFile).toHaveBeenCalledWith('/out.txt', 'hello');
  });

  it('readDir() delegates to VFS and returns mapped entries', async () => {
    const api = bridge.createAPI('test-sprinkle');
    const entries = await api.readDir('/workspace');
    expect(entries).toEqual([
      { name: 'test.txt', type: 'file' },
      { name: 'subdir', type: 'directory' },
    ]);
    expect(mockFs.readDir).toHaveBeenCalledWith('/workspace');
  });

  it('exists() delegates to VFS', async () => {
    const api = bridge.createAPI('test-sprinkle');
    const result = await api.exists('/workspace/file.txt');
    expect(result).toBe(true);
    expect(mockFs.exists).toHaveBeenCalledWith('/workspace/file.txt');
  });

  it('stat() delegates to VFS and returns {type, size}', async () => {
    const api = bridge.createAPI('test-sprinkle');
    const result = await api.stat('/workspace/file.txt');
    expect(result).toEqual({ type: 'file', size: 42 });
    expect(mockFs.stat).toHaveBeenCalledWith('/workspace/file.txt');
  });

  it('mkdir() delegates to VFS with recursive: true', async () => {
    const api = bridge.createAPI('test-sprinkle');
    await api.mkdir('/workspace/deep/dir');
    expect(mockFs.mkdir).toHaveBeenCalledWith('/workspace/deep/dir', { recursive: true });
  });

  it('rm() delegates to VFS', async () => {
    const api = bridge.createAPI('test-sprinkle');
    await api.rm('/workspace/old.txt');
    expect(mockFs.rm).toHaveBeenCalledWith('/workspace/old.txt');
  });

  it('screenshot() returns empty string when no container is set', async () => {
    const api = bridge.createAPI('test-sprinkle');
    // Without _container set, the bridge implementation returns '' immediately
    expect(api._container).toBeUndefined();
    const result = await api.screenshot();
    expect(result).toBe('');
  });

  it('on/off registers and removes update listeners', () => {
    vi.useFakeTimers();
    const api = bridge.createAPI('test-sprinkle');
    const cb = vi.fn();

    api.on('update', cb);
    bridge.pushUpdate('test-sprinkle', { status: 'done' });
    vi.runAllTimers();
    expect(cb).toHaveBeenCalledWith({ status: 'done' });

    api.off('update', cb);
    bridge.pushUpdate('test-sprinkle', { status: 'again' });
    vi.runAllTimers();
    expect(cb).toHaveBeenCalledTimes(1); // not called again
    vi.useRealTimers();
  });

  it('pushUpdate only fires for the correct sprinkle', () => {
    vi.useFakeTimers();
    const api1 = bridge.createAPI('sprinkle-a');
    const api2 = bridge.createAPI('sprinkle-b');
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    api1.on('update', cb1);
    api2.on('update', cb2);

    bridge.pushUpdate('sprinkle-a', 'data-a');
    vi.runAllTimers();
    expect(cb1).toHaveBeenCalledWith('data-a');
    expect(cb2).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('removeSprinkle cleans up all listeners for that sprinkle', () => {
    vi.useFakeTimers();
    const api = bridge.createAPI('test-sprinkle');
    const cb = vi.fn();
    api.on('update', cb);

    bridge.removeSprinkle('test-sprinkle');
    bridge.pushUpdate('test-sprinkle', 'data');
    vi.runAllTimers();
    expect(cb).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('listener errors are silently caught', () => {
    vi.useFakeTimers();
    const api = bridge.createAPI('test-sprinkle');
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();

    api.on('update', bad);
    api.on('update', good);

    expect(() => bridge.pushUpdate('test-sprinkle', 'data')).not.toThrow();
    vi.runAllTimers();
    expect(good).toHaveBeenCalledWith('data');
    vi.useRealTimers();
  });

  it('stopCone() calls the stop-cone handler', () => {
    const api = bridge.createAPI('test-sprinkle');
    api.stopCone();
    expect(stopConeHandlerMock).toHaveBeenCalledTimes(1);
  });

  it('attachImage() calls the attach-image handler with all args', () => {
    const api = bridge.createAPI('test-sprinkle');
    api.attachImage('abc123', 'test.png', 'image/png');
    expect(attachImageHandlerMock).toHaveBeenCalledWith('abc123', 'test.png', 'image/png');
  });

  it('attachImage() calls the handler with optional args undefined', () => {
    const api = bridge.createAPI('test-sprinkle');
    api.attachImage('abc123');
    expect(attachImageHandlerMock).toHaveBeenCalledWith('abc123', undefined, undefined);
  });

  it('exec() returns a clean 127 result when no exec handler is wired', async () => {
    const api = bridge.createAPI('test-sprinkle');
    const result = await api.exec('ls');
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('shell bridge not available');
  });

  it('exec() delegates to the injected exec handler', async () => {
    const execHandler = vi.fn().mockResolvedValue({ stdout: 'hi\n', stderr: '', exitCode: 0 });
    bridge = new SprinkleBridge(
      mockFs,
      lickHandler,
      closeHandler,
      minimizeHandlerMock,
      stopConeHandlerMock,
      attachImageHandlerMock,
      captureScreenHandlerMock,
      execHandler
    );
    const api = bridge.createAPI('test-sprinkle');
    const result = await api.exec('echo hi');
    expect(execHandler).toHaveBeenCalledWith('echo hi');
    expect(result).toEqual({ stdout: 'hi\n', stderr: '', exitCode: 0 });
  });

  it('exec() surfaces a non-zero exit code without throwing', async () => {
    const execHandler = vi.fn().mockResolvedValue({ stdout: '', stderr: 'nope\n', exitCode: 2 });
    bridge = new SprinkleBridge(
      mockFs,
      lickHandler,
      closeHandler,
      minimizeHandlerMock,
      stopConeHandlerMock,
      attachImageHandlerMock,
      captureScreenHandlerMock,
      execHandler
    );
    const api = bridge.createAPI('test-sprinkle');
    const result = await api.exec('false');
    expect(result).toEqual({ stdout: '', stderr: 'nope\n', exitCode: 2 });
  });

  it('exec() catches a handler rejection and returns exitCode 1', async () => {
    const execHandler = vi.fn().mockRejectedValue(new Error('boom'));
    bridge = new SprinkleBridge(
      mockFs,
      lickHandler,
      closeHandler,
      minimizeHandlerMock,
      stopConeHandlerMock,
      attachImageHandlerMock,
      captureScreenHandlerMock,
      execHandler
    );
    const api = bridge.createAPI('test-sprinkle');
    const result = await api.exec('explode');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('boom');
  });

  it('agent() builds the default agent command and returns {stdout, exitCode}', async () => {
    const execHandler = vi.fn().mockResolvedValue({ stdout: 'done\n', stderr: '', exitCode: 0 });
    bridge = new SprinkleBridge(
      mockFs,
      lickHandler,
      closeHandler,
      minimizeHandlerMock,
      stopConeHandlerMock,
      attachImageHandlerMock,
      captureScreenHandlerMock,
      execHandler
    );
    const api = bridge.createAPI('test-sprinkle');
    const result = await api.agent('say hi');
    expect(execHandler).toHaveBeenCalledWith("agent '.' '*' 'say hi'");
    expect(result).toEqual({ stdout: 'done\n', exitCode: 0 });
  });

  it('agent() forwards flags before positionals and quotes values', async () => {
    const execHandler = vi.fn().mockResolvedValue({ stdout: 'ok\n', stderr: '', exitCode: 0 });
    bridge = new SprinkleBridge(
      mockFs,
      lickHandler,
      closeHandler,
      minimizeHandlerMock,
      stopConeHandlerMock,
      attachImageHandlerMock,
      captureScreenHandlerMock,
      execHandler
    );
    const api = bridge.createAPI('test-sprinkle');
    await api.agent("it's me", {
      cwd: '/workspace',
      allowedCommands: 'ls,cat',
      model: 'claude-opus-4-6',
      thinking: 'high',
      readOnly: '/workspace/,/shared/',
    });
    expect(execHandler).toHaveBeenCalledWith(
      "agent --model 'claude-opus-4-6' --thinking 'high' --read-only '/workspace/,/shared/' '/workspace' 'ls,cat' 'it'\\''s me'"
    );
  });

  it('agent() folds stderr into stdout on a non-zero exit', async () => {
    const execHandler = vi
      .fn()
      .mockResolvedValue({ stdout: '', stderr: 'agent: cwd not found\n', exitCode: 1 });
    bridge = new SprinkleBridge(
      mockFs,
      lickHandler,
      closeHandler,
      minimizeHandlerMock,
      stopConeHandlerMock,
      attachImageHandlerMock,
      captureScreenHandlerMock,
      execHandler
    );
    const api = bridge.createAPI('test-sprinkle');
    const result = await api.agent('do thing', { cwd: '/nope' });
    expect(result).toEqual({ stdout: 'agent: cwd not found\n', exitCode: 1 });
  });

  it('agent() returns a clean 127 result when no exec handler is wired', async () => {
    const api = bridge.createAPI('test-sprinkle');
    const result = await api.agent('hello');
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toContain('shell bridge not available');
  });

  it('captureScreen() delegates to the captureScreen handler', async () => {
    const customCaptureScreenHandler = vi.fn().mockResolvedValue({
      base64: 'iVBORw0KGgo=',
      width: 1920,
      height: 1080,
      mimeType: 'image/png',
    });
    bridge = new SprinkleBridge(
      mockFs,
      lickHandler,
      closeHandler,
      minimizeHandlerMock,
      stopConeHandlerMock,
      attachImageHandlerMock,
      customCaptureScreenHandler
    );
    const api = bridge.createAPI('test-sprinkle');
    const result = await api.captureScreen();
    expect(customCaptureScreenHandler).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      base64: 'iVBORw0KGgo=',
      width: 1920,
      height: 1080,
      mimeType: 'image/png',
    });
  });

  describe('Tier 1 jsh globals', () => {
    function bridgeWith(
      execHandler: ReturnType<typeof vi.fn>,
      fsOverride?: Partial<VirtualFS>
    ): SprinkleBridge {
      return new SprinkleBridge(
        { ...mockFs, ...fsOverride } as unknown as VirtualFS,
        lickHandler,
        closeHandler,
        minimizeHandlerMock,
        stopConeHandlerMock,
        attachImageHandlerMock,
        captureScreenHandlerMock,
        execHandler as unknown as (cmd: string) => Promise<SprinkleExecResult>
      );
    }

    it('fetch() routes through a node -e realm command and returns a native Response', async () => {
      const execHandler = vi.fn().mockResolvedValue(
        jshOk({
          ok: true,
          status: 200,
          statusText: 'OK',
          url: 'https://api.example.com/x',
          headers: { 'content-type': 'application/json' },
          bodyBase64: btoa('{"hi":1}'),
        })
      );
      const api = bridgeWith(execHandler).createAPI('s');
      const res = await api.fetch('https://api.example.com/x', { method: 'GET' });
      const cmd = execHandler.mock.calls[0][0] as string;
      expect(cmd.startsWith('node -e ')).toBe(true);
      expect(cmd).toContain('fetch');
      // Realm has no Node Buffer global — base64 must use realm-available
      // primitives (Uint8Array + chunked String.fromCharCode + btoa).
      expect(cmd).not.toContain('Buffer.from');
      expect(cmd).not.toContain('require("buffer")');
      expect(cmd).toContain('new Uint8Array(await r.arrayBuffer())');
      expect(cmd).toContain('String.fromCharCode.apply');
      expect(cmd).toContain('bodyBase64:btoa(bin)');
      expect(res).toBeInstanceOf(Response);
      expect(res.status).toBe(200);
      expect(res.statusText).toBe('OK');
      expect(res.ok).toBe(true);
      expect(res.url).toBe('https://api.example.com/x');
      expect(res.headers).toBeInstanceOf(Headers);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(await res.text()).toBe('{"hi":1}');
    });

    it('fetch() parses JSON via the native Response.json()', async () => {
      const execHandler = vi.fn().mockResolvedValue(
        jshOk({
          ok: true,
          status: 200,
          statusText: 'OK',
          url: 'https://api.example.com/x',
          headers: { 'content-type': 'application/json' },
          bodyBase64: btoa('{"hi":1}'),
        })
      );
      const api = bridgeWith(execHandler).createAPI('s');
      const res = await api.fetch('https://api.example.com/x');
      expect(await res.json()).toEqual({ hi: 1 });
    });

    it('fetch() handles null-body statuses (204) without throwing', async () => {
      const execHandler = vi.fn().mockResolvedValue(
        jshOk({
          ok: true,
          status: 204,
          statusText: 'No Content',
          url: 'https://api.example.com/empty',
          headers: {},
          bodyBase64: btoa(''),
        })
      );
      const api = bridgeWith(execHandler).createAPI('s');
      const res = await api.fetch('https://api.example.com/empty');
      expect(res).toBeInstanceOf(Response);
      expect(res.status).toBe(204);
      expect(res.url).toBe('https://api.example.com/empty');
      expect(await res.text()).toBe('');
    });

    it('fetch() handles out-of-range statuses by shadowing status/ok/statusText', async () => {
      const execHandler = vi.fn().mockResolvedValue(
        jshOk({
          ok: false,
          status: 999,
          statusText: 'Custom',
          url: 'https://api.example.com/weird',
          headers: { 'x-trace': 'abc' },
          bodyBase64: btoa('weird'),
        })
      );
      const api = bridgeWith(execHandler).createAPI('s');
      const res = await api.fetch('https://api.example.com/weird');
      expect(res).toBeInstanceOf(Response);
      expect(res.status).toBe(999);
      expect(res.statusText).toBe('Custom');
      expect(res.ok).toBe(false);
      expect(res.url).toBe('https://api.example.com/weird');
      expect(res.headers.get('x-trace')).toBe('abc');
      expect(await res.text()).toBe('weird');
    });

    it('http.client().get() dispatches a raw http op and returns the structured response', async () => {
      const execHandler = vi
        .fn()
        .mockResolvedValue(jshOk({ status: 201, headers: { etag: 'abc' }, body: { id: 7 } }));
      const api = bridgeWith(execHandler).createAPI('s');
      const res = await api.http.client({ baseUrl: 'https://h' }).get('/items');
      expect(res).toEqual({ status: 201, headers: { etag: 'abc' }, body: { id: 7 } });
      expect(execHandler.mock.calls[0][0]).toContain('http');
    });

    it('browser.findTab() dispatches a browser op (trusted surface)', async () => {
      const execHandler = vi.fn().mockResolvedValue(jshOk({ targetId: 'T1' }));
      const api = bridgeWith(execHandler).createAPI('s');
      const tab = await api.browser.findTab({ domain: 'example.com' });
      expect(tab).toEqual({ targetId: 'T1' });
      expect(execHandler.mock.calls[0][0]).toContain('browser');
    });

    it('exec.spawn() runs the array-form op and returns an exec result', async () => {
      const execHandler = vi
        .fn()
        .mockResolvedValue(jshOk({ stdout: 'ok\n', stderr: '', exitCode: 0 }));
      const api = bridgeWith(execHandler).createAPI('s');
      const res = await api.exec.spawn(['ls', '-la']);
      expect(res).toEqual({ stdout: 'ok\n', stderr: '', exitCode: 0 });
      expect(execHandler.mock.calls[0][0]).toContain('spawn');
    });

    it('exec is still callable as a one-shot string command', async () => {
      const execHandler = vi.fn().mockResolvedValue({ stdout: 'hi\n', stderr: '', exitCode: 0 });
      const api = bridgeWith(execHandler).createAPI('s');
      const res = await api.exec('echo hi');
      expect(execHandler).toHaveBeenCalledWith('echo hi');
      expect(res).toEqual({ stdout: 'hi\n', stderr: '', exitCode: 0 });
    });

    it('fetchToFile() dispatches a fetchToFile op and returns the byte count', async () => {
      const execHandler = vi.fn().mockResolvedValue(jshOk(1234));
      const api = bridgeWith(execHandler).createAPI('s');
      const bytes = await api.fetchToFile('https://h/file.bin', '/workspace/file.bin');
      expect(bytes).toBe(1234);
      expect(execHandler.mock.calls[0][0]).toContain('fetchToFile');
    });

    it('readFileBinary() reads raw bytes from the VFS (no realm round-trip)', async () => {
      const execHandler = vi.fn();
      const data = new Uint8Array([1, 2, 3, 250]);
      const readFile = vi.fn().mockResolvedValue(data);
      const api = bridgeWith(execHandler, { readFile } as Partial<VirtualFS>).createAPI('s');
      const out = await api.readFileBinary('/workspace/bin.dat');
      expect(Array.from(out)).toEqual([1, 2, 3, 250]);
      expect(readFile).toHaveBeenCalledWith('/workspace/bin.dat', { encoding: 'binary' });
      expect(execHandler).not.toHaveBeenCalled();
    });

    it('writeFileBinary() writes raw bytes to the VFS (no realm round-trip)', async () => {
      const execHandler = vi.fn();
      const writeFile = vi.fn().mockResolvedValue(undefined);
      const api = bridgeWith(execHandler, { writeFile } as Partial<VirtualFS>).createAPI('s');
      await api.writeFileBinary('/workspace/out.dat', new Uint8Array([9, 8, 7]));
      expect(writeFile).toHaveBeenCalledTimes(1);
      const [path, bytes] = writeFile.mock.calls[0];
      expect(path).toBe('/workspace/out.dat');
      expect(Array.from(bytes as Uint8Array)).toEqual([9, 8, 7]);
      expect(execHandler).not.toHaveBeenCalled();
    });

    it('rejects when the realm reports a failure', async () => {
      const execHandler = vi.fn().mockResolvedValue(jshErr('boom'));
      const api = bridgeWith(execHandler).createAPI('s');
      await expect(api.fetch('https://h')).rejects.toThrow('boom');
    });
  });
});

describe('jsh node-command helpers', () => {
  it('buildJshNodeCommand embeds the op + args and quotes the script', () => {
    const cmd = buildJshNodeCommand('spawn', [['echo', "it's"]]);
    expect(cmd.startsWith("node -e '")).toBe(true);
    expect(cmd.endsWith("'")).toBe(true);
    expect(cmd).toContain('exec.spawn');
    // The realm awaits only the top-level AsyncFunction body, so the program
    // must use top-level await rather than a detached `(async()=>{…})()`
    // IIFE (the IIFE promise was never awaited → no sentinel on stdout).
    expect(cmd).not.toContain('(async()=>');
    expect(cmd).not.toContain('(async ()=>');
    expect(cmd).not.toContain('})()');
    expect(cmd).toContain('var REQ=');
    expect(cmd).toContain('await exec.spawn');
  });

  it('parseJshResult returns the value behind the sentinel', () => {
    expect(parseJshResult(jshOk({ a: 1 }))).toEqual({ a: 1 });
  });

  it('parseJshResult throws the realm error message on ok:false', () => {
    expect(() => parseJshResult(jshErr('nope'))).toThrow('nope');
  });

  it('parseJshResult throws a clear error when the sentinel is missing', () => {
    expect(() => parseJshResult({ stdout: '', stderr: 'kaboom\n', exitCode: 1 })).toThrow(
      /no result.*kaboom/
    );
  });

  it('runJshOp builds the command, runs it, and parses the result', async () => {
    const exec = vi.fn().mockResolvedValue(jshOk('done'));
    const out = await runJshOp(exec, 'fetchToFile', ['https://h/a', '/a']);
    expect(out).toBe('done');
    expect((exec.mock.calls[0][0] as string).startsWith('node -e ')).toBe(true);
  });
});
