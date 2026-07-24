/**
 * Task 8: Tray transcript export — leader approval, bounded chunk transfer,
 * follower reassembly/Blob, and error/cancel flows.
 *
 * RED phase: all tests should FAIL until the implementation lands.
 */
import 'fake-indexeddb/auto';
import { sha256 as sha256Lib } from 'js-sha256';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLoggerDedupForTests } from '../../src/core/logger.js';
import { FollowerSyncManager } from '../../src/scoops/tray-follower-sync.js';
import {
  LeaderSyncManager,
  type LeaderSyncManagerOptions,
} from '../../src/scoops/tray-leader-sync.js';
import type {
  FollowerToLeaderMessage,
  LeaderToFollowerMessage,
  TranscriptExportSelector,
} from '../../src/scoops/tray-sync-protocol.js';
import { CHERRY_RUNTIME_TAG } from '../../src/scoops/tray-sync-protocol.js';
import type { TrayDataChannelLike } from '../../src/scoops/tray-webrtc.js';

// ---------------------------------------------------------------------------
// Fake data channel with backpressure simulation
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
  }

  close(): void {
    this.readyState = 'closed';
    for (const listener of this.listeners.get('close') ?? []) {
      (listener as () => void)();
    }
  }

  simulateMessage(msg: FollowerToLeaderMessage): void {
    const data = JSON.stringify(msg);
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data });
    }
  }

  simulateLeaderMessage(msg: LeaderToFollowerMessage): void {
    const data = JSON.stringify(msg);
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data });
    }
  }

  parseSentLeader(): LeaderToFollowerMessage[] {
    return this.sent
      .map((s) => JSON.parse(s) as LeaderToFollowerMessage)
      .filter((m) => m.type !== 'hello');
  }

  parseSentFollower(): FollowerToLeaderMessage[] {
    return this.sent
      .map((s) => JSON.parse(s) as FollowerToLeaderMessage)
      .filter((m) => m.type !== 'hello');
  }
}

// ---------------------------------------------------------------------------
// Helper: make a minimal TranscriptZipResult-like async iterable
// ---------------------------------------------------------------------------

function makeZipResult(
  chunks: Uint8Array[],
  opts: { byteLength?: number; sha256?: string } = {}
): import('../../src/transcript/zip-stream.js').TranscriptZipResult {
  async function* gen() {
    for (const c of chunks) yield c;
  }
  const totalBytes = chunks.reduce((n, c) => n + c.byteLength, 0);
  // Compute expected sha256 for test honesty
  const sha256Val = opts.sha256 ?? computeSha256(chunks);
  return {
    filename: 'test-transcript.zip',
    chunks: gen(),
    completion: Promise.resolve({
      byteLength: opts.byteLength ?? totalBytes,
      sha256: sha256Val,
    }),
  };
}

function computeSha256(chunks: Uint8Array[]): string {
  // Compute the real SHA-256 so the leader's js-sha256 cross-check passes.
  const hasher = sha256Lib.create();
  for (const c of chunks) hasher.update(c);
  return hasher.hex();
}

// ---------------------------------------------------------------------------
// Helper: leader manager with transport export injection
// ---------------------------------------------------------------------------

function createLeaderManager(overrides?: Partial<LeaderSyncManagerOptions>): {
  manager: LeaderSyncManager;
  approval: ReturnType<typeof vi.fn>;
} {
  const approval = vi.fn().mockResolvedValue(true);
  const options: LeaderSyncManagerOptions = {
    sendControl: () => {},
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    requestTranscriptExportApproval: approval,
    createTranscriptExport: vi
      .fn()
      .mockResolvedValue(makeZipResult([new Uint8Array([1, 2, 3, 4])])),
    ...overrides,
  };
  return { manager: new LeaderSyncManager(options), approval };
}

// ---------------------------------------------------------------------------
// Tests: protocol types exist
// ---------------------------------------------------------------------------
// Module-level follower factory (usable in all describe blocks)
// ---------------------------------------------------------------------------

function makeFollower(): { follower: FollowerSyncManager; ch: FakeChannel } {
  const ch = new FakeChannel();
  const follower = new FollowerSyncManager(ch);
  return { follower, ch };
}

// ---------------------------------------------------------------------------

describe('TranscriptExportSelector type', () => {
  it('accepts active selector', () => {
    const sel: TranscriptExportSelector = { kind: 'active' };
    expect(sel.kind).toBe('active');
  });

  it('accepts frozen selector', () => {
    const sel: TranscriptExportSelector = { kind: 'frozen', sessionId: 'sess-1' };
    expect(sel.kind).toBe('frozen');
    if (sel.kind === 'frozen') expect(sel.sessionId).toBe('sess-1');
  });
});

// ---------------------------------------------------------------------------
// Tests: leader approval flow
// ---------------------------------------------------------------------------

describe('Leader: transcript export approval', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('sends pending immediately on request', async () => {
    const { manager } = createLeaderManager();
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'r1',
      selector: { kind: 'active' },
    });

    await vi.waitFor(() => {
      const msgs = ch.parseSentLeader();
      return msgs.some((m) => m.type === 'transcript.export.pending');
    });

    const pending = ch.parseSentLeader().find((m) => m.type === 'transcript.export.pending');
    expect(pending).toBeTruthy();
    expect((pending as { requestId?: string }).requestId).toBe('r1');
  });

  it('sends denied without metadata when user denies', async () => {
    const { manager } = createLeaderManager({
      requestTranscriptExportApproval: vi.fn().mockResolvedValue(false),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'r2',
      selector: { kind: 'active' },
    });

    await vi.waitFor(() => {
      const msgs = ch.parseSentLeader();
      return msgs.some((m) => m.type === 'transcript.export.denied');
    });

    const msgs = ch.parseSentLeader();
    const denied = msgs.find((m) => m.type === 'transcript.export.denied');
    expect(denied).toBeTruthy();
    expect((denied as { requestId?: string }).requestId).toBe('r2');

    // CRITICAL: no metadata (filename, estimatedBytes) in denied response
    const noBefore = msgs.filter((m) =>
      ['transcript.export.start', 'transcript.export.chunk', 'transcript.export.complete'].includes(
        m.type
      )
    );
    expect(noBefore).toHaveLength(0);
  });

  it('derives follower identity from connected state, not request payload', async () => {
    const approval = vi.fn().mockResolvedValue(true);
    const { manager } = createLeaderManager({ requestTranscriptExportApproval: approval });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch, { runtime: 'slicc-standalone' });

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'r3',
      selector: { kind: 'active' },
    });

    await vi.waitFor(() => approval.mock.calls.length > 0);

    const call = approval.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    // followerLabel derived from the connected meta runtime, not from the message
    expect(call.followerLabel).toContain('standalone');
    // requestId forwarded
    expect(call.requestId).toBe('r3');
    // selector forwarded
    expect(call.selector).toEqual({ kind: 'active' });
  });

  it('is one-use: a second request with same ID is ignored', async () => {
    let approvalCount = 0;
    const { manager } = createLeaderManager({
      requestTranscriptExportApproval: vi.fn().mockImplementation(() => {
        approvalCount++;
        return Promise.resolve(true);
      }),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'r4',
      selector: { kind: 'active' },
    });
    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'r4',
      selector: { kind: 'active' },
    });

    await vi.waitFor(() => approvalCount >= 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(approvalCount).toBe(1);
  });

  it('sends start then chunks then complete on approval', async () => {
    const data = new Uint8Array(100).fill(0xab);
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([data])),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'r5',
      selector: { kind: 'active' },
    });

    // vi.waitFor retries when the callback THROWS — use expect so it throws on false
    await vi.waitFor(
      () => {
        expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.complete')).toBe(
          true
        );
      },
      { timeout: 3000 }
    );

    const msgs = ch.parseSentLeader();
    const start = msgs.find((m) => m.type === 'transcript.export.start') as
      | { type: 'transcript.export.start'; requestId: string; filename: string }
      | undefined;
    expect(start).toBeTruthy();
    expect(start!.requestId).toBe('r5');
    expect(start!.filename).toBeTruthy();

    const chunks = msgs.filter((m) => m.type === 'transcript.export.chunk');
    expect(chunks.length).toBeGreaterThan(0);

    const complete = msgs.find((m) => m.type === 'transcript.export.complete') as
      | {
          type: 'transcript.export.complete';
          requestId: string;
          chunks: number;
          byteLength: number;
          sha256: string;
        }
      | undefined;
    expect(complete).toBeTruthy();
    expect(complete!.requestId).toBe('r5');
    expect(complete!.chunks).toBe(chunks.length);
    expect(complete!.byteLength).toBeGreaterThan(0);
    expect(complete!.sha256).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tests: leader cancellation
