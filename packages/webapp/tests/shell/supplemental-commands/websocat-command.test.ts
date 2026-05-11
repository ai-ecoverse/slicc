import { describe, expect, it, vi } from 'vitest';
import {
  createWebsocatCommand,
  runWebsocat,
} from '../../../src/shell/supplemental-commands/websocat-command.js';

interface SentFrame {
  data: string | ArrayBuffer;
}

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  protocols: string | string[] | undefined;
  binaryType: BinaryType = 'blob';
  readyState = 0;
  sent: SentFrame[] = [];

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
  }

  fireOpen() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  fireText(text: string) {
    this.onmessage?.(new MessageEvent('message', { data: text }));
  }
  fireBinary(bytes: Uint8Array) {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    this.onmessage?.(new MessageEvent('message', { data: buf }));
  }
  fireClose(code = 1000, reason = '') {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code, reason, wasClean: code === 1000 }));
  }
  fireError() {
    this.onerror?.(new Event('error'));
  }
  send(data: string | ArrayBuffer) {
    this.sent.push({ data });
  }
  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    // Simulate the browser firing close after we call close().
    setTimeout(() => this.fireClose(code ?? 1000, reason ?? ''), 0);
  }
}

function makeCtor() {
  MockWebSocket.instances = [];
  return MockWebSocket as unknown as typeof WebSocket;
}

