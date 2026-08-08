/**
 * Delegated transcript-export approval (hosted-leader / cloud float).
 *
 * When the leader tab has no interactive human — headless Chromium in an e2b
 * sandbox — it cannot render the approval dialog to anyone. It delegates the
 * prompt to the requesting follower instead. These tests pin that behavior and
 * the fail-closed guarantees around it.
 */
import 'fake-indexeddb/auto';
import { sha256 as sha256Lib } from 'js-sha256';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLoggerDedupForTests } from '../../src/base/logger.js';
import { FollowerSyncManager } from '../../src/scoops/tray-follower-sync.js';
import {
  LeaderSyncManager,
  type LeaderSyncManagerOptions,
} from '../../src/scoops/tray-leader-sync.js';
import type {
  FollowerToLeaderMessage,
  LeaderToFollowerMessage,
} from '../../src/scoops/tray-sync-protocol.js';
import type { TrayDataChannelLike } from '../../src/scoops/tray-webrtc.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class FakeChannel implements TrayDataChannelLike {
  readyState = 'open';
  readonly sent: string[] = [];
  bufferedAmount = 0;
  private readonly listeners = new Map<string, Array<Function>>();

  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  addEventListener(type: string, listener: Function): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    if (this.readyState === 'closed') throw new Error('Cannot send on closed channel');
    this.sent.push(data);
    // Model a live follower: answer keepalive pings, otherwise the leader
    // declares the peer dead partway through a long approval wait.
    if ((JSON.parse(data) as { type: string }).type === 'ping') {
      queueMicrotask(() => this.simulate({ type: 'pong' } as FollowerToLeaderMessage));
    }
  }

  close(): void {
    this.readyState = 'closed';
    for (const l of this.listeners.get('close') ?? []) (l as () => void)();
  }

  simulate(msg: FollowerToLeaderMessage | LeaderToFollowerMessage): void {
    const data = JSON.stringify(msg);
    for (const l of this.listeners.get('message') ?? []) l({ data });
  }

  types(): string[] {
    return this.sent
      .map((s) => (JSON.parse(s) as { type: string }).type)
      .filter((t) => t !== 'hello');
  }

  find<T extends { type: string }>(type: string): T | undefined {
    return this.sent.map((s) => JSON.parse(s) as T).find((m) => m.type === type);
  }
}

function makeZipResult(
  chunks: Uint8Array[]
): import('../../src/transcript/zip-stream.js').TranscriptZipResult {
  async function* gen() {
    for (const c of chunks) yield c;
  }
  const hasher = sha256Lib.create();
  for (const c of chunks) hasher.update(c);
  return {
    filename: 'test-transcript.zip',
    chunks: gen(),
    completion: Promise.resolve({
      byteLength: chunks.reduce((n, c) => n + c.byteLength, 0),
      sha256: hasher.hex(),
    }),
  };
}

function makeLeader(overrides?: Partial<LeaderSyncManagerOptions>): {
  manager: LeaderSyncManager;
  ch: FakeChannel;
  localApproval: ReturnType<typeof vi.fn>;
} {
  const localApproval = vi.fn().mockResolvedValue(true);
  const manager = new LeaderSyncManager({
    sendControl: () => {},
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    requestTranscriptExportApproval: localApproval,
    createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([new Uint8Array([1, 2, 3])])),
    ...overrides,
  });
  const ch = new FakeChannel();
  manager.addFollower('boot-1', ch, { runtime: 'slicc-browser' });
  return { manager, ch, localApproval };
}