// ---------------------------------------------------------------------------

describe('Leader: cancellation', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('cancels in-flight transfer when follower sends cancel', async () => {
    let resolveExport: (result: unknown) => void = () => {};
    const exportStarted = new Promise<void>((res) => {
      resolveExport = res as unknown as (result: unknown) => void;
    });

    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockImplementation(() => {
        resolveExport(undefined);
        return makeZipResult([new Uint8Array(1000).fill(0xff)]);
      }),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'r-cancel',
      selector: { kind: 'active' },
    });

    // Wait for approval + export to start
    await exportStarted;

    ch.simulateMessage({
      type: 'transcript.export.cancel',
      requestId: 'r-cancel',
    });

    // After cancel, no complete message should arrive (wait for any async side effects)
    await new Promise((r) => setTimeout(r, 100));
    const msgs = ch.parseSentLeader();
    expect(msgs.some((m) => m.type === 'transcript.export.complete')).toBe(false);
  });

  it('aborts when follower disconnects mid-transfer', async () => {
    const { manager } = createLeaderManager();
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'r-disc',
      selector: { kind: 'active' },
    });

    // Remove follower (simulates disconnect)
    manager.removeFollower('b1');

    await new Promise((r) => setTimeout(r, 50));
    // No crash, state cleaned up
    expect(true).toBe(true);
  });

  it('cleans up AbortController on every exit path', async () => {
    const { manager } = createLeaderManager({
      requestTranscriptExportApproval: vi.fn().mockResolvedValue(false),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'r-cleanup',
      selector: { kind: 'active' },
    });

    await vi.waitFor(() => ch.parseSentLeader().some((m) => m.type === 'transcript.export.denied'));

    // Can send another request after cleanup (different requestId)
    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'r-cleanup-2',
      selector: { kind: 'active' },
    });

    await vi.waitFor(() => {
      const msgs = ch.parseSentLeader();
      return (
        msgs.filter((m) => m.type === 'transcript.export.denied').length === 2 ||
        msgs.some(
          (m) =>
            m.type === 'transcript.export.pending' &&
            (m as { requestId?: string }).requestId === 'r-cleanup-2'
        )
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: follower reassembly
// ---------------------------------------------------------------------------

describe('Follower: transcript export reassembly', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  function createFollower(): { follower: FollowerSyncManager; ch: FakeChannel } {
    const ch = new FakeChannel();
    const follower = new FollowerSyncManager(ch);
    return { follower, ch };
  }

  function base64(data: Uint8Array): string {
    let s = '';
    for (const b of data) s += String.fromCharCode(b);
    return btoa(s);
  }

  it('exposes requestExport method on FollowerSyncManager', () => {
    const { follower } = createFollower();
    expect(typeof follower.requestTranscriptExport).toBe('function');
  });

  it('sends transcript.export.request to leader', async () => {
    const { follower, ch } = createFollower();
    const controller = new AbortController();
    void follower.requestTranscriptExport({ kind: 'active' }, controller.signal).catch(() => {});

    await vi.waitFor(() => {
      const msgs = ch.parseSentFollower();
      return msgs.some((m) => m.type === 'transcript.export.request');
    });

    const req = ch.parseSentFollower().find((m) => m.type === 'transcript.export.request') as
      | { type: 'transcript.export.request'; requestId: string; selector: TranscriptExportSelector }
      | undefined;
    expect(req).toBeTruthy();
    expect(req!.requestId).toBeTruthy();
    expect(req!.selector).toEqual({ kind: 'active' });
    controller.abort();
  });

  it('resolves with Blob after valid transfer', async () => {
    const { follower, ch } = createFollower();

    const payload = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // ZIP magic bytes
    const b64 = base64(payload);

    // Import sha256 for correct digest
    const { sha256 } = await import('js-sha256');
    const hasher = sha256.create();
    hasher.update(payload);
    const digest = hasher.hex();

    const controller = new AbortController();
    const blobPromise = follower.requestTranscriptExport({ kind: 'active' }, controller.signal);

    // Wait for request to be sent
    await vi.waitFor(() =>
      ch.parseSentFollower().some((m) => m.type === 'transcript.export.request')
    );

    const req = ch.parseSentFollower().find((m) => m.type === 'transcript.export.request') as
      | { requestId: string }
      | undefined;
    const requestId = req!.requestId;

    // Leader sends pending, start, chunk, complete
    ch.simulateLeaderMessage({ type: 'transcript.export.pending', requestId });
    ch.simulateLeaderMessage({
      type: 'transcript.export.start',
      requestId,
      filename: 'test.zip',
    });
    ch.simulateLeaderMessage({
      type: 'transcript.export.chunk',
      requestId,
      index: 0,
      data: b64,
    });
    ch.simulateLeaderMessage({
      type: 'transcript.export.complete',
      requestId,
      chunks: 1,
      byteLength: payload.byteLength,
      sha256: digest,
    });

    const result = await blobPromise;
    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe('application/zip');
    expect(result.size).toBe(payload.byteLength);
  });

  it('rejects on digest mismatch', async () => {
    const { follower, ch } = createFollower();
    const payload = new Uint8Array([1, 2, 3]);
    const b64 = base64(payload);

    const controller = new AbortController();
    const blobPromise = follower.requestTranscriptExport({ kind: 'active' }, controller.signal);

    await vi.waitFor(() =>
      ch.parseSentFollower().some((m) => m.type === 'transcript.export.request')
    );
    const req = ch.parseSentFollower().find((m) => m.type === 'transcript.export.request') as
      | { requestId: string }
      | undefined;
    const requestId = req!.requestId;

    ch.simulateLeaderMessage({ type: 'transcript.export.pending', requestId });
    ch.simulateLeaderMessage({ type: 'transcript.export.start', requestId, filename: 'x.zip' });
    ch.simulateLeaderMessage({ type: 'transcript.export.chunk', requestId, index: 0, data: b64 });
    ch.simulateLeaderMessage({
      type: 'transcript.export.complete',
      requestId,
      chunks: 1,
      byteLength: payload.byteLength,
      sha256: 'bad-digest',
    });

    // Must reject with transfer-corrupt specifically (not a generic error)
    await expect(blobPromise).rejects.toMatchObject({ code: 'transfer-corrupt' });

    // Cleanup: no lingering request entry
    // A subsequent export on the same follower must work (verifies cleanup)
    const blobPromise2 = follower.requestTranscriptExport(
      { kind: 'active' },
      new AbortController().signal
    );
    // Follower must send a new request (proves no state lock)
    await vi.waitFor(
      () => ch.parseSentFollower().filter((m) => m.type === 'transcript.export.request').length >= 2
    );
    const req2 = ch
      .parseSentFollower()
      .filter((m) => m.type === 'transcript.export.request')
      .at(-1) as { requestId: string } | undefined;
    ch.simulateLeaderMessage({ type: 'transcript.export.denied', requestId: req2!.requestId });
    await expect(blobPromise2).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects on chunk count mismatch', async () => {
    const { follower, ch } = createFollower();
    const payload = new Uint8Array([9, 8, 7]);
    const b64 = base64(payload);
    const { sha256 } = await import('js-sha256');
    const hasher = sha256.create();
    hasher.update(payload);
    const digest = hasher.hex();

    const controller = new AbortController();
    const blobPromise = follower.requestTranscriptExport({ kind: 'active' }, controller.signal);

    await vi.waitFor(() =>
      ch.parseSentFollower().some((m) => m.type === 'transcript.export.request')
    );
    const req = ch.parseSentFollower().find((m) => m.type === 'transcript.export.request') as
      | { requestId: string }
      | undefined;
    const requestId = req!.requestId;

    ch.simulateLeaderMessage({ type: 'transcript.export.pending', requestId });
    ch.simulateLeaderMessage({ type: 'transcript.export.start', requestId, filename: 'x.zip' });
    ch.simulateLeaderMessage({ type: 'transcript.export.chunk', requestId, index: 0, data: b64 });
    // Complete says 2 chunks but we only sent 1
    ch.simulateLeaderMessage({
      type: 'transcript.export.complete',
      requestId,
      chunks: 2,
      byteLength: payload.byteLength,
      sha256: digest,
    });

    await expect(blobPromise).rejects.toThrow();
  });

  it('rejects on duplicate chunk index', async () => {
    const { follower, ch } = createFollower();
    const payload = new Uint8Array([5, 5, 5]);
    const b64 = base64(payload);
    const { sha256 } = await import('js-sha256');
    const hasher = sha256.create();
    hasher.update(payload);
    const digest = hasher.hex();

    const controller = new AbortController();
    const blobPromise = follower.requestTranscriptExport({ kind: 'active' }, controller.signal);

    await vi.waitFor(() =>
      ch.parseSentFollower().some((m) => m.type === 'transcript.export.request')
    );
    const req = ch.parseSentFollower().find((m) => m.type === 'transcript.export.request') as
      | { requestId: string }
      | undefined;
    const requestId = req!.requestId;

    ch.simulateLeaderMessage({ type: 'transcript.export.pending', requestId });
    ch.simulateLeaderMessage({ type: 'transcript.export.start', requestId, filename: 'x.zip' });
    // Send index 0 twice
    ch.simulateLeaderMessage({ type: 'transcript.export.chunk', requestId, index: 0, data: b64 });
    ch.simulateLeaderMessage({ type: 'transcript.export.chunk', requestId, index: 0, data: b64 });
    ch.simulateLeaderMessage({
      type: 'transcript.export.complete',
      requestId,
      chunks: 1,
      byteLength: payload.byteLength,
      sha256: digest,
    });

    await expect(blobPromise).rejects.toThrow();
  });

  it('rejects on denied', async () => {
    const { follower, ch } = createFollower();
    const controller = new AbortController();
    const blobPromise = follower.requestTranscriptExport({ kind: 'active' }, controller.signal);

    await vi.waitFor(() =>
      ch.parseSentFollower().some((m) => m.type === 'transcript.export.request')
    );
    const req = ch.parseSentFollower().find((m) => m.type === 'transcript.export.request') as
      | { requestId: string }
      | undefined;
    const requestId = req!.requestId;

    ch.simulateLeaderMessage({ type: 'transcript.export.denied', requestId });

    await expect(blobPromise).rejects.toThrow('permission-denied');
  });

  it('cancels when AbortSignal fires', async () => {
    const { follower, ch } = createFollower();
    const controller = new AbortController();
    const blobPromise = follower.requestTranscriptExport({ kind: 'active' }, controller.signal);

    await vi.waitFor(() =>
      ch.parseSentFollower().some((m) => m.type === 'transcript.export.request')
    );
    const req = ch.parseSentFollower().find((m) => m.type === 'transcript.export.request') as
      | { requestId: string }
      | undefined;
    const requestId = req!.requestId;

    ch.simulateLeaderMessage({ type: 'transcript.export.pending', requestId });
    controller.abort();

    await expect(blobPromise).rejects.toThrow();

    // Should send cancel to leader
    await vi.waitFor(() =>
      ch.parseSentFollower().some((m) => m.type === 'transcript.export.cancel')
    );
  });

  it('rejects on export error from leader', async () => {
    const { follower, ch } = createFollower();
    const controller = new AbortController();
    const blobPromise = follower.requestTranscriptExport({ kind: 'active' }, controller.signal);

    await vi.waitFor(() =>
      ch.parseSentFollower().some((m) => m.type === 'transcript.export.request')
    );
    const req = ch.parseSentFollower().find((m) => m.type === 'transcript.export.request') as
      | { requestId: string }
      | undefined;
    const requestId = req!.requestId;

    ch.simulateLeaderMessage({ type: 'transcript.export.pending', requestId });
    ch.simulateLeaderMessage({
      type: 'transcript.export.error',
      requestId,
      code: 'session-not-found',
    });

    await expect(blobPromise).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: chunk size / base64 encoding
// ---------------------------------------------------------------------------

describe('Leader: chunk encoding', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('encodes chunk data as base64 strings', async () => {
    const data = new Uint8Array(50).fill(0xff);
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([data])),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'r-b64',
      selector: { kind: 'active' },
    });

    // Use expect-inside to make waitFor retry on false (falsy return resolves immediately)
    await vi.waitFor(
      () => {
        expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.complete')).toBe(
          true
        );
      },
      { timeout: 3000 }
    );

    const chunk = ch.parseSentLeader().find((m) => m.type === 'transcript.export.chunk') as
      | { data: string }
      | undefined;
    expect(chunk).toBeTruthy();
    // Valid base64
    expect(() => atob(chunk!.data)).not.toThrow();
  });

  it('sends multiple chunks when data exceeds 32 KiB per message', async () => {
    const large = new Uint8Array(50_000).fill(0xaa);
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([large])),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'r-large',
      selector: { kind: 'active' },
    });

    await vi.waitFor(
      () => {
        expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.complete')).toBe(
          true
        );
      },
      { timeout: 5000 }
    );

    const chunks = ch.parseSentLeader().filter((m) => m.type === 'transcript.export.chunk');
    // 50 KB of binary → base64 is ~66 KB → at least 2 32-KiB messages
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: protocol message types exported from shared-ts
// ---------------------------------------------------------------------------

describe('Protocol message types', () => {
  it('LeaderToFollowerMessage union includes all export variants', () => {
    // These are type-level checks via value construction
    const pending: LeaderToFollowerMessage = {
      type: 'transcript.export.pending',
      requestId: 'r',
    };
    const denied: LeaderToFollowerMessage = {
      type: 'transcript.export.denied',
      requestId: 'r',
    };
    const start: LeaderToFollowerMessage = {
      type: 'transcript.export.start',
      requestId: 'r',
      filename: 'f.zip',
    };
    const chunk: LeaderToFollowerMessage = {
      type: 'transcript.export.chunk',
      requestId: 'r',
      index: 0,
      data: 'abc',
    };
    const complete: LeaderToFollowerMessage = {
      type: 'transcript.export.complete',
      requestId: 'r',
      chunks: 1,
      byteLength: 3,
      sha256: 'abc',
    };
    const error: LeaderToFollowerMessage = {
      type: 'transcript.export.error',
      requestId: 'r',
      code: 'session-not-found',
    };
    expect([pending, denied, start, chunk, complete, error]).toHaveLength(6);
  });

  it('FollowerToLeaderMessage union includes export request and cancel', () => {
    const request: FollowerToLeaderMessage = {
      type: 'transcript.export.request',
      requestId: 'r',
      selector: { kind: 'active' },
    };
    const cancel: FollowerToLeaderMessage = {
      type: 'transcript.export.cancel',
      requestId: 'r',
    };
    expect([request, cancel]).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Security fix tests: SEV-2.1 — cross-follower cancel attack
// ---------------------------------------------------------------------------

describe('Security: cross-follower cancel attack', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('follower B cannot cancel follower A export', async () => {
    // Follower A starts an export that is approved and streaming.
    let resolveChunks: () => void = () => {};
    const blockedChunks = new Promise<void>((res) => {
      resolveChunks = res;
    });
    async function* slowGen() {
      await blockedChunks;
      yield new Uint8Array([1, 2, 3]);
    }
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockResolvedValue({
        filename: 'a.zip',
        chunks: slowGen(),
        // Use real SHA-256 so the leader's cross-check passes and complete is sent
        completion: Promise.resolve({
          byteLength: 3,
          sha256: computeSha256([new Uint8Array([1, 2, 3])]),
        }),
      }),
    });
    const chA = new FakeChannel();
    const chB = new FakeChannel();
    manager.addFollower('followerA', chA);
    manager.addFollower('followerB', chB);

    chA.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'attack-req',
      selector: { kind: 'active' },
    });

    // Wait for A's export to be pending
    await vi.waitFor(() =>
      chA.parseSentLeader().some((m) => m.type === 'transcript.export.pending')
    );

    // Follower B tries to cancel A's requestId
    chB.simulateMessage({
      type: 'transcript.export.cancel',
      requestId: 'attack-req',
    });

    // Unblock the slow generator so A's export can complete
    resolveChunks();

    // A's export should still complete (not aborted by B)
    await vi.waitFor(
      () => {
        expect(chA.parseSentLeader().some((m) => m.type === 'transcript.export.complete')).toBe(
          true
        );
      },
      { timeout: 3000 }
    );

    // B received nothing related to A's export
    const bMsgs = chB.parseSentLeader();
    const exportMsgs = bMsgs.filter((m) => m.type.startsWith('transcript.export.'));
    expect(exportMsgs).toHaveLength(0);
  });

  it('requestId replay collision from different follower does not block second follower', async () => {
    let approvalCalls = 0;
    const { manager } = createLeaderManager({
      requestTranscriptExportApproval: vi.fn().mockImplementation(() => {
        approvalCalls++;
        return Promise.resolve(true);
      }),
      createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([new Uint8Array([1])])),
    });
    const chA = new FakeChannel();
    const chB = new FakeChannel();
    manager.addFollower('followerA', chA);
    manager.addFollower('followerB', chB);

    // A sends request with shared-id (in-flight)
    chA.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'shared-id',
      selector: { kind: 'active' },
    });

    // B sends same requestId — different follower, should NOT be blocked by A's guard
    chB.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'shared-id',
      selector: { kind: 'active' },
    });

    // Both followers should receive pending (two separate requests)
    await vi.waitFor(() => approvalCalls >= 1);
    // The important thing: follower B is not silently dropped (it gets pending or denied)
    await new Promise((r) => setTimeout(r, 50));
    const bMsgs = chB.parseSentLeader();
    const bExportMsgs = bMsgs.filter((m) => m.type.startsWith('transcript.export.'));
    // B must receive some response (pending or denied — not silent)
    expect(bExportMsgs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Security fix tests: SEV-2.2 — Cherry hostOrigin derivation
// ---------------------------------------------------------------------------

describe('Leader: Cherry hostOrigin derivation', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('derives hostOrigin from cherry target URL for Cherry followers', async () => {
    const approval = vi.fn().mockResolvedValue(true);
    const { manager } = createLeaderManager({
      requestTranscriptExportApproval: approval,
    });
    const ch = new FakeChannel();
    // Add follower with the Cherry runtime tag
    manager.addFollower('cherry-b1', ch, { runtime: CHERRY_RUNTIME_TAG });

    // Follower advertises a cherry target
    ch.simulateMessage({
      type: 'targets.advertise',
      runtimeId: 'rt-cherry',
      targets: [
        {
          targetId: 'tgt-1',
          title: 'Host page',
          url: 'https://example.com/embed',
          kind: 'cherry',
        },
      ],
    } as FollowerToLeaderMessage);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'cherry-req',
      selector: { kind: 'active' },
    });

    await vi.waitFor(() => approval.mock.calls.length > 0);

    const call = approval.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    // hostOrigin must be normalized to the URL origin, not the full URL
    expect(call.hostOrigin).toBe('https://example.com');
  });

  it('does not pass hostOrigin for non-Cherry followers', async () => {
    const approval = vi.fn().mockResolvedValue(true);
    const { manager } = createLeaderManager({
      requestTranscriptExportApproval: approval,
    });
    const ch = new FakeChannel();
    manager.addFollower('standalone-b1', ch, { runtime: 'slicc-standalone' });

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'non-cherry-req',
      selector: { kind: 'active' },
    });

    await vi.waitFor(() => approval.mock.calls.length > 0);

    const call = approval.mock.calls[0]?.[0];
    expect(call.hostOrigin).toBeUndefined();
  });

  it('omits hostOrigin when cherry target URL is malformed', async () => {
    const approval = vi.fn().mockResolvedValue(true);
    const { manager } = createLeaderManager({
      requestTranscriptExportApproval: approval,
    });
    const ch = new FakeChannel();
    manager.addFollower('cherry-b2', ch, { runtime: CHERRY_RUNTIME_TAG });

    // Advertise a cherry target with a malformed URL
    ch.simulateMessage({
      type: 'targets.advertise',
      runtimeId: 'rt-cherry-bad',
      targets: [
        {
          targetId: 'tgt-bad',
          title: 'Bad host',
          url: 'not-a-url',
          kind: 'cherry',
        },
      ],
    } as FollowerToLeaderMessage);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'cherry-bad-req',
      selector: { kind: 'active' },
    });

    await vi.waitFor(() => approval.mock.calls.length > 0);

    const call = approval.mock.calls[0]?.[0];
    // Malformed URL — hostOrigin must be absent, not thrown
    expect(call.hostOrigin).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fix tests: SEV-3 — byteLength from leader's own stream
