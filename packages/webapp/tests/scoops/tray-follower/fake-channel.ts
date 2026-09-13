import type {
  FollowerToLeaderMessage,
  LeaderToFollowerMessage,
} from '../../../src/scoops/tray-sync-protocol.js';
import type { TrayDataChannelLike } from '../../../src/scoops/tray-webrtc.js';

export type LegacyStatusMessage = Omit<
  Extract<LeaderToFollowerMessage, { type: 'status' }>,
  'scoopJid'
>;

/** Shared fake RTC data channel for follower-sync tests. */
export class FakeChannel implements TrayDataChannelLike {
  readyState = 'open';
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<Function>>();

  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  addEventListener(type: string, listener: Function): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    if (this.readyState === 'closed') {
      throw new Error('Cannot send on closed channel');
    }
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 'closed';
  }

  simulateLeaderMessage(msg: LeaderToFollowerMessage | LegacyStatusMessage): void {
    const data = JSON.stringify(msg);
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data });
    }
  }

  simulateClose(): void {
    for (const listener of this.listeners.get('close') ?? []) {
      (listener as () => void)();
    }
  }

  simulateError(): void {
    for (const listener of this.listeners.get('error') ?? []) {
      (listener as () => void)();
    }
  }

  parseSent(): FollowerToLeaderMessage[] {
    // The manager sends a `hello` version handshake on construction; filter it
    // out so per-feature assertions stay focused. Hello-specific tests read
    // the raw `sent` array instead.
    return this.sent
      .map((s) => JSON.parse(s) as FollowerToLeaderMessage)
      .filter((m) => m.type !== 'hello');
  }
}