function requestExport(ch: FakeChannel, requestId = 'te-1'): void {
  ch.simulate({
    type: 'transcript.export.request',
    requestId,
    selector: { kind: 'active' },
  } as FollowerToLeaderMessage);
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetLoggerDedupForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Leader — headless (hosted / cloud)
// ---------------------------------------------------------------------------

describe('Leader (headless): delegates approval to the requesting follower', () => {
  it('sends transcript.export.approve.request instead of opening a local dialog', async () => {
    const { ch, localApproval } = makeLeader({ headlessLeader: true });
    requestExport(ch);
    await flush();

    expect(ch.types()).toContain('transcript.export.approve.request');
    // The headless leader must never try to render a dialog nobody can see.
    expect(localApproval).not.toHaveBeenCalled();
  });

  it('forwards the selector but no transcript metadata in the prompt', async () => {
    const { ch } = makeLeader({ headlessLeader: true });
    requestExport(ch);
    await flush();

    const prompt = ch.find<{ type: string; requestId: string; selector: { kind: string } }>(
      'transcript.export.approve.request'
    );
    expect(prompt?.requestId).toBe('te-1');
    expect(prompt?.selector).toEqual({ kind: 'active' });
    expect(prompt).not.toHaveProperty('filename');
    expect(prompt).not.toHaveProperty('title');
  });

  it('streams the export when the follower approves', async () => {
    const { ch } = makeLeader({ headlessLeader: true });
    requestExport(ch);
    await flush();

    ch.simulate({
      type: 'transcript.export.approve.response',
      requestId: 'te-1',
      approved: true,
    } as FollowerToLeaderMessage);
    await vi.waitFor(() => expect(ch.types()).toContain('transcript.export.start'));
  });

  it('denies when the follower rejects, and never starts a transfer', async () => {
    const { ch } = makeLeader({ headlessLeader: true });
    requestExport(ch);
    await flush();

    ch.simulate({
      type: 'transcript.export.approve.response',
      requestId: 'te-1',
      approved: false,
    } as FollowerToLeaderMessage);
    await vi.waitFor(() => expect(ch.types()).toContain('transcript.export.denied'));
    expect(ch.types()).not.toContain('transcript.export.start');
  });

  it('denies when the follower never answers (bounded — the original cloud hang)', async () => {
    vi.useFakeTimers();
    const { ch } = makeLeader({ headlessLeader: true });
    requestExport(ch);
    await vi.advanceTimersByTimeAsync(0);
    expect(ch.types()).toContain('transcript.export.approve.request');

    // Nobody replies. Before the fix this hung forever.
    await vi.advanceTimersByTimeAsync(120_000 + 10);
    expect(ch.types()).toContain('transcript.export.denied');
  });

  it('releases the in-flight slot after a timeout so a retry is possible', async () => {
    vi.useFakeTimers();
    const { ch } = makeLeader({ headlessLeader: true });
    requestExport(ch, 'te-1');
    await vi.advanceTimersByTimeAsync(120_000 + 10);

    // A brand-new request must get its own prompt, not an auto-deny from the
    // per-follower concurrency cap.
    requestExport(ch, 'te-2');
    await vi.advanceTimersByTimeAsync(0);
    const prompts = ch.sent
      .map((s) => JSON.parse(s) as { type: string; requestId?: string })
      .filter((m) => m.type === 'transcript.export.approve.request');
    expect(prompts.map((p) => p.requestId)).toEqual(['te-1', 'te-2']);
  });

  it('ignores an approval response for an unknown requestId', async () => {
    const { ch } = makeLeader({ headlessLeader: true });
    requestExport(ch);
    await flush();

    ch.simulate({
      type: 'transcript.export.approve.response',
      requestId: 'te-does-not-exist',
      approved: true,
    } as FollowerToLeaderMessage);
    await flush();
    expect(ch.types()).not.toContain('transcript.export.start');
  });

  it('denies immediately when the prompt cannot be sent (dead channel)', async () => {
    vi.useFakeTimers();
    const { ch } = makeLeader({ headlessLeader: true });
    const realSend = ch.send.bind(ch);
    // Only the approval prompt fails — the leader must still be able to reply.
    ch.send = (data: string) => {
      if (data.includes('transcript.export.approve.request')) throw new Error('channel closed');
      realSend(data);
    };
    requestExport(ch);

    // No timer advance: the denial must not wait for the 120 s deadline.
    await vi.advanceTimersByTimeAsync(0);
    expect(ch.types()).toContain('transcript.export.denied');
  });

  it('cleans up when the follower disconnects mid-approval', async () => {
    const { manager, ch } = makeLeader({ headlessLeader: true });
    requestExport(ch);
    await flush();

    manager.removeFollower('boot-1');
    await flush();
    // A late reply on a dead follower must not resurrect the export.
    ch.simulate({
      type: 'transcript.export.approve.response',
      requestId: 'te-1',
      approved: true,
    } as FollowerToLeaderMessage);
    await flush();
    expect(ch.types()).not.toContain('transcript.export.start');
  });
});

// ---------------------------------------------------------------------------
// Leader — interactive (regression guard for every non-cloud float)
// ---------------------------------------------------------------------------

describe('Leader (interactive): unchanged local-dialog behavior', () => {
  it('opens the local dialog and never delegates', async () => {
    const { ch, localApproval } = makeLeader();
    requestExport(ch);
    await vi.waitFor(() => expect(localApproval).toHaveBeenCalled());

    expect(ch.types()).not.toContain('transcript.export.approve.request');
    await vi.waitFor(() => expect(ch.types()).toContain('transcript.export.start'));
  });

  it('still denies via the local dialog', async () => {
    const { ch } = makeLeader({
      requestTranscriptExportApproval: vi.fn().mockResolvedValue(false),
    });
    requestExport(ch);
    await vi.waitFor(() => expect(ch.types()).toContain('transcript.export.denied'));
    expect(ch.types()).not.toContain('transcript.export.approve.request');
  });
});

// ---------------------------------------------------------------------------
// Follower — renders the prompt, replies fail-closed
// ---------------------------------------------------------------------------

describe('Follower: delegated approval handler', () => {
  /**
   * Start a real in-flight export, then deliver the leader's prompt for it.
   * The follower only prompts for requests it is actually waiting on, so the
   * handshake has to be genuine or the assertions below are vacuous.
   */
  async function promptFor(
    options: ConstructorParameters<typeof FollowerSyncManager>[1],
    extra: { estimatedBytes?: number } = {}
  ): Promise<FakeChannel> {
    const ch = new FakeChannel();
    const follower = new FollowerSyncManager(ch, options);
    void follower
      .requestTranscriptExport({ kind: 'active' }, new AbortController().signal)
      .catch(() => undefined);
    const requestId =
      ch.sent
        .map((s) => JSON.parse(s) as { type: string; requestId?: string })
        .find((m) => m.type === 'transcript.export.request')?.requestId ?? '';
    ch.simulate({
      type: 'transcript.export.approve.request',
      requestId,
      selector: { kind: 'active' },
      ...extra,
    } as LeaderToFollowerMessage);
    await flush();
    return ch;
  }

  it('calls the approval callback and replies with the verdict', async () => {
    const onApproval = vi.fn().mockResolvedValue(true);
    const ch = await promptFor(
      { onTranscriptExportApprovalRequest: onApproval },
      { estimatedBytes: 2048 }
    );

    expect(onApproval).toHaveBeenCalledWith(
      expect.objectContaining({ selector: { kind: 'active' }, estimatedBytes: 2048 })
    );
    expect(ch.find('transcript.export.approve.response')).toMatchObject({ approved: true });
  });

  it('replies with the denial when the human denies', async () => {
    const onApproval = vi.fn().mockResolvedValue(false);
    const ch = await promptFor({ onTranscriptExportApprovalRequest: onApproval });

    expect(onApproval).toHaveBeenCalled();
    expect(ch.find('transcript.export.approve.response')).toMatchObject({ approved: false });
  });

  it('fails closed when no approval handler is wired', async () => {
    const ch = await promptFor(undefined);
    expect(ch.find('transcript.export.approve.response')).toMatchObject({ approved: false });
  });

  it('fails closed when the approval dialog throws', async () => {
    const onApproval = vi.fn().mockRejectedValue(new Error('dialog crashed'));
    const ch = await promptFor({ onTranscriptExportApprovalRequest: onApproval });

    expect(onApproval).toHaveBeenCalled();
    expect(ch.find('transcript.export.approve.response')).toMatchObject({ approved: false });
  });
});

// ---------------------------------------------------------------------------
// Follower — the prompt must not outlive its request (PR review)
// ---------------------------------------------------------------------------

describe('Follower: delegated prompt lifecycle', () => {
  /** Opens a prompt for a real in-flight export and exposes its control seams. */
  function openPrompt(): {
    ch: FakeChannel;
    follower: FollowerSyncManager;
    requestId: string;
    aborted: () => boolean;
    allow: () => void;
    exportResult: Promise<Blob | Error>;
    abortExport: AbortController;
  } {
    const ch = new FakeChannel();
    let settle: ((approved: boolean) => void) | undefined;
    let signal: AbortSignal | undefined;
    const follower = new FollowerSyncManager(ch, {
      onTranscriptExportApprovalRequest: (req) => {
        signal = req.signal;
        return new Promise<boolean>((res) => {
          settle = res;
          req.signal.addEventListener('abort', () => res(false), { once: true });
        });
      },
    });

    const abortExport = new AbortController();
    const exportResult = follower
      .requestTranscriptExport({ kind: 'active' }, abortExport.signal)
      .catch((err: Error) => err);

    const requestId =
      ch.sent
        .map((s) => JSON.parse(s) as { type: string; requestId?: string })
        .find((m) => m.type === 'transcript.export.request')?.requestId ?? '';

    return {
      ch,
      follower,
      requestId,
      aborted: () => signal?.aborted === true,
      allow: () => settle?.(true),
      exportResult,
      abortExport,
    };
  }

  it('passes an AbortSignal to the dialog', async () => {
    const p = openPrompt();
    p.ch.simulate({
      type: 'transcript.export.approve.request',
      requestId: p.requestId,
      selector: { kind: 'active' },
    } as LeaderToFollowerMessage);
    await flush();
    expect(p.aborted()).toBe(false);
  });

  it("closes the dialog when the leader's approval times out (denied arrives)", async () => {
    const p = openPrompt();
    p.ch.simulate({
      type: 'transcript.export.approve.request',
      requestId: p.requestId,
      selector: { kind: 'active' },
    } as LeaderToFollowerMessage);
    await flush();

    p.ch.simulate({
      type: 'transcript.export.denied',
      requestId: p.requestId,
    } as LeaderToFollowerMessage);
    await flush();

    expect(p.aborted()).toBe(true);
    expect(await p.exportResult).toBeInstanceOf(Error);
  });

  it('closes the dialog when the local export is aborted (Cherry cancel)', async () => {
    const p = openPrompt();
    p.ch.simulate({
      type: 'transcript.export.approve.request',
      requestId: p.requestId,
      selector: { kind: 'active' },
    } as LeaderToFollowerMessage);
    await flush();

    p.abortExport.abort();
    await flush();
    expect(p.aborted()).toBe(true);
  });

  it('never reports a late "Allow" as an approval after the request is gone', async () => {
    const p = openPrompt();
    p.ch.simulate({
      type: 'transcript.export.approve.request',
      requestId: p.requestId,
      selector: { kind: 'active' },
    } as LeaderToFollowerMessage);
    await flush();

    // Leader gave up first …
    p.ch.simulate({
      type: 'transcript.export.denied',
      requestId: p.requestId,
    } as LeaderToFollowerMessage);
    await flush();
    // … then the human clicks Allow on the stale dialog.
    p.allow();
    await flush();

    const reply = p.ch.find<{ type: string; approved: boolean }>(
      'transcript.export.approve.response'
    );
    expect(reply?.approved).toBe(false);
  });

  it('denies an unsolicited prompt without opening a dialog', async () => {
    const ch = new FakeChannel();
    const onApproval = vi.fn().mockResolvedValue(true);
    new FollowerSyncManager(ch, { onTranscriptExportApprovalRequest: onApproval });

    // No matching transcript.export.request was ever sent by this follower.
    ch.simulate({
      type: 'transcript.export.approve.request',
      requestId: 'te-unsolicited',
      selector: { kind: 'active' },
    } as LeaderToFollowerMessage);
    await flush();

    expect(onApproval).not.toHaveBeenCalled();
    expect(ch.find('transcript.export.approve.response')).toMatchObject({ approved: false });
  });
});

// ---------------------------------------------------------------------------
// End-to-end — the actual cloud scenario
// ---------------------------------------------------------------------------

describe('Cloud end-to-end: headless leader + approving follower', () => {
  it('delivers a verified ZIP Blob to the follower', async () => {
    const leaderCh = new FakeChannel();
    const followerCh = new FakeChannel();

    // Cross-wire the two channels.
    leaderCh.send = (data: string) => {
      leaderCh.sent.push(data);
      queueMicrotask(() => followerCh.simulate(JSON.parse(data) as LeaderToFollowerMessage));
    };
    followerCh.send = (data: string) => {
      followerCh.sent.push(data);
      queueMicrotask(() => leaderCh.simulate(JSON.parse(data) as FollowerToLeaderMessage));
    };

    const payload = new Uint8Array([9, 8, 7, 6, 5]);
    const leader = new LeaderSyncManager({
      sendControl: () => {},
      getMessages: () => [],
      getScoopJid: () => 'cone',
      onFollowerMessage: vi.fn(),
      onFollowerAbort: vi.fn(),
      headlessLeader: true,
      createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([payload])),
    });
    leader.addFollower('boot-1', leaderCh, { runtime: 'slicc-browser' });

    const follower = new FollowerSyncManager(followerCh, {
      onTranscriptExportApprovalRequest: () => true,
    });

    const blob = await follower.requestTranscriptExport(
      { kind: 'active' },
      new AbortController().signal
    );

    expect(blob.type).toBe('application/zip');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(payload);
  });
});