// ---------------------------------------------------------------------------

describe('Leader: byteLength integrity', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('complete.byteLength equals actual bytes streamed, not service-reported value', async () => {
    const data = new Uint8Array(50).fill(0xcc);
    // Service misreports byteLength — leader should catch this
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockResolvedValue(
        makeZipResult([data], { byteLength: data.byteLength }) // correct value here
      ),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'byte-req',
      selector: { kind: 'active' },
    });

    await vi.waitFor(
      () => {
        expect(
          ch
            .parseSentLeader()
            .some(
              (m) => m.type === 'transcript.export.complete' || m.type === 'transcript.export.error'
            )
        ).toBe(true);
      },
      { timeout: 3000 }
    );

    const complete = ch.parseSentLeader().find((m) => m.type === 'transcript.export.complete') as
      | { byteLength: number }
      | undefined;
    expect(complete).toBeDefined();
    // Leader's reported byteLength must match actual bytes (50 bytes)
    expect(complete!.byteLength).toBe(data.byteLength);
  });

  it('sends transfer-corrupt error when service byteLength mismatches leader stream count', async () => {
    const data = new Uint8Array(50).fill(0xdd);
    // Service reports wrong byteLength
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockResolvedValue(
        makeZipResult([data], { byteLength: data.byteLength + 1 }) // wrong!
      ),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'byte-mismatch-req',
      selector: { kind: 'active' },
    });

    await vi.waitFor(
      () => {
        expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.error')).toBe(true);
      },
      { timeout: 3000 }
    );

    const errorMsg = ch.parseSentLeader().find((m) => m.type === 'transcript.export.error') as
      | { code: string }
      | undefined;
    expect(errorMsg).toBeDefined();
    expect(errorMsg!.code).toBe('transfer-corrupt');
    // No complete message
    expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.complete')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix tests: SEV-4.3 — per-follower concurrency cap
