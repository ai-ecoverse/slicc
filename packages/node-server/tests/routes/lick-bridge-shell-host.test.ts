/**
 * Topology A (multi-page Electron) steering routing. When several browser
 * pages connect to `/licks-ws` (the substrate leader plus auto-follow
 * followers, or a substrate page alongside a webhook-only one), the bare
 * "first OPEN client" pick in `sendLickRequest` / `sendLickStream` could send a
 * shell-exec to the wrong page's worker — a different VFS / session, or a
 * non-substrate client that answers "Unknown request type".
 *
 * Fix: a substrate page announces itself with `{type:'register-shell-host'}` on
 * connect; the bridge routes steering to the first registered shell host. Set
 * insertion order makes that the leader (the overlay injects it first, so it
 * connects + registers first), and auto-rebinds to the next host if the leader
 * drops. A bare connection with no shell host still falls back to first-OPEN, so
 * the single-page standalone path is unchanged.
 *
 * Standalone-only: extension has no node-server (spec §11).
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createLickBridge } from '../../src/routes/lick-bridge.js';

class FakeClient extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: string[] = [];
  send(msg: string): void {
    this.sent.push(msg);
  }
}

function connect(bridge: ReturnType<typeof createLickBridge>): FakeClient {
  const c = new FakeClient();
  bridge.lickWss.emit('connection', c);
  return c;
}

function registerShellHost(c: FakeClient): void {
  c.emit('message', Buffer.from(JSON.stringify({ type: 'register-shell-host' })));
}

describe('lick bridge — steering routes to the registered shell host', () => {
  // sendLickStream arms a 10-min inactivity timer; fake timers keep it from
  // lingering past the test (mirrors lick-bridge-stream.test.ts).
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('routes shell-exec to the registered shell host, not the first-connected client', () => {
    const bridge = createLickBridge();
    const other = connect(bridge); // connects first; never registers (e.g. webhook-only / non-substrate)
    const shellHost = connect(bridge); // connects second; registers as the substrate steering host
    registerShellHost(shellHost);

    void bridge.sendLickRequest('shell-exec', { sessionId: 's', command: 'ls' });

    expect(other.sent).toHaveLength(0);
    expect(shellHost.sent).toHaveLength(1);
    expect((JSON.parse(shellHost.sent[0]) as { type: string }).type).toBe('shell-exec');
  });

  it('routes streaming shell-exec to the registered shell host too', () => {
    const bridge = createLickBridge();
    const other = connect(bridge);
    const shellHost = connect(bridge);
    registerShellHost(shellHost);

    void bridge.sendLickStream('shell-exec', { sessionId: 's', command: 'ls' }, () => {});

    expect(other.sent).toHaveLength(0);
    expect(shellHost.sent).toHaveLength(1);
  });

  it('binds the FIRST registered shell host (the leader injected first), even as more register', () => {
    const bridge = createLickBridge();
    const leader = connect(bridge);
    registerShellHost(leader);
    const follower = connect(bridge);
    registerShellHost(follower);

    void bridge.sendLickRequest('shell-exec', { sessionId: 's', command: 'a' });
    void bridge.sendLickRequest('shell-exec', { sessionId: 's', command: 'b' });

    expect(leader.sent).toHaveLength(2);
    expect(follower.sent).toHaveLength(0);
  });

  it('re-binds to the next shell host after the bound one disconnects', () => {
    const bridge = createLickBridge();
    const leader = connect(bridge);
    registerShellHost(leader);
    const follower = connect(bridge);
    registerShellHost(follower);

    void bridge.sendLickRequest('shell-exec', { sessionId: 's', command: 'a' });
    expect(leader.sent).toHaveLength(1);

    leader.readyState = WebSocket.CLOSED;
    leader.emit('close');

    void bridge.sendLickRequest('shell-exec', { sessionId: 's', command: 'b' });
    expect(follower.sent).toHaveLength(1);
  });

  it('falls back to the only client when none registers (standalone single page)', () => {
    const bridge = createLickBridge();
    const only = connect(bridge);

    void bridge.sendLickRequest('shell-exec', { sessionId: 's', command: 'ls' });

    expect(only.sent).toHaveLength(1);
  });
});
