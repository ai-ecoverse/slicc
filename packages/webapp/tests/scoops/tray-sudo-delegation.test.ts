/**
 * Delegated sudo approval over the tray (issue #2062).
 *
 * The leader's native approval surface is wherever the leader tab runs; when
 * the human is driving from a follower (or the leader is headless), the prompt
 * goes to the followers' humans instead. These tests pin the routing policy,
 * the first-verdict-wins race, the biometric-only `always`, the push wake-up,
 * the follower-side handler, and the transcript-export fold.
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
import type { SudoDecision } from '../../src/sudo/types.js';

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

  find<T>(type: string): T | undefined {
    return this.sent.map((s) => JSON.parse(s) as T & { type: string }).find((m) => m.type === type);
  }

  all<T>(type: string): T[] {
    return this.sent
      .map((s) => JSON.parse(s) as T & { type: string })
      .filter((m) => m.type === type);
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function makeLeader(overrides?: Partial<LeaderSyncManagerOptions>): {
  manager: LeaderSyncManager;
  control: ReturnType<typeof vi.fn>;
} {
  const control = vi.fn();
  const manager = new LeaderSyncManager({
    sendControl: control,
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    ...overrides,
  });
  return { manager, control };
}

function hello(
  ch: FakeChannel,
  capabilities: { sudoApproval?: boolean; biometric?: boolean; exec?: boolean } = {}
): void {
  ch.simulate({
    type: 'hello',
    protocolVersion: 7,
    runtime: 'slicc-ios',
    capabilities: { exec: false, ...capabilities },
  } as FollowerToLeaderMessage);
}

function addFollower(
  manager: LeaderSyncManager,
  id: string,
  capabilities?: { sudoApproval?: boolean; biometric?: boolean }
): FakeChannel {
  const ch = new FakeChannel();
  manager.addFollower(id, ch, { runtime: 'slicc-ios' });
  if (capabilities) hello(ch, capabilities);
  return ch;
}

const REQUEST = {
  kind: 'command' as const,
  detail: 'git push origin main',
  suggestedPattern: 'git push *',
};

beforeEach(() => {
  resetLoggerDedupForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Routing policy
// ---------------------------------------------------------------------------

describe('shouldDelegateSudo', () => {
  it('is false with no followers on an interactive leader', () => {
    const { manager } = makeLeader();
    expect(manager.shouldDelegateSudo()).toBe(false);
  });

  it('is true unconditionally on a headless leader (even with nobody connected)', () => {
    const { manager } = makeLeader({ headlessLeader: true });
    expect(manager.shouldDelegateSudo()).toBe(true);
  });

  it('needs a sudoApproval-capable follower AND the human to be on a follower', () => {
    const { manager } = makeLeader();
    const ch = addFollower(manager, 'phone', { sudoApproval: true });
    // Capable follower connected, but the last user message came from the leader UI.
    manager.noteLeaderUserMessage();
    expect(manager.shouldDelegateSudo()).toBe(false);

    ch.simulate({ type: 'user_message', text: 'hi', messageId: 'm1' } as FollowerToLeaderMessage);
    expect(manager.shouldDelegateSudo()).toBe(true);
  });

  it('ignores followers that never advertised sudoApproval', () => {
    const { manager } = makeLeader();
    const ch = addFollower(manager, 'tab', { sudoApproval: false });
    ch.simulate({ type: 'user_message', text: 'hi', messageId: 'm1' } as FollowerToLeaderMessage);
    expect(manager.shouldDelegateSudo()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Delegation lifecycle
// ---------------------------------------------------------------------------

describe('delegateSudoApproval', () => {
  it('sends sudo.approve.request to every capable follower with the dialog fields', async () => {
    const { manager } = makeLeader();
    const phone = addFollower(manager, 'phone', { sudoApproval: true, biometric: true });
    const tab = addFollower(manager, 'tab', { sudoApproval: true });
    const cli = addFollower(manager, 'cli', { sudoApproval: false });

    const pending = manager.delegateSudoApproval(REQUEST, { scoopName: 'Researcher' });
    await flush();

    const prompt = phone.find<{
      type: string;
      requestId: string;
      kind: string;
      detail: string;
      suggestedPattern?: string;
      scoopName?: string;
      expiresAt: number;
    }>('sudo.approve.request');
    expect(prompt).toMatchObject({
      kind: 'command',
      detail: 'git push origin main',
      suggestedPattern: 'git push *',
      scoopName: 'Researcher',
    });
    expect(typeof prompt?.expiresAt).toBe('number');
    expect(tab.types()).toContain('sudo.approve.request');
    expect(cli.types()).not.toContain('sudo.approve.request');

    phone.simulate({
      type: 'sudo.approve.response',
      requestId: prompt?.requestId ?? '',
      decision: 'allow',
      attestation: 'biometric',
    } as FollowerToLeaderMessage);
    expect(await pending).toEqual({ decision: 'allow', attestation: 'biometric' });
  });

  it('first verdict wins and the losers get sudo.approve.cancel', async () => {
    const { manager } = makeLeader();
    const phone = addFollower(manager, 'phone', { sudoApproval: true, biometric: true });
    const tab = addFollower(manager, 'tab', { sudoApproval: true });
    const pending = manager.delegateSudoApproval(REQUEST);
    await flush();
    const requestId = tab.find<{ requestId: string }>('sudo.approve.request')?.requestId ?? '';

    tab.simulate({
      type: 'sudo.approve.response',
      requestId,
      decision: 'deny',
    } as FollowerToLeaderMessage);
    expect(await pending).toEqual({ decision: 'deny' });
    expect(phone.find<{ requestId: string }>('sudo.approve.cancel')?.requestId).toBe(requestId);
    expect(tab.types()).not.toContain('sudo.approve.cancel');

    // A late verdict from the loser changes nothing.
    phone.simulate({
      type: 'sudo.approve.response',
      requestId,
      decision: 'allow',
    } as FollowerToLeaderMessage);
    await flush();
  });

  it('accepts "always" (with the edited pattern) only from a biometric follower', async () => {
    const { manager } = makeLeader();
    const phone = addFollower(manager, 'phone', { sudoApproval: true, biometric: true });
    let pending = manager.delegateSudoApproval(REQUEST);
    await flush();
    let requestId = phone.find<{ requestId: string }>('sudo.approve.request')?.requestId ?? '';
    phone.simulate({
      type: 'sudo.approve.response',
      requestId,
      decision: 'always',
      pattern: 'git push origin *',
      attestation: 'passcode',
    } as FollowerToLeaderMessage);
    expect(await pending).toEqual({
      decision: 'always',
      pattern: 'git push origin *',
      attestation: 'passcode',
    });

    // An empty pattern falls back to the suggestion, never the raw detail widening.
    pending = manager.delegateSudoApproval(REQUEST);
    await flush();
    requestId = phone.all<{ requestId: string }>('sudo.approve.request')[1]?.requestId ?? '';
    phone.simulate({
      type: 'sudo.approve.response',
      requestId,
      decision: 'always',
      pattern: '   ',
    } as FollowerToLeaderMessage);
    expect(await pending).toMatchObject({ decision: 'always', pattern: 'git push *' });
  });

  it('downgrades "always" from a non-biometric follower to a one-shot allow', async () => {
    const { manager } = makeLeader();
    const tab = addFollower(manager, 'tab', { sudoApproval: true });
    const pending = manager.delegateSudoApproval(REQUEST);
    await flush();
    const requestId = tab.find<{ requestId: string }>('sudo.approve.request')?.requestId ?? '';
    tab.simulate({
      type: 'sudo.approve.response',
      requestId,
      decision: 'always',
      pattern: '*',
    } as FollowerToLeaderMessage);
    const verdict = await pending;
    expect(verdict.decision).toBe('allow');
    expect(verdict).not.toHaveProperty('pattern');
  });

  it('treats a malformed decision as deny', async () => {
    const { manager } = makeLeader();
    const phone = addFollower(manager, 'phone', { sudoApproval: true, biometric: true });
    const pending = manager.delegateSudoApproval(REQUEST);
    await flush();
    const requestId = phone.find<{ requestId: string }>('sudo.approve.request')?.requestId ?? '';
    phone.simulate({
      type: 'sudo.approve.response',
      requestId,
      decision: 'yes please',
    } as unknown as FollowerToLeaderMessage);
    expect(await pending).toEqual({ decision: 'deny' });
  });

  it('ignores a verdict from a follower that was never prompted', async () => {
    const { manager } = makeLeader();
    const phone = addFollower(manager, 'phone', { sudoApproval: true, biometric: true });
    const pending = manager.delegateSudoApproval(REQUEST);
    await flush();
    const requestId = phone.find<{ requestId: string }>('sudo.approve.request')?.requestId ?? '';
    // A second, uncapable follower tries to answer on the phone's behalf.
    const intruder = addFollower(manager, 'intruder', { sudoApproval: false });
    intruder.simulate({
      type: 'sudo.approve.response',
      requestId,
      decision: 'allow',
    } as FollowerToLeaderMessage);
    await flush();

    phone.simulate({
      type: 'sudo.approve.response',
      requestId,
      decision: 'deny',
    } as FollowerToLeaderMessage);
    expect(await pending).toEqual({ decision: 'deny' });
  });

  it('denies when nobody answers before the deadline (bounded wait)', async () => {
    vi.useFakeTimers();
    const { manager } = makeLeader();
    const phone = addFollower(manager, 'phone', { sudoApproval: true, biometric: true });
    const pending = manager.delegateSudoApproval(REQUEST);
    await vi.advanceTimersByTimeAsync(0);
    expect(phone.types()).toContain('sudo.approve.request');
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 10);
    expect(await pending).toEqual({ decision: 'deny' });
    expect(phone.types()).toContain('sudo.approve.cancel');
  });

  it('denies when every prompted follower disconnects (interactive leader)', async () => {
    const { manager } = makeLeader();
    addFollower(manager, 'phone', { sudoApproval: true, biometric: true });
    const pending = manager.delegateSudoApproval(REQUEST);
    await flush();
    manager.removeFollower('phone');
    expect(await pending).toEqual({ decision: 'deny' });
  });

  it('denies at once on an interactive leader with no capable follower', async () => {
    const { manager } = makeLeader();
    addFollower(manager, 'cli', { sudoApproval: false });
    expect(await manager.delegateSudoApproval(REQUEST)).toEqual({ decision: 'deny' });
  });

  it('asks the hub to push-wake phones with metadata only', async () => {
    const { manager, control } = makeLeader();
    addFollower(manager, 'phone', { sudoApproval: true, biometric: true });
    const pending = manager.delegateSudoApproval(REQUEST, { scoopName: 'Researcher' });
    await flush();
    const push = control.mock.calls.map((c) => c[0]).find((m) => m.type === 'push.send');
    expect(push).toMatchObject({
      type: 'push.send',
      category: 'sudo_request',
      label: 'Researcher',
    });
    expect(JSON.stringify(push)).not.toContain('git push');
    manager.removeFollower('phone');
    await pending;
  });
});

// ---------------------------------------------------------------------------
// Headless leader: park + wake-up path
// ---------------------------------------------------------------------------

describe('headless leader parks the prompt until a capable follower arrives', () => {
  it('delivers the prompt on the first sudo-capable hello and settles on its verdict', async () => {
    const { manager, control } = makeLeader({ headlessLeader: true });
    const pending = manager.delegateSudoApproval(REQUEST);
    await flush();
    // Nobody connected: not denied, push sent.
    expect(control.mock.calls.some((c) => c[0].type === 'push.send')).toBe(true);

    const phone = addFollower(manager, 'phone');
    await flush();
    expect(phone.types()).not.toContain('sudo.approve.request');
    hello(phone, { sudoApproval: true, biometric: true });
    await flush();
    const requestId = phone.find<{ requestId: string }>('sudo.approve.request')?.requestId ?? '';
    expect(requestId).not.toBe('');

    phone.simulate({
      type: 'sudo.approve.response',
      requestId,
      decision: 'allow',
      attestation: 'biometric',
    } as FollowerToLeaderMessage);
    expect(await pending).toEqual({ decision: 'allow', attestation: 'biometric' });
  });

  it('keeps waiting when the only prompted follower drops, then times out', async () => {
    vi.useFakeTimers();
    const { manager } = makeLeader({ headlessLeader: true });
    addFollower(manager, 'phone', { sudoApproval: true, biometric: true });
    const pending = manager.delegateSudoApproval(REQUEST);
    await vi.advanceTimersByTimeAsync(0);
    manager.removeFollower('phone');
    await vi.advanceTimersByTimeAsync(1000);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(await pending).toEqual({ decision: 'deny' });
  });
});

// ---------------------------------------------------------------------------
// Push registration
// ---------------------------------------------------------------------------

describe('push.register', () => {
  const TOKEN = 'a'.repeat(64);

  it('forwards a well-formed registration to the hub with the channel-derived bootstrap id', () => {
    const { manager, control } = makeLeader();
    const phone = addFollower(manager, 'phone', { sudoApproval: true });
    phone.simulate({
      type: 'push.register',
      platform: 'ios',
      token: TOKEN,
      environment: 'sandbox',
    } as FollowerToLeaderMessage);
    expect(control).toHaveBeenCalledWith({
      type: 'push.register',
      bootstrapId: 'phone',
      platform: 'ios',
      token: TOKEN,
      environment: 'sandbox',
    });
  });

  it('drops malformed tokens and unknown platforms', () => {
    const { manager, control } = makeLeader();
    const phone = addFollower(manager, 'phone', { sudoApproval: true });
    phone.simulate({
      type: 'push.register',
      platform: 'ios',
      token: 'not hex!',
      environment: 'sandbox',
    } as FollowerToLeaderMessage);
    phone.simulate({
      type: 'push.register',
      platform: 'android',
      token: TOKEN,
      environment: 'sandbox',
    } as unknown as FollowerToLeaderMessage);
    expect(control.mock.calls.filter((c) => c[0].type === 'push.register')).toHaveLength(0);
  });

  it('turn_end pushes only once some follower registered a token', () => {
    const { manager, control } = makeLeader();
    const phone = addFollower(manager, 'phone', { sudoApproval: true });
    manager.notifyTurnEnd('SLICC');
    expect(control.mock.calls.filter((c) => c[0].type === 'push.send')).toHaveLength(0);
    phone.simulate({
      type: 'push.register',
      platform: 'ios',
      token: TOKEN,
      environment: 'production',
    } as FollowerToLeaderMessage);
    manager.notifyTurnEnd('SLICC');
    expect(control).toHaveBeenCalledWith({
      type: 'push.send',
      category: 'turn_end',
      label: 'SLICC',
    });
  });
});

// ---------------------------------------------------------------------------
// Follower — renders the prompt, replies fail-closed
// ---------------------------------------------------------------------------

describe('Follower: delegated sudo handler', () => {
  const PROMPT = {
    type: 'sudo.approve.request',
    requestId: 'sudo-9',
    kind: 'command',
    detail: 'git push origin main',
    suggestedPattern: 'git push *',
    expiresAt: 1750000300000,
  } as LeaderToFollowerMessage;

  it('calls the handler with the dialog fields and replies with its verdict', async () => {
    const ch = new FakeChannel();
    const onSudo = vi
      .fn()
      .mockResolvedValue({ decision: 'always', pattern: 'git push *', attestation: 'none' });
    new FollowerSyncManager(ch, { onSudoApprovalRequest: onSudo });
    ch.simulate(PROMPT);
    await flush();
    expect(onSudo).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'sudo-9',
        kind: 'command',
        detail: 'git push origin main',
      })
    );
    expect(ch.find('sudo.approve.response')).toMatchObject({
      requestId: 'sudo-9',
      decision: 'always',
      pattern: 'git push *',
      attestation: 'none',
    });
  });

  it('fails closed with no handler wired', async () => {
    const ch = new FakeChannel();
    new FollowerSyncManager(ch, {});
    ch.simulate(PROMPT);
    await flush();
    expect(ch.find('sudo.approve.response')).toMatchObject({
      requestId: 'sudo-9',
      decision: 'deny',
    });
  });

  it('fails closed when the dialog throws', async () => {
    const ch = new FakeChannel();
    new FollowerSyncManager(ch, {
      onSudoApprovalRequest: vi.fn().mockRejectedValue(new Error('dialog crashed')),
    });
    ch.simulate(PROMPT);
    await flush();
    expect(ch.find('sudo.approve.response')).toMatchObject({ decision: 'deny' });
  });

  it('aborts the open dialog on sudo.approve.cancel and never reports a late Allow', async () => {
    const ch = new FakeChannel();
    let settle: ((v: SudoDecision) => void) | undefined;
    let signal: AbortSignal | undefined;
    new FollowerSyncManager(ch, {
      onSudoApprovalRequest: (req) => {
        signal = req.signal;
        return new Promise<SudoDecision>((res) => {
          settle = res;
          req.signal.addEventListener('abort', () => res({ decision: 'deny' }), { once: true });
        });
      },
    });
    ch.simulate(PROMPT);
    await flush();
    expect(signal?.aborted).toBe(false);

    ch.simulate({ type: 'sudo.approve.cancel', requestId: 'sudo-9' } as LeaderToFollowerMessage);
    await flush();
    expect(signal?.aborted).toBe(true);
    settle?.({ decision: 'allow' });
    await flush();
    expect(ch.find('sudo.approve.response')).toMatchObject({ decision: 'deny' });
  });
});

// ---------------------------------------------------------------------------
// Transcript export is a sudo action now
// ---------------------------------------------------------------------------

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

describe('transcript export goes through requestSudoApproval', () => {
  it('asks with kind "export" and the sudoers subject, and streams on allow/always', async () => {
    const requestSudoApproval = vi
      .fn()
      .mockResolvedValue({ decision: 'always', pattern: 'active' });
    const { manager } = makeLeader({
      requestSudoApproval,
      createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([new Uint8Array([1, 2, 3])])),
    });
    const ch = addFollower(manager, 'tab');
    ch.simulate({
      type: 'transcript.export.request',
      requestId: 'te-1',
      selector: { kind: 'frozen', sessionId: 'sess-42' },
    } as FollowerToLeaderMessage);
    await vi.waitFor(() => expect(ch.types()).toContain('transcript.export.start'));
    expect(requestSudoApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'export',
        detail: 'frozen:sess-42',
        suggestedPattern: 'frozen:sess-42',
      })
    );
  });

  it('denies the export when the sudo gate denies, and when no gate is wired', async () => {
    const { manager } = makeLeader({
      requestSudoApproval: vi.fn().mockResolvedValue({ decision: 'deny' }),
      createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([new Uint8Array([1])])),
    });
    const ch = addFollower(manager, 'tab');
    ch.simulate({
      type: 'transcript.export.request',
      requestId: 'te-1',
      selector: { kind: 'active' },
    } as FollowerToLeaderMessage);
    await vi.waitFor(() => expect(ch.types()).toContain('transcript.export.denied'));
    expect(ch.types()).not.toContain('transcript.export.start');

    const bare = makeLeader({
      createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([new Uint8Array([1])])),
    });
    const ch2 = addFollower(bare.manager, 'tab');
    ch2.simulate({
      type: 'transcript.export.request',
      requestId: 'te-2',
      selector: { kind: 'active' },
    } as FollowerToLeaderMessage);
    await vi.waitFor(() => expect(ch2.types()).toContain('transcript.export.denied'));
  });
});

// ---------------------------------------------------------------------------
// End-to-end — phone approves for a headless leader
// ---------------------------------------------------------------------------

describe('Cloud end-to-end: headless leader + approving follower', () => {
  it('routes the export gate over the tray and delivers the ZIP', async () => {
    const leaderCh = new FakeChannel();
    const followerCh = new FakeChannel();
    leaderCh.send = (data: string) => {
      leaderCh.sent.push(data);
      queueMicrotask(() => followerCh.simulate(JSON.parse(data) as LeaderToFollowerMessage));
    };
    followerCh.send = (data: string) => {
      followerCh.sent.push(data);
      queueMicrotask(() => leaderCh.simulate(JSON.parse(data) as FollowerToLeaderMessage));
    };

    const payload = new Uint8Array([9, 8, 7, 6, 5]);
    let leader: LeaderSyncManager | null = null;
    leader = new LeaderSyncManager({
      sendControl: () => {},
      getMessages: () => [],
      getScoopJid: () => 'cone',
      onFollowerMessage: vi.fn(),
      onFollowerAbort: vi.fn(),
      headlessLeader: true,
      // What the page's kernel round trip does: policy says "prompt", the
      // prompt comes back to the tray as a delegation.
      requestSudoApproval: (req) =>
        (leader as LeaderSyncManager).delegateSudoApproval({
          kind: req.kind,
          detail: req.detail,
          ...(req.suggestedPattern ? { suggestedPattern: req.suggestedPattern } : {}),
        }),
      createTranscriptExport: vi.fn().mockResolvedValue(makeZipResult([payload])),
    });
    leader.addFollower('boot-1', leaderCh, { runtime: 'slicc-browser' });

    const follower = new FollowerSyncManager(followerCh, {
      onSudoApprovalRequest: (req) => {
        expect(req.kind).toBe('export');
        return { decision: 'allow', attestation: 'none' };
      },
    });
    // The follower's own hello advertises `sudoApproval` because a handler is wired.
    await flush();
    expect(
      followerCh.find<{ capabilities?: { sudoApproval?: boolean } }>('hello')?.capabilities
        ?.sudoApproval
    ).toBe(true);

    const blob = await follower.requestTranscriptExport(
      { kind: 'active' },
      new AbortController().signal
    );
    expect(blob.type).toBe('application/zip');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(payload);
  });
});