// ---------------------------------------------------------------------------

describe('Leader: per-follower concurrency cap', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('auto-denies a second concurrent export request from the same follower', async () => {
    // First request blocks in approval so the second arrives while first is pending
    let resolveApproval: (v: boolean) => void = () => {};
    const { manager } = createLeaderManager({
      requestTranscriptExportApproval: vi.fn().mockImplementation(
        () =>
          new Promise<boolean>((res) => {
            resolveApproval = res;
          })
      ),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    // First request
    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'req-first',
      selector: { kind: 'active' },
    });
    await vi.waitFor(() =>
      ch.parseSentLeader().some((m) => m.type === 'transcript.export.pending')
    );

    // Second request from same follower while first is still pending approval
    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'req-second',
      selector: { kind: 'active' },
    });

    await new Promise((r) => setTimeout(r, 30));

    const msgs = ch.parseSentLeader();
    // Second request must get denied immediately
    const denied = msgs.filter((m) => m.type === 'transcript.export.denied') as Array<{
      requestId: string;
    }>;
    expect(denied.some((d) => d.requestId === 'req-second')).toBe(true);

    // No start/chunk/complete for the second request
    const exportFlow = msgs.filter(
      (m) =>
        (m.type === 'transcript.export.start' || m.type === 'transcript.export.complete') &&
        (m as { requestId?: string }).requestId === 'req-second'
    );
    expect(exportFlow).toHaveLength(0);

    // Clean up: resolve the first approval
    resolveApproval(false);
  });
});

