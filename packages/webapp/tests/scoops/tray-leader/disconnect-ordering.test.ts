import { describe, expect, it, vi } from 'vitest';
import {
  LeaderSyncManager,
  type LeaderSyncManagerOptions,
} from '../../../src/scoops/tray-leader-sync.js';
import type {
  FollowerToLeaderMessage,
  LeaderToFollowerMessage,
} from '../../../src/scoops/tray-sync-protocol.js';
import type { TrayDataChannelLike } from '../../../src/scoops/tray-webrtc.js';
import type { SudoDecision } from '../../../src/sudo/types.js';
import type { TranscriptZipResult } from '../../../src/transcript/zip-stream.js';

/** The export gate is a sudo action (#2062): allow/deny verdicts stand in for the old booleans. */
const ALLOW: SudoDecision = { decision: 'allow' };
const DENY: SudoDecision = { decision: 'deny' };

class FakeChannel implements TrayDataChannelLike {
  readyState = 'open';
  private readonly listeners = new Map<string, Array<Function>>();

  constructor(private readonly onSend: (message: LeaderToFollowerMessage) => void = () => {}) {}

  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  addEventListener(type: string, listener: Function): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.onSend(JSON.parse(data) as LeaderToFollowerMessage);
  }

  close(): void {
    this.readyState = 'closed';
  }

  simulateMessage(message: FollowerToLeaderMessage): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data: JSON.stringify(message) });
    }
  }
}

interface RejectEntry {
  reject: (error: Error) => void;
}

function recordReject(entries: Map<string, RejectEntry>, order: string[], label: string): void {
  const entry = entries.values().next().value;
  if (!entry) throw new Error(`missing pending ${label} request`);
  const reject = entry.reject;
  entry.reject = (error) => {
    order.push(label);
    reject(error);
  };
}

describe('LeaderSyncManager follower disconnect integration', () => {
  it('preserves legacy cleanup order before settling new fs and tab work', async () => {
    const order: string[] = [];
    let markTranscriptStarted = () => {};
    const transcriptStarted = new Promise<void>((resolve) => {
      markTranscriptStarted = resolve;
    });
    const options: LeaderSyncManagerOptions = {
      getMessages: () => [],
      getScoopJid: () => 'cone',
      onFollowerMessage: vi.fn(),
      onFollowerAbort: vi.fn(),
      sendControl: vi.fn(),
      onRemoteTransportsCleaned: () => order.push('cdp'),
      requestSudoApproval: vi.fn().mockResolvedValue(ALLOW),
      createTranscriptExport: vi.fn((_selector, signal) => {
        signal.addEventListener('abort', () => order.push('transcript'), { once: true });
        markTranscriptStarted();
        return new Promise<TranscriptZipResult>(() => {});
      }),
    };
    const manager = new LeaderSyncManager(options);
    const target = new FakeChannel();
    let recordTargetRemoval = false;
    const observer = new FakeChannel((message) => {
      if (
        recordTargetRemoval &&
        message.type === 'targets.registry' &&
        message.targets.length === 0
      ) {
        order.push('teleport');
      }
    });
    manager.addFollower('target', target, { runtime: 'slicc-cli' });
    manager.addFollower('observer', observer);
    target.simulateMessage({ type: 'hello', protocolVersion: 3, capabilities: { exec: true } });
    target.simulateMessage({
      type: 'targets.advertise',
      runtimeId: 'runtime-target',
      targets: [{ targetId: 'tab-1', title: 'Remote tab', url: 'https://example.com' }],
    });

    const exec = manager.execOnRemote('runtime-target', 'sleep 30');
    const transport = manager.createRemoteTransport('runtime-target', 'tab-1');
    const cdp = transport.send('Runtime.evaluate', { expression: '1 + 1' });
    const fs = manager.sendFsRequest('runtime-target', { op: 'exists', path: '/' });
    const tab = manager.openRemoteTab('runtime-target', 'https://example.com/new');
    const settlements = Promise.allSettled([exec, cdp, fs, tab]);

    const internals = manager as unknown as {
      remoteExec: { pendingRemoteExecs: Map<string, RejectEntry> };
      fsRouter: { fsResolvers: Map<string, RejectEntry> };
      tabRouter: { tabOpenResolvers: Map<string, RejectEntry> };
    };
    recordReject(internals.remoteExec.pendingRemoteExecs, order, 'exec');
    recordReject(internals.fsRouter.fsResolvers, order, 'fs');
    recordReject(internals.tabRouter.tabOpenResolvers, order, 'tab');

    target.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'export-1',
      selector: { kind: 'active' },
    });
    await transcriptStarted;
    recordTargetRemoval = true;

    manager.removeFollower('target');
    await settlements;
    manager.stop();

    expect(order).toEqual(['exec', 'cdp', 'teleport', 'transcript', 'fs', 'tab']);
  });
});
