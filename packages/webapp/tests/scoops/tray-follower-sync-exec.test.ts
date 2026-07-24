import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { FollowerSyncManager } from '../../src/scoops/tray-follower-sync.js';
import type {
  FollowerToLeaderMessage,
  LeaderToFollowerMessage,
} from '../../src/scoops/tray-sync-protocol.js';
import type { TrayDataChannelLike } from '../../src/scoops/tray-webrtc.js';

class FakeChannel implements TrayDataChannelLike {
  readyState = 'open';
  readonly sent: string[] = [];
  private readonly listeners: Array<(event: { data: string }) => void> = [];

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    if (type === 'message') this.listeners.push(listener);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 'closed';
  }
  simulateMessage(msg: LeaderToFollowerMessage): void {
    const data = JSON.stringify(msg);
    for (const l of this.listeners) l({ data });
  }
  parseSent(): FollowerToLeaderMessage[] {
    return this.sent.map((s) => JSON.parse(s) as FollowerToLeaderMessage);
  }
  ofType<T extends FollowerToLeaderMessage['type']>(
    type: T
  ): Extract<FollowerToLeaderMessage, { type: T }>[] {
    return this.parseSent().filter((m) => m.type === type) as Extract<
      FollowerToLeaderMessage,
      { type: T }
    >[];
  }
}

describe('browser follower exec handling', () => {
  it('never advertises exec capability in its hello', () => {
    const ch = new FakeChannel();
    new FollowerSyncManager(ch);
    const hello = ch.ofType('hello');
    expect(hello.length).toBeGreaterThanOrEqual(1);
    expect(hello[0].capabilities?.exec).toBeFalsy();
  });

  it('refuses a leader-issued exec.request with an error response', () => {
    const ch = new FakeChannel();
    const follower = new FollowerSyncManager(ch);
    ch.simulateMessage({ type: 'exec.request', requestId: 'r1', command: 'rm -rf /' });
    const responses = ch.ofType('exec.response');
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ requestId: 'r1', exitCode: 127 });
    expect(responses[0].error).toContain('not supported');
    follower.stop();
  });

  it('ignores exec.chunk / exec.response / exec.signal without replying or throwing', () => {
    const ch = new FakeChannel();
    new FollowerSyncManager(ch);
    const before = ch.sent.length;
    expect(() => {
      ch.simulateMessage({ type: 'exec.chunk', requestId: 'x', stream: 'stdout', data: 'aGk=' });
      ch.simulateMessage({ type: 'exec.response', requestId: 'x', exitCode: 0 });
      ch.simulateMessage({ type: 'exec.signal', requestId: 'x', signal: 'SIGINT' });
    }).not.toThrow();
    // No exec.* reply is produced for these reply-path messages.
    expect(ch.ofType('exec.response')).toHaveLength(0);
    expect(ch.sent.length).toBe(before);
  });
});