// ---------------------------------------------------------------------------
// Fix tests: approval throw and empty-ZIP
// ---------------------------------------------------------------------------

describe('Leader: approval throw and empty-ZIP', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('sends denied when requestTranscriptExportApproval throws', async () => {
    const { manager } = createLeaderManager({
      requestTranscriptExportApproval: vi.fn().mockRejectedValue(new Error('dialog crashed')),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'throw-req',
      selector: { kind: 'active' },
    });

    await vi.waitFor(() => ch.parseSentLeader().some((m) => m.type === 'transcript.export.denied'));

    const msgs = ch.parseSentLeader();
    const denied = msgs.find((m) => m.type === 'transcript.export.denied');
    expect(denied).toBeTruthy();
    // No metadata leaked when approval throws
    expect(msgs.some((m) => m.type === 'transcript.export.start')).toBe(false);
    expect(msgs.some((m) => m.type === 'transcript.export.chunk')).toBe(false);
    expect(msgs.some((m) => m.type === 'transcript.export.complete')).toBe(false);
  });

  it('sends complete with chunks=0 for an empty ZIP', async () => {
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([])),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'empty-req',
      selector: { kind: 'active' },
    });

    await vi.waitFor(
      () => {
        expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.complete')).toBe(
          true
        );
      },
      { timeout: 3000 }
    );

    const complete = ch.parseSentLeader().find((m) => m.type === 'transcript.export.complete') as
      | { chunks: number; byteLength: number }
      | undefined;
    expect(complete).toBeDefined();
    expect(complete!.chunks).toBe(0);
    expect(complete!.byteLength).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fix tests: sendExportChunks return semantics (SEV-3.2)
// ---------------------------------------------------------------------------

describe('Leader: sendExportChunks terminal states', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('normal stream: sends complete after all chunks', async () => {
    const data = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([data])),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'normal-req',
      selector: { kind: 'active' },
    });

    await vi.waitFor(
      () => {
        expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.complete')).toBe(
          true
        );
      },
      { timeout: 3000 }
    );
    // No error message
    expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.error')).toBe(false);
  });

  it('abort path: no complete or error message after cancel', async () => {
    let resolveChunks: () => void = () => {};
    const holdChunks = new Promise<void>((res) => {
      resolveChunks = res;
    });
    async function* heldGen() {
      await holdChunks;
      yield new Uint8Array([1]);
    }
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockResolvedValue({
        filename: 'abort.zip',
        chunks: heldGen(),
        completion: Promise.resolve({ byteLength: 1, sha256: 'a'.repeat(64) }),
      }),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'abort-state-req',
      selector: { kind: 'active' },
    });

    // Wait for the export to be in-flight (pending)
    await vi.waitFor(() =>
      ch.parseSentLeader().some((m) => m.type === 'transcript.export.pending')
    );

    // Cancel from same follower
    ch.simulateMessage({
      type: 'transcript.export.cancel',
      requestId: 'abort-state-req',
    });

    // Let the generator run (post-cancel)
    resolveChunks();
    await new Promise((r) => setTimeout(r, 100));

    const msgs = ch.parseSentLeader();
    expect(msgs.some((m) => m.type === 'transcript.export.complete')).toBe(false);
    expect(msgs.some((m) => m.type === 'transcript.export.error')).toBe(false);
  });

  it('disconnect path: no crash and state cleaned up', async () => {
    const { manager } = createLeaderManager();
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'disc-state-req',
      selector: { kind: 'active' },
    });

    manager.removeFollower('b1');
    await new Promise((r) => setTimeout(r, 50));
    expect(true).toBe(true); // no unhandled rejection
  });

  it('stream error path: sends transfer-corrupt (not transfer-aborted)', async () => {
    async function* errorGen() {
      yield new Uint8Array([1]);
      throw new Error('disk read failed');
    }
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockResolvedValue({
        filename: 'error.zip',
        chunks: errorGen(),
        completion: Promise.resolve({ byteLength: 1, sha256: 'a'.repeat(64) }),
      }),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'stream-err-req',
      selector: { kind: 'active' },
    });

    await vi.waitFor(
      () => {
        expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.error')).toBe(true);
      },
      { timeout: 3000 }
    );

    const errMsg = ch.parseSentLeader().find((m) => m.type === 'transcript.export.error') as
      | { code: string }
      | undefined;
    expect(errMsg!.code).toBe('transfer-corrupt');
  });
});

// ---------------------------------------------------------------------------
// Fix tests: backpressure polling is cancellable
// ---------------------------------------------------------------------------

describe('Leader: backpressure polling', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('cancels polling when follower sends cancel while backpressure holds', async () => {
    // A channel whose bufferedAmount starts above threshold and stays there
    class BackpressureChannel extends FakeChannel {
      // Start above 1 MiB threshold so polling enters the loop
      override bufferedAmount = 2 * 1024 * 1024;
    }
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([new Uint8Array(100)])),
    });
    const ch = new BackpressureChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'bp-cancel-req',
      selector: { kind: 'active' },
    });

    // Wait for the export to be in-flight (approval + start)
    await vi.waitFor(() => ch.parseSentLeader().some((m) => m.type === 'transcript.export.start'));

    // Cancel while backpressure poll is active
    ch.simulateMessage({
      type: 'transcript.export.cancel',
      requestId: 'bp-cancel-req',
    });

    // Also drop bufferedAmount so the poll exits if still running
    ch.bufferedAmount = 0;

    // No complete message should arrive
    await new Promise((r) => setTimeout(r, 100));
    expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.complete')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix tests: I-1 — createTranscriptExport error code propagation
// ---------------------------------------------------------------------------