describe('websocat command', () => {
  it('exposes the correct name', () => {
    expect(createWebsocatCommand().name).toBe('websocat');
  });

  it('prints help with -h', async () => {
    const r = await runWebsocat(['-h'], { stdin: '' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Minimal websocat client');
    expect(r.stdout).toContain('Server mode and advanced specifiers');
  });

  it('errors when URL is missing', async () => {
    const r = await runWebsocat([], { stdin: '' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('missing ws:// or wss:// URL');
  });

  it('rejects non-ws URLs', async () => {
    const r = await runWebsocat(['https://example.com'], { stdin: '' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('must start with ws:// or wss://');
  });

  it('rejects server mode and other unsupported flags', async () => {
    const r1 = await runWebsocat(['-s', '1234'], { stdin: '' });
    expect(r1.exitCode).toBe(2);
    expect(r1.stderr).toContain("flag '-s' is not supported");

    const r2 = await runWebsocat(['--socks5', '127.0.0.1:9050', 'ws://x'], { stdin: '' });
    expect(r2.exitCode).toBe(2);
    expect(r2.stderr).toContain('--socks5');
  });

  it('rejects extra positional args (no advanced mode)', async () => {
    const r = await runWebsocat(['ws://a', 'tcp:1.2.3.4:5'], { stdin: '' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('advanced mode is not supported');
  });

  it('does a one-shot send/receive round trip', async () => {
    const Ctor = makeCtor();
    const promise = runWebsocat(
      ['-1', 'ws://test/echo'],
      { stdin: 'hello\n' },
      { WebSocketCtor: Ctor }
    );

    // Let the constructor and listeners attach.
    await new Promise((r) => setTimeout(r, 0));
    const sock = MockWebSocket.instances[0];
    expect(sock).toBeDefined();
    sock.fireOpen();
    await new Promise((r) => setTimeout(r, 0));
    expect(sock.sent).toHaveLength(1);
    expect(sock.sent[0].data).toBe('hello');
    sock.fireText('world');
    // -1 triggers close after first message; mock fires close on next tick.
    const r = await promise;
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('world\n');
  });

  it('formats JSON-RPC with --jsonrpc-omit-jsonrpc', async () => {
    const Ctor = makeCtor();
    const promise = runWebsocat(
      ['-1', '--jsonrpc-omit-jsonrpc', 'ws://cdp'],
      { stdin: 'Page.navigate {"url":"https://example.com"}\n' },
      { WebSocketCtor: Ctor }
    );
    await new Promise((r) => setTimeout(r, 0));
    const sock = MockWebSocket.instances[0];
    sock.fireOpen();
    await new Promise((r) => setTimeout(r, 0));
    expect(sock.sent).toHaveLength(1);
    const payload = JSON.parse(sock.sent[0].data as string);
    expect(payload.method).toBe('Page.navigate');
    expect(payload.params).toEqual({ url: 'https://example.com' });
    expect(payload.id).toBe(1);
    expect(payload.jsonrpc).toBeUndefined();
    sock.fireText('{"id":1,"result":{}}');
    await promise;
  });

  it('base64-encodes binary frames when --base64 is set', async () => {
    const Ctor = makeCtor();
    const promise = runWebsocat(
      ['-1', '--base64', '-U', 'ws://bin'],
      { stdin: '' },
      { WebSocketCtor: Ctor }
    );
    await new Promise((r) => setTimeout(r, 0));
    const sock = MockWebSocket.instances[0];
    sock.fireOpen();
    await new Promise((r) => setTimeout(r, 0));
    sock.fireBinary(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    const r = await promise;
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('3q2+7w==');
  });

  it('honors --max-messages', async () => {
    const Ctor = makeCtor();
    const promise = runWebsocat(
      ['--max-messages', '2', '-U', 'ws://x'],
      { stdin: '' },
      { WebSocketCtor: Ctor }
    );
    await new Promise((r) => setTimeout(r, 0));
    const sock = MockWebSocket.instances[0];
    sock.fireOpen();
    sock.fireText('one');
    sock.fireText('two');
    sock.fireText('three');
    const r = await promise;
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('one\ntwo\n');
  });

  it('sends each stdin line as a separate message in multi-message mode', async () => {
    const Ctor = makeCtor();
    const promise = runWebsocat(['-E', 'ws://x'], { stdin: 'a\nb\nc\n' }, { WebSocketCtor: Ctor });
    await new Promise((r) => setTimeout(r, 0));
    const sock = MockWebSocket.instances[0];
    sock.fireOpen();
    await new Promise((r) => setTimeout(r, 0));
    expect(sock.sent.map((f) => f.data)).toEqual(['a', 'b', 'c']);
    await promise;
  });

  it('passes --protocol as the WebSocket subprotocol', async () => {
    const Ctor = makeCtor();
    const promise = runWebsocat(
      ['-1', '--protocol', 'chat.v1', 'ws://x'],
      { stdin: 'hi\n' },
      { WebSocketCtor: Ctor }
    );
    await new Promise((r) => setTimeout(r, 0));
    const sock = MockWebSocket.instances[0];
    expect(sock.protocols).toBe('chat.v1');
    sock.fireOpen();
    await new Promise((r) => setTimeout(r, 0));
    sock.fireText('ack');
    await promise;
  });

  it('reports connect timeout as exit 124', async () => {
    vi.useFakeTimers();
    const Ctor = makeCtor();
    const promise = runWebsocat(
      ['--conn-timeout', '1', 'ws://slow'],
      { stdin: '' },
      { WebSocketCtor: Ctor }
    );
    await vi.advanceTimersByTimeAsync(1001);
    // The mock close() schedules an onclose tick.
    await vi.advanceTimersByTimeAsync(10);
    const r = await promise;
    expect(r.exitCode).toBe(124);
    vi.useRealTimers();
  });

  it('does not hang when the socket fires error before open (refused)', async () => {
    const Ctor = makeCtor();
    const promise = runWebsocat(['ws://refused'], { stdin: '' }, { WebSocketCtor: Ctor });
    await new Promise((r) => setTimeout(r, 0));
    const sock = MockWebSocket.instances[0];
    sock.fireError();
    sock.fireClose(1006, 'refused');
    const r = await promise;
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('connect');
  });

  it('does not hang when the socket closes before open (no error event)', async () => {
    const Ctor = makeCtor();
    const promise = runWebsocat(['ws://aborted'], { stdin: '' }, { WebSocketCtor: Ctor });
    await new Promise((r) => setTimeout(r, 0));
    const sock = MockWebSocket.instances[0];
    sock.fireClose(1006, '');
    const r = await promise;
    expect(r.exitCode).toBe(1);
  });

  it('parses -1n and -n1 as one-message + no-close (regression for prefix swallow)', async () => {
    for (const combined of ['-1n', '-n1']) {
      const Ctor = makeCtor();
      const promise = runWebsocat([combined, 'ws://x'], { stdin: 'hi\n' }, { WebSocketCtor: Ctor });
      await new Promise((r) => setTimeout(r, 0));
      const sock = MockWebSocket.instances[0];
      sock.fireOpen();
      await new Promise((r) => setTimeout(r, 0));
      // -1n sends one message…
      expect(sock.sent).toHaveLength(1);
      sock.fireText('ack');
      const r = await promise;
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('ack\n');
      // …and -n means: do not send a Close frame ourselves.
      expect(sock.closeCalls).toHaveLength(0);
    }
  });

  it('terminates -u --max-messages by counting inbound messages without emitting them', async () => {
    const Ctor = makeCtor();
    const promise = runWebsocat(
      ['-u', '--max-messages', '2', 'ws://x'],
      { stdin: '' },
      { WebSocketCtor: Ctor }
    );
    await new Promise((r) => setTimeout(r, 0));
    const sock = MockWebSocket.instances[0];
    sock.fireOpen();
    sock.fireText('hidden-one');
    sock.fireText('hidden-two');
    const r = await promise;
    expect(r.exitCode).toBe(0);
    // -u suppresses output but message count drove termination.
    expect(r.stdout).toBe('');
    expect(sock.closeCalls).toHaveLength(1);
  });

  it('terminates -u -1 after one inbound message (counted but not emitted)', async () => {
    const Ctor = makeCtor();
    const promise = runWebsocat(['-u', '-1', 'ws://x'], { stdin: 'hi\n' }, { WebSocketCtor: Ctor });
    await new Promise((r) => setTimeout(r, 0));
    const sock = MockWebSocket.instances[0];
    sock.fireOpen();
    await new Promise((r) => setTimeout(r, 0));
    sock.fireText('reply-not-printed');
    const r = await promise;
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    expect(sock.closeCalls).toHaveLength(1);
  });

  it('rejects --close-reason without --close-status-code', async () => {
    const r = await runWebsocat(['--close-reason', 'goodbye', 'ws://x'], { stdin: '' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--close-reason requires --close-status-code');
  });

  it('always terminates stderr with a newline on connect failure', async () => {
    const Ctor = makeCtor();
    const promise = runWebsocat(['ws://refused'], { stdin: '' }, { WebSocketCtor: Ctor });
    await new Promise((r) => setTimeout(r, 0));
    const sock = MockWebSocket.instances[0];
    sock.fireError();
    sock.fireClose(1006, '');
    const r = await promise;
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toBe('');
    expect(r.stderr.endsWith('\n')).toBe(true);
  });

  it('warns under -v that custom headers are not honored', async () => {
    const Ctor = makeCtor();
    const promise = runWebsocat(
      ['-1', '-v', '-H', 'X-Test: 1', 'ws://x'],
      { stdin: 'hi\n' },
      { WebSocketCtor: Ctor }
    );
    await new Promise((r) => setTimeout(r, 0));
    const sock = MockWebSocket.instances[0];
    sock.fireOpen();
    await new Promise((r) => setTimeout(r, 0));
    sock.fireText('ack');
    const r = await promise;
    expect(r.stderr).toContain('browsers do not allow setting WebSocket request headers');
  });
});
