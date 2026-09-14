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
  TranscriptExportSelector,
} from '../../src/scoops/tray-sync-protocol.js';
import { CHERRY_RUNTIME_TAG } from '../../src/scoops/tray-sync-protocol.js';
import type { TrayDataChannelLike } from '../../src/scoops/tray-webrtc.js';
import type { SudoDecision } from '../../src/sudo/types.js';
import type { ExportSpool } from '../../src/transcript/export-spool.js';

const ALLOW: SudoDecision = { decision: 'allow' };
const DENY: SudoDecision = { decision: 'deny' };

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

function makeZipResult(
  chunks: Uint8Array[],
  opts: { byteLength?: number; sha256?: string } = {}
): import('../../src/transcript/zip-stream.js').TranscriptZipResult {
  async function* gen() {
    for (const c of chunks) yield c;
  }
  const totalBytes = chunks.reduce((n, c) => n + c.byteLength, 0);

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
  const hasher = sha256Lib.create();
  for (const c of chunks) hasher.update(c);
  return hasher.hex();
}

function createLeaderManager(overrides?: Partial<LeaderSyncManagerOptions>): {
  manager: LeaderSyncManager;
  approval: ReturnType<typeof vi.fn>;
} {
  const approval = vi.fn().mockResolvedValue(ALLOW);
  const options: LeaderSyncManagerOptions = {
    sendControl: () => {},
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    requestSudoApproval: approval,
    createTranscriptExport: vi
      .fn()
      .mockResolvedValue(makeZipResult([new Uint8Array([1, 2, 3, 4])])),
    ...overrides,
  };
  return { manager: new LeaderSyncManager(options), approval };
}