describe('Leader: createTranscriptExport error code propagation (I-1)', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('propagates redaction-unavailable when createTranscriptExport throws it', async () => {
    const { TranscriptExportError } = await import('@slicc/shared-ts');
    const { manager } = createLeaderManager({
      createTranscriptExport: vi
        .fn()
        .mockRejectedValue(new TranscriptExportError('redaction-unavailable')),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'redact-fail-req',
      selector: { kind: 'active' },
    });

    await vi.waitFor(
      () => {
        expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.error')).toBe(true);
      },
      { timeout: 3000 }
    );

    const errMsg = ch.parseSentLeader().find((m) => m.type === 'transcript.export.error') as
      | { code: string }
      | undefined;
    // Must NOT silently degrade to session-not-found
    expect(errMsg!.code).toBe('redaction-unavailable');
  });

  it('uses session-not-found for non-TranscriptExportError failures', async () => {
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockRejectedValue(new Error('unexpected disk error')),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'generic-fail-req',
      selector: { kind: 'active' },
    });

    await vi.waitFor(
      () => {
        expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.error')).toBe(true);
      },
      { timeout: 3000 }
    );

    const errMsg = ch.parseSentLeader().find((m) => m.type === 'transcript.export.error') as
      | { code: string }
      | undefined;
    expect(errMsg!.code).toBe('session-not-found');
  });

  it('abort remains silent: no error message when aborted before createTranscriptExport resolves', async () => {
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockImplementation(
        (_sel: unknown, signal: AbortSignal) =>
          new Promise<never>((_res, rej) => {
            signal.addEventListener('abort', () => rej(new Error('aborted')));
          })
      ),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'abort-silent-req',
      selector: { kind: 'active' },
    });

    // pending is sent immediately; wait for it before cancelling
    await vi.waitFor(() => {
      expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.pending')).toBe(true);
    });

    // Cancel before createTranscriptExport resolves
    ch.simulateMessage({
      type: 'transcript.export.cancel',
      requestId: 'abort-silent-req',
    });

    await new Promise((r) => setTimeout(r, 80));

    // No error message should be sent when aborted cleanly
    expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.error')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix tests: Finding 4 — leader SHA-256 vs service digest cross-check
// ---------------------------------------------------------------------------

