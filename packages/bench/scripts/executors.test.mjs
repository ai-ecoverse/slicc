import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCdpExec, createCliExec, pickPageTarget } from './executors.mjs';

describe('createCliExec', () => {
  it('passes join URL, exec and command to the CLI', async () => {
    const run = vi.fn(async () => ({ stdout: 'ok', stderr: '', status: 0 }));
    const exec = createCliExec({ url: 'https://x/join/t', cli: '/bin/slicc', run });
    expect(await exec('ls /', { stdin: 'in', timeoutMs: 5 })).toEqual({
      stdout: 'ok',
      stderr: '',
      status: 0,
    });
    expect(run).toHaveBeenCalledWith('/bin/slicc', ['https://x/join/t', 'exec', 'ls /'], {
      stdin: 'in',
      timeoutMs: 5,
    });
  });

  it('retries dial failures only, and returns other failures as they are', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: 'tray connect timed out', status: 1 })
      .mockResolvedValueOnce({ stdout: 'fine', stderr: '', status: 0 });
    const exec = createCliExec({ url: 'https://x', run, retryDelayMs: 0 });
    expect((await exec('true')).stdout).toBe('fine');
    expect(run).toHaveBeenCalledTimes(2);
    const failing = vi.fn(async () => ({ stdout: '', stderr: 'no such command', status: 127 }));
    expect(
      (await createCliExec({ url: 'https://x', run: failing, retryDelayMs: 0 })('nope')).status
    ).toBe(127);
    expect(failing).toHaveBeenCalledTimes(1);
    const alwaysDown = vi.fn(async () => ({ stdout: '', stderr: 'signaling failed', status: 1 }));
    expect(
      (await createCliExec({ url: 'https://x', run: alwaysDown, retryDelayMs: 0 })('x')).status
    ).toBe(1);
    expect(alwaysDown).toHaveBeenCalledTimes(3);
  });

  it('needs a join URL', () => {
    expect(() => createCliExec({ url: '' })).toThrow(/join URL/);
  });

  it('runs a real process: stdin, stdout, stderr, exit status and timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-cli-'));
    const cli = join(dir, 'fake-slicc');
    writeFileSync(
      cli,
      `#!/bin/sh\nif [ "$3" = "sleep" ]; then sleep 5; fi\ncat\necho "args:$2:$3" >&2\nexit 3\n`
    );
    chmodSync(cli, 0o755);
    const exec = createCliExec({ url: 'https://x', cli });
    expect(await exec('cmd', { stdin: 'hello' })).toEqual({
      stdout: 'hello',
      stderr: 'args:exec:cmd\n',
      status: 3,
    });
    const slow = await exec('sleep', { timeoutMs: 100 });
    expect(slow.status).not.toBe(0);
  });
});

describe('pickPageTarget', () => {
  it('picks the SLICC page, not a preview tab or a worker', () => {
    const targets = [
      {
        type: 'service_worker',
        url: 'http://localhost:8817/sw.js',
        webSocketDebuggerUrl: 'ws://sw',
      },
      {
        type: 'page',
        url: 'http://localhost:8817/preview/tmp/a.html',
        webSocketDebuggerUrl: 'ws://preview',
      },
      { type: 'page', url: 'http://localhost:8817/?bridge=x', webSocketDebuggerUrl: 'ws://ui' },
    ];
    expect(pickPageTarget(targets, 'localhost:8817').webSocketDebuggerUrl).toBe('ws://ui');
    expect(pickPageTarget(targets, 'localhost:9999')).toBeUndefined();
  });
});

/** A minimal WebSocket double that answers Runtime.evaluate with `respond(expression)`. */
function fakeSocketClass(respond, { failOpen = false } = {}) {
  const sent = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      queueMicrotask(() => this.emit(failOpen ? 'error' : 'open', {}));
    }
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    }
    emit(type, ev) {
      for (const fn of this.listeners[type] ?? []) fn(ev);
    }
    send(data) {
      const msg = JSON.parse(data);
      sent.push(msg.params.expression);
      const reply = respond(msg.params.expression);
      queueMicrotask(() =>
        this.emit('message', { data: JSON.stringify({ id: msg.id, ...reply }) })
      );
    }
    close() {}
  }
  return { FakeSocket, sent };
}