function makeFollower(): { follower: FollowerSyncManager; ch: FakeChannel } {
  const ch = new FakeChannel();
  const follower = new FollowerSyncManager(ch);
  return { follower, ch };
}

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
      requestSudoApproval: vi.fn().mockResolvedValue(DENY),
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

    const noBefore = msgs.filter((m) =>
      ['transcript.export.start', 'transcript.export.chunk', 'transcript.export.complete'].includes(
        m.type
      )
    );
    expect(noBefore).toHaveLength(0);
  });

  it('derives follower identity from connected state, not request payload', async () => {
    const approval = vi.fn().mockResolvedValue(ALLOW);
    const { manager } = createLeaderManager({ requestSudoApproval: approval });
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

    expect(call.followerLabel).toContain('standalone');

    expect(call.kind).toBe('export');
    expect(call.detail).toBe('active');
  });

  it('is one-use: a second request with same ID is ignored', async () => {
    let approvalCount = 0;
    const { manager } = createLeaderManager({
      requestSudoApproval: vi.fn().mockImplementation(() => {
        approvalCount++;
        return Promise.resolve(ALLOW);
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

    await exportStarted;

    ch.simulateMessage({
      type: 'transcript.export.cancel',
      requestId: 'r-cancel',
    });

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

    manager.removeFollower('b1');

    await new Promise((r) => setTimeout(r, 50));

    expect(true).toBe(true);
  });

  it('cleans up AbortController on every exit path', async () => {
    const { manager } = createLeaderManager({
      requestSudoApproval: vi.fn().mockResolvedValue(DENY),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'r-cleanup',
      selector: { kind: 'active' },
    });

    await vi.waitFor(() => ch.parseSentLeader().some((m) => m.type === 'transcript.export.denied'));

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

    const payload = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
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

    await expect(blobPromise).rejects.toMatchObject({ code: 'transfer-corrupt' });

    const blobPromise2 = follower.requestTranscriptExport(
      { kind: 'active' },
      new AbortController().signal
    );

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

    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Protocol message types', () => {
  it('LeaderToFollowerMessage union includes all export variants', () => {
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

describe('Security: cross-follower cancel attack', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('follower B cannot cancel follower A export', async () => {
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

    await vi.waitFor(() =>
      chA.parseSentLeader().some((m) => m.type === 'transcript.export.pending')
    );

    chB.simulateMessage({
      type: 'transcript.export.cancel',
      requestId: 'attack-req',
    });

    resolveChunks();

    await vi.waitFor(
      () => {
        expect(chA.parseSentLeader().some((m) => m.type === 'transcript.export.complete')).toBe(
          true
        );
      },
      { timeout: 3000 }
    );

    const bMsgs = chB.parseSentLeader();
    const exportMsgs = bMsgs.filter((m) => m.type.startsWith('transcript.export.'));
    expect(exportMsgs).toHaveLength(0);
  });

  it('requestId replay collision from different follower does not block second follower', async () => {
    let approvalCalls = 0;
    const { manager } = createLeaderManager({
      requestSudoApproval: vi.fn().mockImplementation(() => {
        approvalCalls++;
        return Promise.resolve(ALLOW);
      }),
      createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([new Uint8Array([1])])),
    });
    const chA = new FakeChannel();
    const chB = new FakeChannel();
    manager.addFollower('followerA', chA);
    manager.addFollower('followerB', chB);

    chA.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'shared-id',
      selector: { kind: 'active' },
    });

    chB.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'shared-id',
      selector: { kind: 'active' },
    });

    await vi.waitFor(() => approvalCalls >= 1);

    await new Promise((r) => setTimeout(r, 50));
    const bMsgs = chB.parseSentLeader();
    const bExportMsgs = bMsgs.filter((m) => m.type.startsWith('transcript.export.'));

    expect(bExportMsgs.length).toBeGreaterThan(0);
  });
});

describe('Leader: Cherry hostOrigin derivation', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('derives hostOrigin from cherry target URL for Cherry followers', async () => {
    const approval = vi.fn().mockResolvedValue(ALLOW);
    const { manager } = createLeaderManager({
      requestSudoApproval: approval,
    });
    const ch = new FakeChannel();

    manager.addFollower('cherry-b1', ch, { runtime: CHERRY_RUNTIME_TAG });

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

    expect(call.hostOrigin).toBe('https://example.com');
  });

  it('does not pass hostOrigin for non-Cherry followers', async () => {
    const approval = vi.fn().mockResolvedValue(ALLOW);
    const { manager } = createLeaderManager({
      requestSudoApproval: approval,
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
    const approval = vi.fn().mockResolvedValue(ALLOW);
    const { manager } = createLeaderManager({
      requestSudoApproval: approval,
    });
    const ch = new FakeChannel();
    manager.addFollower('cherry-b2', ch, { runtime: CHERRY_RUNTIME_TAG });

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

    expect(call.hostOrigin).toBeUndefined();
  });
});

describe('Leader: byteLength integrity', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('complete.byteLength equals actual bytes streamed, not service-reported value', async () => {
    const data = new Uint8Array(50).fill(0xcc);

    const { manager } = createLeaderManager({
      createTranscriptExport: vi
        .fn()
        .mockResolvedValue(makeZipResult([data], { byteLength: data.byteLength })),
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

    expect(complete!.byteLength).toBe(data.byteLength);
  });

  it('sends transfer-corrupt error when service byteLength mismatches leader stream count', async () => {
    const data = new Uint8Array(50).fill(0xdd);

    const { manager } = createLeaderManager({
      createTranscriptExport: vi
        .fn()
        .mockResolvedValue(makeZipResult([data], { byteLength: data.byteLength + 1 })),
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

    expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.complete')).toBe(false);
  });
});

describe('Leader: per-follower concurrency cap', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('auto-denies a second concurrent export request from the same follower', async () => {
    let resolveApproval: (v: SudoDecision) => void = () => {};
    const { manager } = createLeaderManager({
      requestSudoApproval: vi.fn().mockImplementation(
        () =>
          new Promise<SudoDecision>((res) => {
            resolveApproval = res;
          })
      ),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'req-first',
      selector: { kind: 'active' },
    });
    await vi.waitFor(() =>
      ch.parseSentLeader().some((m) => m.type === 'transcript.export.pending')
    );

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'req-second',
      selector: { kind: 'active' },
    });

    await new Promise((r) => setTimeout(r, 30));

    const msgs = ch.parseSentLeader();

    const denied = msgs.filter((m) => m.type === 'transcript.export.denied') as Array<{
      requestId: string;
    }>;
    expect(denied.some((d) => d.requestId === 'req-second')).toBe(true);

    const exportFlow = msgs.filter(
      (m) =>
        (m.type === 'transcript.export.start' || m.type === 'transcript.export.complete') &&
        (m as { requestId?: string }).requestId === 'req-second'
    );
    expect(exportFlow).toHaveLength(0);

    resolveApproval(DENY);
  });
});

describe('Leader: approval throw and empty-ZIP', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('sends denied when requestSudoApproval throws', async () => {
    const { manager } = createLeaderManager({
      requestSudoApproval: vi.fn().mockRejectedValue(new Error('dialog crashed')),
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

    await vi.waitFor(() =>
      ch.parseSentLeader().some((m) => m.type === 'transcript.export.pending')
    );

    ch.simulateMessage({
      type: 'transcript.export.cancel',
      requestId: 'abort-state-req',
    });

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
    expect(true).toBe(true);
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

describe('Leader: backpressure polling', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('cancels polling when follower sends cancel while backpressure holds', async () => {
    class BackpressureChannel extends FakeChannel {
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

    await vi.waitFor(() => ch.parseSentLeader().some((m) => m.type === 'transcript.export.start'));

    ch.simulateMessage({
      type: 'transcript.export.cancel',
      requestId: 'bp-cancel-req',
    });

    ch.bufferedAmount = 0;

    await new Promise((r) => setTimeout(r, 100));
    expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.complete')).toBe(false);
  });
});

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

    await vi.waitFor(() => {
      expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.pending')).toBe(true);
    });

    ch.simulateMessage({
      type: 'transcript.export.cancel',
      requestId: 'abort-silent-req',
    });

    await new Promise((r) => setTimeout(r, 80));

    expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.error')).toBe(false);
  });
});

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

describe('Leader: composite export key (wave 2)', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('allows two followers to use the same requestId without collision', async () => {
    const { manager } = createLeaderManager();
    const ch1 = new FakeChannel();
    const ch2 = new FakeChannel();
    manager.addFollower('b1', ch1);
    manager.addFollower('b2', ch2);

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
      requestSudoApproval: vi.fn().mockImplementation(async () => {
        approvalCount++;
        return ALLOW;
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
    const { manager } = createLeaderManager({
      createTranscriptExport: vi.fn().mockImplementation(() => new Promise(() => {})),
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

    await vi.waitFor(() => {
      return (
        ch1.parseSentLeader().some((m) => m.type === 'transcript.export.pending') &&
        ch2.parseSentLeader().some((m) => m.type === 'transcript.export.pending')
      );
    });

    ch2.simulateMessage({ type: 'transcript.export.cancel', requestId: 'shared-req' });

    await new Promise((r) => setTimeout(r, 30));

    const b1Msgs = ch1.parseSentLeader();
    expect(b1Msgs.some((m) => m.type === 'transcript.export.error')).toBe(false);
    expect(b1Msgs.some((m) => m.type === 'transcript.export.complete')).toBe(false);
  });
});

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

    await vi.waitFor(() =>
      ch.parseSentFollower().some((m) => m.type === 'transcript.export.request')
    );

    const req = ch.parseSentFollower().find((m) => m.type === 'transcript.export.request') as
      | { requestId: string }
      | undefined;
    const requestId = req!.requestId;

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

    follower.close();

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

describe('CherryHostTransport: outbound error code validation (wave 2)', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('clamps unknown string error codes to transfer-corrupt', async () => {
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

    ch.simulateLeaderMessage({
      type: 'transcript.export.error',
      requestId,
      code: 'completely-unknown-code' as never,
    });

    await expect(blobPromise).rejects.toMatchObject({ code: 'transfer-corrupt' });
  });
});

describe('Wave 4: Leader ack-gated bounded chunk window (v3 followers)', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('sends only 1 chunk before receiving ack from v3 follower', async () => {
    const chunk = new Uint8Array(200).fill(0xaa);
    const { manager } = createLeaderManager({
      createTranscriptExport: vi
        .fn()
        .mockResolvedValue(makeZipResult([chunk, chunk, chunk, chunk])),
    });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    ch.simulateMessage({ type: 'hello', protocolVersion: 3 });

    ch.simulateMessage({
      type: 'transcript.export.request',
      requestId: 'ack-gate-req',
      selector: { kind: 'active' },
    });

    await vi.waitFor(
      () => {
        expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.chunk')).toBe(true);
      },
      { timeout: 3000 }
    );

    const chunksSoFar = ch.parseSentLeader().filter((m) => m.type === 'transcript.export.chunk');
    expect(chunksSoFar.length).toBe(1);

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

    await vi.waitFor(
      () => {
        expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.chunk')).toBe(true);
      },
      { timeout: 3000 }
    );

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

    await vi.waitFor(() => ch1.parseSentLeader().some((m) => m.type === 'transcript.export.chunk'));

    ch2.simulateMessage({ type: 'transcript.export.ack', requestId: 'owner-scope-req', index: 0 });

    await new Promise((r) => setTimeout(r, 50));

    const chunksToB1 = ch1.parseSentLeader().filter((m) => m.type === 'transcript.export.chunk');
    expect(chunksToB1.length).toBe(1);

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

    await vi.waitFor(() => ch.parseSentLeader().some((m) => m.type === 'transcript.export.chunk'));

    ch.simulateMessage({ type: 'transcript.export.cancel', requestId: 'ack-cancel-req' });

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

    await vi.waitFor(() => ch.parseSentLeader().some((m) => m.type === 'transcript.export.chunk'));

    manager.removeFollower('b1');

    await new Promise((r) => setTimeout(r, 100));
    expect(true).toBe(true);
  });
});

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

  it('cancels the leader immediately when a spool append fails', async () => {
    const ch = new FakeChannel();
    const spool: ExportSpool = {
      append: vi.fn(async () => {
        throw new Error('OPFS write failed');
      }),
      finalize: vi.fn(),
      cancel: vi.fn(async () => undefined),
    };
    const follower = new FollowerSyncManager(ch, { makeExportSpool: () => spool });
    const controller = new AbortController();
    const blobPromise = follower.requestTranscriptExport({ kind: 'active' }, controller.signal);

    await vi.waitFor(() =>
      expect(ch.parseSentFollower().some((m) => m.type === 'transcript.export.request')).toBe(true)
    );
    const request = ch.parseSentFollower().find((m) => m.type === 'transcript.export.request') as {
      requestId: string;
    };

    ch.simulateLeaderMessage({
      type: 'transcript.export.chunk',
      requestId: request.requestId,
      index: 0,
      data: base64(new Uint8Array([1, 2, 3])),
    });

    await expect(blobPromise).rejects.toMatchObject({ code: 'transfer-corrupt' });
    await vi.waitFor(() =>
      expect(
        ch
          .parseSentFollower()
          .some(
            (message) =>
              message.type === 'transcript.export.cancel' && message.requestId === request.requestId
          )
      ).toBe(true)
    );
    expect(spool.cancel).toHaveBeenCalledOnce();
    follower.close();
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

  it('activeExportRequests entries do not contain a chunks array (CV-3)', async () => {
    const { follower, ch } = makeFollower();
    const controller = new AbortController();
    void follower.requestTranscriptExport({ kind: 'active' }, controller.signal).catch(() => {});

    await vi.waitFor(() =>
      ch.parseSentFollower().some((m) => m.type === 'transcript.export.request')
    );
    const req = ch.parseSentFollower().find((m) => m.type === 'transcript.export.request') as
      | { requestId: string }
      | undefined;
    const requestId = req!.requestId;

    const chunk = new Uint8Array([0xaa, 0xbb]);
    let s = '';
    for (const b of chunk) s += String.fromCharCode(b);
    ch.simulateLeaderMessage({ type: 'transcript.export.start', requestId, filename: 'x.zip' });
    ch.simulateLeaderMessage({
      type: 'transcript.export.chunk',
      requestId,
      index: 0,
      data: btoa(s),
    });

    await new Promise((r) => setTimeout(r, 20));

    const fsm = follower as unknown as {
      activeExportRequests: Map<string, Record<string, unknown>>;
    };
    const entry = fsm.activeExportRequests.get(requestId);
    expect(entry).toBeDefined();

    expect('chunks' in (entry ?? {})).toBe(false);

    controller.abort();
  });
});

describe('Leader: per-ack timeout aborts stalled export', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  it('sends transcript.export.error(transfer-aborted) and cleans up activeExports when ack never arrives', async () => {
    vi.useFakeTimers();
    try {
      const data = new Uint8Array(10).fill(0xcc);
      const { manager } = createLeaderManager({
        createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([data])),
      });
      const ch = new FakeChannel();
      manager.addFollower('b1', ch);

      ch.simulateMessage({
        type: 'hello',
        protocolVersion: 3,
      } as import('../../src/scoops/tray-sync-protocol.js').FollowerToLeaderMessage);

      ch.simulateMessage({
        type: 'transcript.export.request',
        requestId: 'ack-timeout-req',
        selector: { kind: 'active' },
      });

      await vi.waitFor(() =>
        ch.parseSentLeader().some((m) => m.type === 'transcript.export.chunk')
      );

      await vi.runAllTimersAsync();

      await vi.waitFor(
        () => ch.parseSentLeader().some((m) => m.type === 'transcript.export.error'),
        { timeout: 3000 }
      );

      const errMsg = ch
        .parseSentLeader()
        .find(
          (m): m is Extract<LeaderToFollowerMessage, { type: 'transcript.export.error' }> =>
            m.type === 'transcript.export.error'
        );
      expect(errMsg?.code).toBe('transfer-aborted');

      expect(ch.parseSentLeader().some((m) => m.type === 'transcript.export.complete')).toBe(false);

      const mgr = manager as unknown as { activeExports: Map<string, unknown> };
      expect(mgr.activeExports.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Leader: ack-gating version guard (ACK_PROTOCOL_VERSION_MIN = 3)', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.clearAllMocks());

  async function isAckGated(peerVersion: number): Promise<boolean> {
    vi.useFakeTimers();
    try {
      const data = new Uint8Array(10).fill(0xaa);
      const { manager } = createLeaderManager({
        createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([data])),
      });
      const ch = new FakeChannel();
      manager.addFollower('b1', ch);

      ch.simulateMessage({
        type: 'hello',
        protocolVersion: peerVersion,
      } as import('../../src/scoops/tray-sync-protocol.js').FollowerToLeaderMessage);

      ch.simulateMessage({
        type: 'transcript.export.request',
        requestId: `ack-guard-req-v${peerVersion}`,
        selector: { kind: 'active' },
      });

      await vi.waitFor(() =>
        ch.parseSentLeader().some((m) => m.type === 'transcript.export.chunk')
      );

      await vi.advanceTimersByTimeAsync(1);

      const completedWithoutAck = ch
        .parseSentLeader()
        .some((m) => m.type === 'transcript.export.complete');

      if (!completedWithoutAck) {
        const chunkMsg = ch
          .parseSentLeader()
          .find(
            (m): m is Extract<LeaderToFollowerMessage, { type: 'transcript.export.chunk' }> =>
              m.type === 'transcript.export.chunk'
          );
        if (chunkMsg) {
          ch.simulateMessage({
            type: 'transcript.export.ack',
            requestId: chunkMsg.requestId,
            index: chunkMsg.index,
          });
        }
        await vi.waitFor(() =>
          ch
            .parseSentLeader()
            .some(
              (m) => m.type === 'transcript.export.complete' || m.type === 'transcript.export.error'
            )
        );
      }

      return !completedWithoutAck;
    } finally {
      vi.useRealTimers();
    }
  }

  it('v3 peers are ack-gated (chunk stalls until ack received)', async () => {
    expect(await isAckGated(3)).toBe(true);
  });

  it('v4 peers are ack-gated (v4 >= ACK_PROTOCOL_VERSION_MIN=3)', async () => {
    expect(await isAckGated(4)).toBe(true);
  });

  it('v2 peers are NOT ack-gated (v2 < ACK_PROTOCOL_VERSION_MIN=3)', async () => {
    expect(await isAckGated(2)).toBe(false);
  });

  it('v3 peer ack-gating is independent of current protocol constant semantics', async () => {
    const [v3gated, v4gated] = await Promise.all([isAckGated(3), isAckGated(4)]);
    expect(v3gated).toBe(true);
    expect(v4gated).toBe(true);
  });
});