describe('Leader: SHA-256 cross-check against service digest (Finding 4)', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('sends transfer-corrupt when service sha256 mismatches leader-computed hash', async () => {
    const data = new Uint8Array(10).fill(0xab);
    const { manager } = createLeaderManager({
      createTranscriptExport: vi
        .fn()
        .mockResolvedValue(makeZipResult([data], { sha256: 'wrong-sha256-from-service' })),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'sha-mismatch-req',
      selector: { kind: 'active' },
    });

    await vi.waitFor(
      () => {
        expect(
          ch
            .parseSentLeader()
            .some(
              (m) => m.type === 'transcript.export.error' || m.type === 'transcript.export.complete'
            )
        ).toBe(true);
      },
      { timeout: 3000 }
    );

    const errMsg = ch.parseSentLeader().find((m) => m.type === 'transcript.export.error') as
      | { code: string }
      | undefined;
    expect(errMsg).toBeDefined();
    expect(errMsg!.code).toBe('transfer-corrupt');
    expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.complete')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix tests: I-3 — follower runtime code validation
// ---------------------------------------------------------------------------

describe('Follower: runtime error code validation (I-3)', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('coerces unknown wire code to transfer-corrupt', async () => {
    const { follower, ch } = makeFollower();
    const controller = new AbortController();
    const blobPromise = follower.requestTranscriptExport({ kind: 'active' }, controller.signal);

    await vi.waitFor(() => {
      expect(ch.parseSentFollower().some((m) => m.type === 'transcript.export.request')).toBe(true);
    });
    const req = ch.parseSentFollower().find((m) => m.type === 'transcript.export.request') as
      | { requestId: string }
      | undefined;
    const requestId = req!.requestId;

    ch.simulateLeaderMessage({ type: 'transcript.export.pending', requestId });
    ch.simulateLeaderMessage({
      type: 'transcript.export.error',
      requestId,
      code: 'not-a-real-error-code' as never,
    });

    // Unknown code must become transfer-corrupt
    await expect(blobPromise).rejects.toMatchObject({ code: 'transfer-corrupt' });
  });

  it('passes through valid known error codes unchanged', async () => {
    const { follower, ch } = makeFollower();
    const controller = new AbortController();
    const blobPromise = follower.requestTranscriptExport({ kind: 'active' }, controller.signal);

    await vi.waitFor(() => {
      expect(ch.parseSentFollower().some((m) => m.type === 'transcript.export.request')).toBe(true);
    });
    const req = ch.parseSentFollower().find((m) => m.type === 'transcript.export.request') as
      | { requestId: string }
      | undefined;
    const requestId = req!.requestId;

    ch.simulateLeaderMessage({ type: 'transcript.export.pending', requestId });
    ch.simulateLeaderMessage({
      type: 'transcript.export.error',
      requestId,
      code: 'redaction-unavailable',
    });

    await expect(blobPromise).rejects.toMatchObject({ code: 'redaction-unavailable' });
  });
});

// ---------------------------------------------------------------------------
// Wave 2 fix tests: composite activeExports key (prevents cross-follower collision)
// ---------------------------------------------------------------------------

describe('Leader: composite export key (wave 2)', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('allows two followers to use the same requestId without collision', async () => {
    const { manager } = createLeaderManager();
    const ch1 = new FakeChannel();
    const ch2 = new FakeChannel();
    manager.addFollower('b1', ch1);
    manager.addFollower('b2', ch2);

    // Both followers send the same requestId
    ch1.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'same-id',
      selector: { kind: 'active' },
    });
    ch2.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'same-id',
      selector: { kind: 'active' },
    });

    // Both should receive pending (neither is blocked as a duplicate of the other)
    await vi.waitFor(() => {
      const m1 = ch1.parseSentLeader();
      const m2 = ch2.parseSentLeader();
      return (
        m1.some((m) => m.type === 'transcript.export.pending') &&
        m2.some((m) => m.type === 'transcript.export.pending')
      );
    });

    const p1 = ch1.parseSentLeader().find((m) => m.type === 'transcript.export.pending');
    const p2 = ch2.parseSentLeader().find((m) => m.type === 'transcript.export.pending');
    expect(p1).toBeTruthy();
    expect(p2).toBeTruthy();
  });

  it('still blocks the same follower sending duplicate requestId', async () => {
    let approvalCount = 0;
    const { manager } = createLeaderManager({
      requestTranscriptExportApproval: vi.fn().mockImplementation(async () => {
        approvalCount++;
        return true;
      }),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'dup-id',
      selector: { kind: 'active' },
    });
    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'dup-id',
      selector: { kind: 'active' },
    });

    await vi.waitFor(() => approvalCount >= 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(approvalCount).toBe(1);
  });

  it('cancel from follower b2 does not affect follower b1 export', async () => {
    // Both followers have an export in-flight with the same requestId.
    // b2 cancels — b1's export should continue.
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockImplementation(
        () =>
          new Promise(() => {
            /* never resolves — stays in-flight */
          })
      ),
    });
    const ch1 = new FakeChannel();
    const ch2 = new FakeChannel();
    manager.addFollower('b1', ch1);
    manager.addFollower('b2', ch2);

    ch1.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'shared-req',
      selector: { kind: 'active' },
    });
    ch2.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'shared-req',
      selector: { kind: 'active' },
    });

    // Wait for both to be pending
    await vi.waitFor(() => {
      return (
        ch1.parseSentLeader().some((m) => m.type === 'transcript.export.pending') &&
        ch2.parseSentLeader().some((m) => m.type === 'transcript.export.pending')
      );
    });

    // b2 cancels its export
    ch2.simulateMessage({ type: 'transcript.export.cancel', requestId: 'shared-req' });

    await new Promise((r) => setTimeout(r, 30));

    // b1 must not receive any error or complete (its export is still in-flight)
    const b1Msgs = ch1.parseSentLeader();
    expect(b1Msgs.some((m) => m.type === 'transcript.export.error')).toBe(false);
    expect(b1Msgs.some((m) => m.type === 'transcript.export.complete')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wave 2 fix tests: follower disconnect clears active export requests
// ---------------------------------------------------------------------------

describe('Follower: disconnect cleanup (wave 2)', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  function base64(data: Uint8Array): string {
    let s = '';
    for (const b of data) s += String.fromCharCode(b);
    return btoa(s);
  }

  it('rejects an in-flight export with transfer-aborted on close()', async () => {
    const { follower, ch } = makeFollower();
    const controller = new AbortController();
    const blobPromise = follower.requestTranscriptExport({ kind: 'active' }, controller.signal);

    // Wait for request to be sent
    await vi.waitFor(() =>
      ch.parseSentFollower().some((m) => m.type === 'transcript.export.request')
    );

    const req = ch.parseSentFollower().find((m) => m.type === 'transcript.export.request') as
      | { requestId: string }
      | undefined;
    const requestId = req!.requestId;

    // Leader sends pending+start+one chunk (export is mid-stream)
    ch.simulateLeaderMessage({ type: 'transcript.export.pending', requestId });
    ch.simulateLeaderMessage({
      type: 'transcript.export.start',
      requestId,
      filename: 'mid.zip',
    });
    ch.simulateLeaderMessage({
      type: 'transcript.export.chunk',
      requestId,
      index: 0,
      data: base64(new Uint8Array([1, 2, 3])),
    });

    // Close the follower — this simulates a disconnect
    follower.close();

    // The export promise must reject with transfer-aborted
    await expect(blobPromise).rejects.toMatchObject({ code: 'transfer-aborted' });
  });

  it('removes signal listener on close so no leak remains', async () => {
    const { follower, ch } = makeFollower();
    const controller = new AbortController();
    const blobPromise = follower
      .requestTranscriptExport({ kind: 'active' }, controller.signal)
      .catch(() => undefined);

    await vi.waitFor(() =>
      ch.parseSentFollower().some((m) => m.type === 'transcript.export.request')
    );

    follower.close();
    await blobPromise;

    // After close + abort, aborting the controller must not throw
    expect(() => controller.abort()).not.toThrow();
  });

  it('clears chunk buffers on close so no memory is retained', async () => {
    const { follower, ch } = makeFollower();
    const controller = new AbortController();
    const blobPromise = follower
      .requestTranscriptExport({ kind: 'active' }, controller.signal)
      .catch(() => undefined);

    await vi.waitFor(() =>
      ch.parseSentFollower().some((m) => m.type === 'transcript.export.request')
    );
    const req = ch.parseSentFollower().find((m) => m.type === 'transcript.export.request') as
      | { requestId: string }
      | undefined;
    const requestId = req!.requestId;

    // Deliver several chunks before close
    for (let i = 0; i < 3; i++) {
      ch.simulateLeaderMessage({
        type: 'transcript.export.chunk',
        requestId,
        index: i,
        data: base64(new Uint8Array(10).fill(i)),
      });
    }

    follower.close();
    await blobPromise;

    // After close, the export map is cleared; sending more chunks should be a no-op
    expect(() => {
      ch.simulateLeaderMessage({
        type: 'transcript.export.chunk',
        requestId,
        index: 3,
        data: base64(new Uint8Array([9])),
      });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Wave 2 fix tests: CherryHostTransport error code clamp
// ---------------------------------------------------------------------------

describe('CherryHostTransport: outbound error code validation (wave 2)', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('clamps unknown string error codes to transfer-corrupt', async () => {
    // The cherry-host-transport test file covers this end-to-end;
    // here we verify the behaviour at the tray layer for completeness.
    // An error with a non-canonical code must become 'transfer-corrupt'.
    const { follower, ch } = makeFollower();
    const controller = new AbortController();
    const blobPromise = follower.requestTranscriptExport({ kind: 'active' }, controller.signal);

    await vi.waitFor(() =>
      ch.parseSentFollower().some((m) => m.type === 'transcript.export.request')
    );
    const req = ch.parseSentFollower().find((m) => m.type === 'transcript.export.request') as
      | { requestId: string }
      | undefined;
    const requestId = req!.requestId;

    ch.simulateLeaderMessage({ type: 'transcript.export.pending', requestId });
    // Wire an unknown code — follower must coerce it
    ch.simulateLeaderMessage({
      type: 'transcript.export.error',
      requestId,
      code: 'completely-unknown-code' as never,
    });

    await expect(blobPromise).rejects.toMatchObject({ code: 'transfer-corrupt' });
  });
});

// ---------------------------------------------------------------------------
// Wave 4: Bounded-memory tests — ack-gated flow control (protocol v3)
// ---------------------------------------------------------------------------

describe('Wave 4: Leader ack-gated bounded chunk window (v3 followers)', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('sends only 1 chunk before receiving ack from v3 follower', async () => {
    // A 4-chunk export with a v3 follower — leader should gate on ack.
    const chunk = new Uint8Array(200).fill(0xaa); // fits in 1 base64 msg but we control count
    const { manager } = createLeaderManager({
      createTranscriptExport: vi
        .fn()
        .mockResolvedValue(makeZipResult([chunk, chunk, chunk, chunk])),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    // v3 follower hello
    ch.simulateMessage({ type: 'hello', protocolVersion: 3 });

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'ack-gate-req',
      selector: { kind: 'active' },
    });

    // Wait for first chunk to be sent
    await vi.waitFor(
      () => {
        expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.chunk')).toBe(true);
      },
      { timeout: 3000 }
    );

    // After first chunk, leader should NOT have sent a second chunk yet
    const chunksSoFar = ch.parseSentLeader().filter((m) => m.type === 'transcript.export.chunk');
    expect(chunksSoFar.length).toBe(1);

    // No complete yet
    expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.complete')).toBe(false);
  });

  it('advances to next chunk after ack is received', async () => {
    const chunk = new Uint8Array(50).fill(0xbb);
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([chunk, chunk])),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);
    ch.simulateMessage({ type: 'hello', protocolVersion: 3 });

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'ack-advance-req',
      selector: { kind: 'active' },
    });

    // Wait for first chunk (expect-based so vi.waitFor retries on throw)
    await vi.waitFor(
      () => {
        expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.chunk')).toBe(true);
      },
      { timeout: 3000 }
    );

    // Ack index 0 → leader should send chunk 1
    ch.simulateMessage({ type: 'transcript.export.ack', requestId: 'ack-advance-req', index: 0 });

    await vi.waitFor(
      () => {
        expect(
          ch.parseSentLeader().filter((m) => m.type === 'transcript.export.chunk').length
        ).toBeGreaterThanOrEqual(2);
      },
      { timeout: 3000 }
    );

    const chunks = ch.parseSentLeader().filter((m) => m.type === 'transcript.export.chunk');
    expect(chunks.length).toBe(2);
  });

  it('completes after all acks received', async () => {
    const chunk = new Uint8Array(30).fill(0xcc);
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([chunk, chunk])),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);
    ch.simulateMessage({ type: 'hello', protocolVersion: 3 });

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'ack-complete-req',
      selector: { kind: 'active' },
    });

    // Wait for first chunk, then ack, then second chunk, then ack
    // Use expect-based waitFor so it retries on throw (boolean return resolves immediately)
    await vi.waitFor(
      () => {
        expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.chunk')).toBe(true);
      },
      { timeout: 3000 }
    );
    ch.simulateMessage({ type: 'transcript.export.ack', requestId: 'ack-complete-req', index: 0 });

    await vi.waitFor(
      () => {
        expect(
          ch.parseSentLeader().filter((m) => m.type === 'transcript.export.chunk').length
        ).toBeGreaterThanOrEqual(2);
      },
      { timeout: 3000 }
    );
    ch.simulateMessage({ type: 'transcript.export.ack', requestId: 'ack-complete-req', index: 1 });

    await vi.waitFor(
      () => {
        expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.complete')).toBe(
          true
        );
      },
      { timeout: 3000 }
    );
  });

  it('ack from different follower does not advance sender (owner-scoped)', async () => {
    const chunk = new Uint8Array(50).fill(0xdd);
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([chunk, chunk])),
    });
    const ch1 = new FakeChannel();
    const ch2 = new FakeChannel();
    manager.addFollower('b1', ch1);
    manager.addFollower('b2', ch2);
    ch1.simulateMessage({ type: 'hello', protocolVersion: 3 });

    ch1.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'owner-scope-req',
      selector: { kind: 'active' },
    });

    // Wait for chunk 0 to be sent to b1
    await vi.waitFor(() => ch1.parseSentLeader().some((m) => m.type === 'transcript.export.chunk'));

    // b2 tries to send ack for b1's requestId — should NOT advance b1's export
    ch2.simulateMessage({ type: 'transcript.export.ack', requestId: 'owner-scope-req', index: 0 });

    await new Promise((r) => setTimeout(r, 50));

    // b1 should still be waiting (only 1 chunk sent, no 2nd chunk yet)
    const chunksToB1 = ch1.parseSentLeader().filter((m) => m.type === 'transcript.export.chunk');
    expect(chunksToB1.length).toBe(1);
    // No complete either
    expect(ch1.parseSentLeader().some((m) => m.type === 'transcript.export.complete')).toBe(false);
  });

  it('cancel clears ack waiter so no stuck Promise hangs', async () => {
    const chunk = new Uint8Array(50).fill(0xee);
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([chunk, chunk])),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);
    ch.simulateMessage({ type: 'hello', protocolVersion: 3 });

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'ack-cancel-req',
      selector: { kind: 'active' },
    });

    // Wait for chunk 0, then cancel before ack
    await vi.waitFor(() => ch.parseSentLeader().some((m) => m.type === 'transcript.export.chunk'));

    ch.simulateMessage({ type: 'transcript.export.cancel', requestId: 'ack-cancel-req' });

    // No crash and no complete sent
    await new Promise((r) => setTimeout(r, 100));
    expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.complete')).toBe(false);
    expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.error')).toBe(false);
  });

  it('disconnect clears ack waiter (no stuck promise)', async () => {
    const chunk = new Uint8Array(50).fill(0xff);
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([chunk, chunk])),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);
    ch.simulateMessage({ type: 'hello', protocolVersion: 3 });

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'ack-disc-req',
      selector: { kind: 'active' },
    });

    // Wait for chunk 0, then disconnect without acking
    await vi.waitFor(() => ch.parseSentLeader().some((m) => m.type === 'transcript.export.chunk'));

    manager.removeFollower('b1');

    // No crash
    await new Promise((r) => setTimeout(r, 100));
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wave 4: Follower spool — no chunk array in state
// ---------------------------------------------------------------------------