const LIST = [{ type: 'page', url: 'http://localhost:8817/', webSocketDebuggerUrl: 'ws://ui' }];
const fetchList = async () => ({ json: async () => LIST });

describe('createCdpExec', () => {
  it('runs a command through the sprinkle exec bridge', async () => {
    const { FakeSocket, sent } = fakeSocketClass(() => ({
      result: { result: { value: { stdout: 'hi\n', stderr: '', exitCode: 0 } } },
    }));
    const exec = createCdpExec({
      cdpUrl: 'http://127.0.0.1:1/',
      uiMatch: 'localhost:8817',
      fetchImpl: fetchList,
      WebSocketImpl: FakeSocket,
    });
    expect(await exec('echo hi')).toEqual({ stdout: 'hi\n', stderr: '', status: 0 });
    expect(sent[0]).toBe('window.__slicc_sprinkleManager.bridge.execHandler("echo hi")');
  });

  it('stages stdin as a VFS file and keeps the command status', async () => {
    const { FakeSocket, sent } = fakeSocketClass((expr) =>
      expr.includes('execHandler')
        ? { result: { result: { value: { stdout: '', exitCode: 4 } } } }
        : { result: { result: { value: true } } }
    );
    const exec = createCdpExec({
      cdpUrl: 'http://127.0.0.1:1',
      fetchImpl: fetchList,
      WebSocketImpl: FakeSocket,
      uiMatch: 'localhost',
    });
    expect(await exec('cat > /tmp/x', { stdin: Buffer.from('data') })).toEqual({
      stdout: '',
      stderr: '',
      status: 4,
    });
    expect(sent[0]).toContain('fs.writeFile(');
    expect(sent[0]).toContain('"data"');
    expect(sent[1]).toMatch(
      /\{ cat > \/tmp\/x ; \} < \/tmp\/bench\/\.stdin-\d+-1; __s=\$\?; rm -f .*; \(exit \$__s\)/
    );
  });

  it('surfaces CDP errors, page exceptions, missing pages and a closed socket', async () => {
    const mk = (respond, opts) =>
      createCdpExec({
        cdpUrl: 'http://x',
        uiMatch: 'localhost',
        fetchImpl: fetchList,
        WebSocketImpl: fakeSocketClass(respond, opts).FakeSocket,
      });
    await expect(mk(() => ({ error: { message: 'bad' } }))('x')).rejects.toThrow(/CDP: bad/);
    await expect(
      mk(() => ({
        result: { exceptionDetails: { exception: { description: 'TypeError: nope' } } },
      }))('x')
    ).rejects.toThrow(/page threw: TypeError: nope/);
    await expect(
      mk(() => ({ result: { exceptionDetails: { text: 'Uncaught' } } }))('x')
    ).rejects.toThrow(/page threw: Uncaught/);
    await expect(mk(() => ({}), { failOpen: true })('x')).rejects.toThrow(/cannot open ws:\/\/ui/);
    expect(await mk(() => ({ result: { result: { value: null } } }))('x')).toEqual({
      stdout: '',
      stderr: '',
      status: 1,
    });
    const none = createCdpExec({
      cdpUrl: 'http://x',
      uiMatch: 'nowhere',
      fetchImpl: fetchList,
      WebSocketImpl: fakeSocketClass(() => ({})).FakeSocket,
    });
    await expect(none('x')).rejects.toThrow(/no SLICC page matching nowhere/);
    class Closing {
      constructor() {
        this.l = {};
        queueMicrotask(() => this.l.open?.());
      }
      addEventListener(t, fn) {
        this.l[t] = fn;
      }
      send() {
        queueMicrotask(() => this.l.close?.());
      }
      close() {}
    }
    await expect(
      createCdpExec({
        cdpUrl: 'http://x',
        uiMatch: 'localhost',
        fetchImpl: fetchList,
        WebSocketImpl: Closing,
      })('x')
    ).rejects.toThrow(/socket closed/);
    expect(() => createCdpExec({})).toThrow(/--cdp/);
  });
});