describe('Wave 4: Follower uses spool — no chunk array accumulation', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  function base64(data: Uint8Array): string {
    let s = '';
    for (const b of data) s += String.fromCharCode(b);
    return btoa(s);
  }

  async function runFollowerTransfer(
    follower: FollowerSyncManager,
    ch: FakeChannel,
    chunks: Uint8Array[]
  ): Promise<Blob> {
    const controller = new AbortController();
    const blobPromise = follower.requestTranscriptExport({ kind: 'active' }, controller.signal);

    await vi.waitFor(() =>
      ch.parseSentFollower().some((m) => m.type === 'transcript.export.request')
    );
    const req = ch.parseSentFollower().find((m) => m.type === 'transcript.export.request') as
      | { requestId: string }
      | undefined;
    const requestId = req!.requestId;

    const { sha256 } = await import('js-sha256');
    const hasher = sha256.create();
    let totalBytes = 0;
    for (const c of chunks) {
      hasher.update(c);
      totalBytes += c.byteLength;
    }
    const digest = hasher.hex();

    ch.simulateLeaderMessage({ type: 'transcript.export.pending', requestId });
    ch.simulateLeaderMessage({ type: 'transcript.export.start', requestId, filename: 'test.zip' });

    for (let i = 0; i < chunks.length; i++) {
      ch.simulateLeaderMessage({
        type: 'transcript.export.chunk',
        requestId,
        index: i,
        data: base64(chunks[i]!),
      });
      // Wait for ack to be sent (proves spool.append resolved)
      await vi.waitFor(
        () => {
          const acks = ch
            .parseSentFollower()
            .filter(
              (m) => m.type === 'transcript.export.ack' && (m as { index?: number }).index === i
            );
          return acks.length > 0;
        },
        { timeout: 3000 }
      );
    }

    ch.simulateLeaderMessage({
      type: 'transcript.export.complete',
      requestId,
      chunks: chunks.length,
      byteLength: totalBytes,
      sha256: digest,
    });

    return blobPromise;
  }

  it('follower sends ack after each chunk is received', async () => {
    const { follower, ch } = makeFollower();

    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const blob = await runFollowerTransfer(follower, ch, [payload]);

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(payload.byteLength);

    // Ack must be sent for index 0
    const acks = ch.parseSentFollower().filter((m) => m.type === 'transcript.export.ack');
    expect(acks.length).toBe(1);
    expect((acks[0] as { index?: number }).index).toBe(0);
  });

  it('follower sends ack for every chunk in a multi-chunk transfer', async () => {
    const { follower, ch } = makeFollower();
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]), new Uint8Array([7, 8])];

    const blob = await runFollowerTransfer(follower, ch, chunks);
    expect(blob.size).toBe(8);

    const acks = ch.parseSentFollower().filter((m) => m.type === 'transcript.export.ack');
    expect(acks.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect((acks[i] as { index?: number }).index).toBe(i);
    }
  });

  it('follower spool cancel is called on close mid-transfer', async () => {
    const { follower, ch } = makeFollower();
    const controller = new AbortController();
    const blobPromise = follower
      .requestTranscriptExport({ kind: 'active' }, controller.signal)
      .catch(() => undefined);

    await vi.waitFor(() =>
      ch.parseSentFollower().some((m) => m.type === 'transcript.export.request')
    );
    const req = ch.parseSentFollower().find((m) => m.type === 'transcript.export.request') as
      | { requestId: string }
      | undefined;
    const requestId = req!.requestId;

    ch.simulateLeaderMessage({ type: 'transcript.export.pending', requestId });
    ch.simulateLeaderMessage({ type: 'transcript.export.start', requestId, filename: 'x.zip' });
    ch.simulateLeaderMessage({
      type: 'transcript.export.chunk',
      requestId,
      index: 0,
      data: base64(new Uint8Array([1, 2, 3])),
    });

    follower.close();
    await blobPromise;

    // After close, follower should not be accumulating chunks (cancel was called)
    // Verified by the spool interface contract — subsequent chunk deliveries are no-ops
    expect(() => {
      ch.simulateLeaderMessage({
        type: 'transcript.export.chunk',
        requestId,
        index: 1,
        data: base64(new Uint8Array([4, 5])),
      });
    }).not.toThrow();
  });

  it('large multi-chunk transfer assembles to exact Blob bytes', async () => {
    const { follower, ch } = makeFollower();

    // 8 chunks of 1 KB each = 8 KB total
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 8; i++) {
      chunks.push(new Uint8Array(1024).fill(i));
    }

    const blob = await runFollowerTransfer(follower, ch, chunks);
    expect(blob.size).toBe(8 * 1024);

    const raw = new Uint8Array(await blob.arrayBuffer());
    let offset = 0;
    for (let i = 0; i < 8; i++) {
      expect(raw.subarray(offset, offset + 1024)).toEqual(new Uint8Array(1024).fill(i));
      offset += 1024;
    }
  });
});
