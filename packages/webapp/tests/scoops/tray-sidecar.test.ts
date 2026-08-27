import type { LeaderToFollowerMessage } from '@slicc/shared-ts';
import { TRAY_SYNC_PROTOCOL_VERSION, uint8ToBase64 } from '@slicc/shared-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getFollowerTrayRuntimeStatus,
  setFollowerTrayRuntimeStatus,
} from '../../src/scoops/tray-follower-status.js';
import type { TrayDataChannelLike } from '../../src/scoops/tray-webrtc.js';

/**
 * The sidecar's WebRTC dial is mocked so these tests exercise the part that is
 * actually new — the `hello`/`ping` handshake and the three verbs' frame
 * handling. `tray-webrtc.test.ts` already covers signaling and reconnect.
 */
const hoisted = vi.hoisted(() => ({
  /** Every dial the registry made, with a hook to drive its channel. */
  dials: [] as Array<{
    joinUrl: string;
    runtime: string;
    statusSink: { get(): unknown; set(status: unknown): void };
    channel: FakeDataChannel;
    connect(): void;
    /** A transparent reconnect: a NEW channel for the same attachment. */
    reconnect(): FakeDataChannel;
    giveUp(reason: string): void;
    cancelled: boolean;
  }>,
  leaderJoinUrl: null as string | null,
}));

class FakeDataChannel implements TrayDataChannelLike {
  readyState = 'open';
  readonly sent: string[] = [];
  private readonly listeners: Array<(event: { data: string }) => void> = [];
  closed = false;

  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  addEventListener(type: string, listener: unknown): void {
    if (type === 'message') this.listeners.push(listener as (event: { data: string }) => void);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  /** Deliver a leader→follower frame to the sidecar. */
  deliver(message: LeaderToFollowerMessage): void {
    for (const listener of [...this.listeners]) listener({ data: JSON.stringify(message) });
  }

  /** Everything the sidecar sent, parsed. */
  get frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  framesOfType(type: string): Array<Record<string, unknown>> {
    return this.frames.filter((f) => f.type === type);
  }
}

vi.mock('../../src/scoops/tray-webrtc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/scoops/tray-webrtc.js')>();
  return {
    ...actual,
    startFollowerWithAutoReconnect: (
      managerOptions: {
        joinUrl: string;
        runtime: string;
        statusSink: { get(): unknown; set(status: unknown): void };
      },
      reconnectOptions: {
        onConnected(connection: { trayId: string; bootstrapId: string; channel: unknown }): void;
        onGaveUp?(lastError: string): void;
      }
    ) => {
      const channel = new FakeDataChannel();
      const dial = {
        joinUrl: managerOptions.joinUrl,
        runtime: managerOptions.runtime,
        statusSink: managerOptions.statusSink,
        channel,
        cancelled: false,
        connect() {
          // Mirror what the real FollowerTrayManager writes on success — the
          // attachment's `connected` view reads its own sink, not a flag.
          managerOptions.statusSink.set({
            state: 'connected',
            joinUrl: managerOptions.joinUrl,
            trayId: 'tray-remote',
            error: null,
            lastPingTime: null,
            reconnectAttempts: 0,
            attachAttempts: 1,
            lastAttachCode: 'LEADER_CONNECTED',
            connectingSince: null,
            lastError: null,
          });
          reconnectOptions.onConnected({
            trayId: 'tray-remote',
            bootstrapId: 'bootstrap-1',
            channel,
          });
        },
        reconnect() {
          // `startFollowerWithAutoReconnect` re-invokes `onConnected` with a
          // fresh channel; the old one is gone and so is anything sent on it.
          const next = new FakeDataChannel();
          dial.channel = next;
          reconnectOptions.onConnected({
            trayId: 'tray-remote',
            bootstrapId: 'bootstrap-2',
            channel: next,
          });
          return next;
        },
        giveUp(reason: string) {
          reconnectOptions.onGaveUp?.(reason);
        },
      };
      hoisted.dials.push(dial);
      return {
        cancel() {
          dial.cancelled = true;
        },
        get reconnecting() {
          return false;
        },
      };
    },
  };
});

vi.mock('../../src/scoops/tray-leader.js', () => ({
  getLeaderTrayRuntimeStatus: () => ({
    session: hoisted.leaderJoinUrl ? { joinUrl: hoisted.leaderJoinUrl } : null,
  }),
}));

const { SidecarRegistry, SIDECAR_RUNTIME_TAG, MAX_SIDECAR_ATTACHMENTS, isOwnTrayJoinUrl } =
  await import('../../src/scoops/tray-sidecar.js');

const REMOTE = 'https://tray.example.com/join/remote-token';

/** Attach, auto-connecting the dial the registry opens. */
async function attach(registry: InstanceType<typeof SidecarRegistry>, joinUrl = REMOTE) {
  const promise = registry.attach({ joinUrl });
  // The dial is registered synchronously inside attach(); connect on the next
  // microtask so `start()`'s promise is already awaiting.
  await Promise.resolve();
  hoisted.dials.at(-1)?.connect();
  return { info: await promise, dial: hoisted.dials.at(-1) as (typeof hoisted.dials)[number] };
}

describe('tray sidecar', () => {
  let registry: InstanceType<typeof SidecarRegistry>;

  beforeEach(() => {
    hoisted.dials = [];
    hoisted.leaderJoinUrl = null;
    registry = new SidecarRegistry();
  });

  afterEach(() => {
    registry.detachAll();
  });

  describe('join URL validation', () => {
    it.each([
      ['not-a-url', 'not a URL'],
      ['ftp://tray.example.com/join/x', 'must be http(s)'],
      ['https://tray.example.com/dashboard', 'not a tray join URL'],
    ])('rejects %s', async (joinUrl, marker) => {
      await expect(registry.attach({ joinUrl })).rejects.toThrow(marker);
      expect(hoisted.dials).toHaveLength(0);
    });

    // Self-attach is a live deadlock: the leader tray runs on this same page
    // thread, so the exec would wait on a reply the thread has to produce.
    it('refuses to attach to this instance’s own tray', async () => {
      hoisted.leaderJoinUrl = REMOTE;
      await expect(registry.attach({ joinUrl: REMOTE })).rejects.toThrow('own tray');
      expect(hoisted.dials).toHaveLength(0);
    });

    it('detects the own-tray case through decorating query params', () => {
      hoisted.leaderJoinUrl = `${REMOTE}?ts=1`;
      expect(isOwnTrayJoinUrl(new URL(`${REMOTE}?other=2`))).toBe(true);
      expect(isOwnTrayJoinUrl(new URL('https://tray.example.com/join/different'))).toBe(false);
    });
  });

  describe('attachment lifecycle', () => {
    it('sends hello with the sidecar runtime tag and no capabilities', async () => {
      const { dial } = await attach(registry);
      const [hello] = dial.channel.framesOfType('hello');
      expect(hello).toMatchObject({
        type: 'hello',
        protocolVersion: TRAY_SYNC_PROTOCOL_VERSION,
        runtime: SIDECAR_RUNTIME_TAG,
        capabilities: { exec: false },
      });
    });

    // The whole trust posture: a sidecar is a client, so it must never
    // advertise itself as something a remote leader can drive.
    it('never advertises exec capability', async () => {
      const { dial } = await attach(registry);
      const [hello] = dial.channel.framesOfType('hello');
      expect((hello.capabilities as { exec: boolean }).exec).toBe(false);
    });

    it('reuses an existing attachment for the same tray', async () => {
      const first = await attach(registry);
      const second = await registry.attach({ joinUrl: `${REMOTE}?extra=1` });
      expect(second.name).toBe(first.info.name);
      expect(hoisted.dials).toHaveLength(1);
    });

    // The agent loop runs one message's bash tool calls with `Promise.all`, so
    // two `slicc <same-url> …` commands in a turn arrive concurrently. Before
    // the fix, the second caller got a still-`connecting` handle back and its
    // verb failed `not connected`.
    it('concurrent attaches to the same tray share one dial and both wait for it', async () => {
      const first = registry.attach({ joinUrl: REMOTE });
      const second = registry.attach({ joinUrl: REMOTE });
      await Promise.resolve();
      expect(hoisted.dials).toHaveLength(1); // one dial, not two
      hoisted.dials[0].connect();

      const [a, b] = await Promise.all([first, second]);
      expect(b.name).toBe(a.name);
      // Both callers see a CONNECTED attachment...
      expect(b.state).toBe('connected');

      // ...so the verb that follows reaches the wire instead of throwing
      // `not connected`, which is the symptom this guards.
      const run = registry.exec(b.name, 'true');
      await Promise.resolve();
      const dial = hoisted.dials[0];
      const requestId = dial.channel.framesOfType('exec.request')[0].requestId as string;
      dial.channel.deliver({ type: 'exec.response', requestId, exitCode: 0 });
      await expect(run).resolves.toMatchObject({ exitCode: 0 });
    });

    it('propagates a failed dial to a caller that joined it mid-flight', async () => {
      const first = registry.attach({ joinUrl: REMOTE });
      const second = registry.attach({ joinUrl: REMOTE });
      await Promise.resolve();
      hoisted.dials[0].giveUp('TRAY_LEADER_NOT_ELECTED');
      await expect(first).rejects.toThrow('TRAY_LEADER_NOT_ELECTED');
      await expect(second).rejects.toThrow('TRAY_LEADER_NOT_ELECTED');
      expect(registry.list()).toEqual([]);
    });

    it('lists attachments with their live state', async () => {
      await attach(registry);
      expect(registry.list()).toEqual([
        expect.objectContaining({ state: 'connected', trayId: 'tray-remote', joinUrl: REMOTE }),
      ]);
    });

    it('honors a caller-chosen name', async () => {
      const promise = registry.attach({ joinUrl: REMOTE, name: 'lab' });
      await Promise.resolve();
      hoisted.dials.at(-1)?.connect();
      expect((await promise).name).toBe('lab');
    });

    it('caps concurrent attachments', async () => {
      for (let i = 0; i < MAX_SIDECAR_ATTACHMENTS; i++) {
        await attach(registry, `https://tray.example.com/join/token-${i}`);
      }
      await expect(
        registry.attach({ joinUrl: 'https://tray.example.com/join/one-too-many' })
      ).rejects.toThrow('too many sidecar attachments');
    });

    it('cancels the dial and closes the channel on detach', async () => {
      const { info, dial } = await attach(registry);
      expect(registry.detach(info.name)).toBe(true);
      expect(dial.cancelled).toBe(true);
      expect(dial.channel.closed).toBe(true);
      expect(registry.list()).toEqual([]);
    });

    it('reports detaching an unknown name as false', () => {
      expect(registry.detach('nope')).toBe(false);
    });

    it('drops a failed attachment rather than leaving a dead entry', async () => {
      const promise = registry.attach({ joinUrl: REMOTE });
      await Promise.resolve();
      hoisted.dials.at(-1)?.giveUp('TRAY_LEADER_NOT_ELECTED');
      await expect(promise).rejects.toThrow('TRAY_LEADER_NOT_ELECTED');
      expect(registry.list()).toEqual([]);
    });
  });

  describe('instance role isolation', () => {
    // The regression this guards: a sidecar writing the module-global follower
    // status would make `host` report `follower` on an instance that is still
    // leading, and detaching would stamp `inactive` over a real follower role.
    it('leaves the instance-wide follower status untouched', async () => {
      const before = getFollowerTrayRuntimeStatus();
      const { info } = await attach(registry);
      expect(getFollowerTrayRuntimeStatus()).toEqual(before);
      registry.detach(info.name);
      expect(getFollowerTrayRuntimeStatus()).toEqual(before);
    });

    it('does not clear a genuine follower role on detach', async () => {
      const followerStatus = {
        state: 'connected' as const,
        joinUrl: 'https://tray.example.com/join/my-real-role',
        trayId: 'tray-mine',
        error: null,
        lastPingTime: null,
        reconnectAttempts: 0,
        attachAttempts: 1,
        lastAttachCode: null,
        connectingSince: null,
        lastError: null,
      };
      setFollowerTrayRuntimeStatus(followerStatus);
      const { info } = await attach(registry);
      registry.detach(info.name);
      expect(getFollowerTrayRuntimeStatus()).toMatchObject({
        state: 'connected',
        trayId: 'tray-mine',
      });
      setFollowerTrayRuntimeStatus({ ...followerStatus, state: 'inactive', trayId: null });
    });
  });

  describe('keepalive and inbound requests', () => {
    it('answers the leader’s ping with a pong', async () => {
      const { dial } = await attach(registry);
      dial.channel.deliver({ type: 'ping' });
      expect(dial.channel.framesOfType('pong')).toHaveLength(1);
    });

    // A leader that ignores our `exec: false` must get a prompt refusal rather
    // than a request that never terminates.
    it('refuses an inbound exec.request instead of hanging it', async () => {
      const { dial } = await attach(registry);
      dial.channel.deliver({ type: 'exec.request', requestId: 'r1', command: 'rm -rf /' });
      const [response] = dial.channel.framesOfType('exec.response');
      expect(response).toMatchObject({ requestId: 'r1', exitCode: 127 });
      expect(String(response.error)).toContain('client-only');
    });
  });

  describe('prompt', () => {
    it('sends a user_message and streams content deltas', async () => {
      const { info, dial } = await attach(registry);
      const run = registry.prompt(info.name, 'what is up?');
      await Promise.resolve();

      const [sent] = dial.channel.framesOfType('user_message');
      expect(sent).toMatchObject({ text: 'what is up?' });
      expect(sent.messageId).toEqual(expect.any(String));

      dial.channel.deliver({
        type: 'agent_event',
        scoopJid: 'cone-1',
        event: { type: 'content_delta', messageId: 'm1', text: 'all ' },
      });
      dial.channel.deliver({
        type: 'agent_event',
        scoopJid: 'cone-1',
        event: { type: 'content_delta', messageId: 'm1', text: 'good' },
      });
      dial.channel.deliver({
        type: 'agent_event',
        scoopJid: 'cone-1',
        event: { type: 'turn_end', messageId: 'm1' },
      });

      expect(await run).toMatchObject({ stdout: 'all good', exitCode: 0 });
    });

    // A live browser leader emits no `turn_end` — the turn ends when
    // scoopStatus goes processing → ready. Without this the verb would hang.
    it('ends the turn on a processing → ready status transition', async () => {
      const { info, dial } = await attach(registry);
      const run = registry.prompt(info.name, 'hi');
      await Promise.resolve();

      dial.channel.deliver({ type: 'status', scoopStatus: 'processing', scoopJid: 'cone-1' });
      dial.channel.deliver({
        type: 'agent_event',
        scoopJid: 'cone-1',
        event: { type: 'content_delta', messageId: 'm1', text: 'hello' },
      });
      dial.channel.deliver({ type: 'status', scoopStatus: 'ready', scoopJid: 'cone-1' });

      expect(await run).toMatchObject({ stdout: 'hello', exitCode: 0 });
    });

    // A `ready` before any `processing` is just the leader's opening state.
    it('ignores a ready status that never followed processing', async () => {
      const { info, dial } = await attach(registry);
      let settled = false;
      const run = registry.prompt(info.name, 'hi').then((r) => {
        settled = true;
        return r;
      });
      await Promise.resolve();

      dial.channel.deliver({ type: 'status', scoopStatus: 'ready', scoopJid: 'cone-1' });
      await Promise.resolve();
      expect(settled).toBe(false);

      dial.channel.deliver({
        type: 'agent_event',
        scoopJid: 'cone-1',
        event: { type: 'turn_end', messageId: 'm1' },
      });
      await run;
      expect(settled).toBe(true);
    });

    it('reports an agent error on stderr with a non-zero exit', async () => {
      const { info, dial } = await attach(registry);
      const run = registry.prompt(info.name, 'hi');
      await Promise.resolve();
      dial.channel.deliver({
        type: 'agent_event',
        scoopJid: 'cone-1',
        event: { type: 'error', error: 'rate limited' },
      });
      expect(await run).toMatchObject({ stderr: 'rate limited\n', exitCode: 1 });
    });

    it('passes --steer through to the wire', async () => {
      const { info, dial } = await attach(registry);
      void registry.prompt(info.name, 'stop', { steer: true });
      await Promise.resolve();
      expect(dial.channel.framesOfType('user_message')[0].steer).toBe(true);
    });

    // An interrupted prompt must stop the remote turn — otherwise the leader
    // keeps spending tokens on output nobody reads.
    it('aborts the remote turn when the caller interrupts, keeping partial output', async () => {
      const { info, dial } = await attach(registry);
      const controller = new AbortController();
      const run = registry.prompt(info.name, 'hi', { signal: controller.signal });
      await Promise.resolve();
      dial.channel.deliver({
        type: 'agent_event',
        scoopJid: 'cone-1',
        event: { type: 'content_delta', messageId: 'm1', text: 'partial' },
      });
      controller.abort();

      const result = await run;
      expect(result).toMatchObject({ stdout: 'partial', exitCode: 130 });
      expect(dial.channel.framesOfType('abort')).toHaveLength(1);
    });

    it('fails the run when the transport drops mid-turn', async () => {
      const { info, dial } = await attach(registry);
      const run = registry.prompt(info.name, 'hi');
      await Promise.resolve();
      registry.detach(info.name);
      expect(await run).toMatchObject({
        exitCode: 1,
        error: expect.stringContaining('connection lost'),
      });
      expect(dial.channel.closed).toBe(true);
    });
  });

  describe('exec', () => {
    const b64 = (text: string) => uint8ToBase64(new TextEncoder().encode(text));

    it('sends exec.request and assembles the streamed chunks', async () => {
      const { info, dial } = await attach(registry);
      const run = registry.exec(info.name, 'uname -a', { cwd: '/workspace' });
      await Promise.resolve();

      const [request] = dial.channel.framesOfType('exec.request');
      expect(request).toMatchObject({ command: 'uname -a', cwd: '/workspace' });
      const requestId = request.requestId as string;

      dial.channel.deliver({
        type: 'exec.chunk',
        requestId,
        stream: 'stdout',
        data: b64('Darwin '),
      });
      dial.channel.deliver({ type: 'exec.chunk', requestId, stream: 'stderr', data: b64('warn') });
      dial.channel.deliver({ type: 'exec.chunk', requestId, stream: 'stdout', data: b64('arm64') });
      dial.channel.deliver({ type: 'exec.response', requestId, exitCode: 0 });

      expect(await run).toMatchObject({ stdout: 'Darwin arm64', stderr: 'warn', exitCode: 0 });
    });

    // Chunk boundaries land anywhere, including mid-character.
    it('reassembles a multi-byte character split across chunks', async () => {
      const { info, dial } = await attach(registry);
      const run = registry.exec(info.name, 'echo');
      await Promise.resolve();
      const requestId = dial.channel.framesOfType('exec.request')[0].requestId as string;

      const bytes = new TextEncoder().encode('é');
      dial.channel.deliver({
        type: 'exec.chunk',
        requestId,
        stream: 'stdout',
        data: uint8ToBase64(bytes.slice(0, 1)),
      });
      dial.channel.deliver({
        type: 'exec.chunk',
        requestId,
        stream: 'stdout',
        data: uint8ToBase64(bytes.slice(1)),
      });
      dial.channel.deliver({ type: 'exec.response', requestId, exitCode: 0 });

      expect((await run).stdout).toBe('é');
    });

    it('ignores frames for a different request id', async () => {
      const { info, dial } = await attach(registry);
      const run = registry.exec(info.name, 'echo hi');
      await Promise.resolve();
      const requestId = dial.channel.framesOfType('exec.request')[0].requestId as string;

      dial.channel.deliver({
        type: 'exec.chunk',
        requestId: 'someone-else',
        stream: 'stdout',
        data: b64('NOPE'),
      });
      dial.channel.deliver({ type: 'exec.chunk', requestId, stream: 'stdout', data: b64('hi') });
      dial.channel.deliver({ type: 'exec.response', requestId, exitCode: 0 });

      expect((await run).stdout).toBe('hi');
    });

    it('surfaces the remote exit code and error', async () => {
      const { info, dial } = await attach(registry);
      const run = registry.exec(info.name, 'nope');
      await Promise.resolve();
      const requestId = dial.channel.framesOfType('exec.request')[0].requestId as string;
      dial.channel.deliver({
        type: 'exec.response',
        requestId,
        exitCode: 127,
        error: 'command not found',
      });
      expect(await run).toMatchObject({ exitCode: 127, error: 'command not found' });
    });

    it('forwards base64 stdin', async () => {
      const { info, dial } = await attach(registry);
      void registry.exec(info.name, 'cat', { stdin: b64('piped') });
      await Promise.resolve();
      expect(dial.channel.framesOfType('exec.request')[0].stdin).toBe(b64('piped'));
    });

    it('sends SIGINT to the remote when the caller interrupts', async () => {
      const { info, dial } = await attach(registry);
      const controller = new AbortController();
      const run = registry.exec(info.name, 'sleep 100', { signal: controller.signal });
      await Promise.resolve();
      const requestId = dial.channel.framesOfType('exec.request')[0].requestId as string;
      controller.abort();

      expect(await run).toMatchObject({ exitCode: 130 });
      expect(dial.channel.framesOfType('exec.signal')[0]).toMatchObject({
        requestId,
        signal: 'SIGINT',
      });
    });

    it('reports a timeout as exit 124 and stops the remote command', async () => {
      vi.useFakeTimers();
      try {
        const { info, dial } = await attach(registry);
        const run = registry.exec(info.name, 'sleep 100', { timeoutMs: 1000 });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1001);
        expect(await run).toMatchObject({ exitCode: 124 });
        expect(dial.channel.framesOfType('exec.signal')).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('watch', () => {
    it('sends nothing to the leader', async () => {
      vi.useFakeTimers();
      try {
        const { info, dial } = await attach(registry);
        const before = dial.channel.sent.length;
        const run = registry.watch(info.name, { durationMs: 5000 });
        await vi.advanceTimersByTimeAsync(5001);
        await run;
        expect(dial.channel.sent.length).toBe(before);
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns what it tailed when the window closes, with exit 0', async () => {
      vi.useFakeTimers();
      try {
        const { info, dial } = await attach(registry);
        const run = registry.watch(info.name, { durationMs: 5000 });
        await Promise.resolve();
        dial.channel.deliver({
          type: 'agent_event',
          scoopJid: 'cone-1',
          event: { type: 'content_delta', messageId: 'm1', text: 'working' },
        });
        await vi.advanceTimersByTimeAsync(5001);
        expect(await run).toMatchObject({ stdout: 'working', exitCode: 0 });
      } finally {
        vi.useRealTimers();
      }
    });

    it('filters by scoop jid when one is given', async () => {
      vi.useFakeTimers();
      try {
        const { info, dial } = await attach(registry);
        const run = registry.watch(info.name, { durationMs: 5000, scoopJid: 'scoop-a' });
        await Promise.resolve();
        dial.channel.deliver({
          type: 'agent_event',
          scoopJid: 'scoop-b',
          event: { type: 'content_delta', messageId: 'm1', text: 'OTHER' },
        });
        dial.channel.deliver({
          type: 'agent_event',
          scoopJid: 'scoop-a',
          event: { type: 'content_delta', messageId: 'm2', text: 'MINE' },
        });
        await vi.advanceTimersByTimeAsync(5001);
        const result = await run;
        expect(result.stdout).toContain('MINE');
        expect(result.stdout).not.toContain('OTHER');
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops early on processing → ready with --until-idle', async () => {
      const { info, dial } = await attach(registry);
      const run = registry.watch(info.name, { durationMs: 600_000, untilIdle: true });
      await Promise.resolve();
      dial.channel.deliver({ type: 'status', scoopStatus: 'processing', scoopJid: 'cone-1' });
      dial.channel.deliver({ type: 'status', scoopStatus: 'ready', scoopJid: 'cone-1' });
      // Resolves without the 10-minute window elapsing.
      expect(await run).toMatchObject({ exitCode: 0 });
    });

    it('renders tool calls and echoed user messages', async () => {
      vi.useFakeTimers();
      try {
        const { info, dial } = await attach(registry);
        const run = registry.watch(info.name, { durationMs: 1000 });
        await Promise.resolve();
        dial.channel.deliver({
          type: 'user_message_echo',
          text: 'run the tests',
          messageId: 'u1',
          scoopJid: 'cone-1',
        } as LeaderToFollowerMessage);
        dial.channel.deliver({
          type: 'agent_event',
          scoopJid: 'cone-1',
          event: {
            type: 'tool_use_start',
            messageId: 'm1',
            toolName: 'bash',
            toolInput: { command: 'npm test' },
          },
        });
        await vi.advanceTimersByTimeAsync(1001);
        const { stdout } = await run;
        expect(stdout).toContain('> run the tests');
        expect(stdout).toContain('[tool] bash');
        expect(stdout).toContain('npm test');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('reconnect', () => {
    // The request died with the old data channel — the leader dropped it and
    // no reply is coming. Without this the verb waits out its timeout, which
    // for `slicc exec` with no `--timeout` is 24 HOURS.
    it('fails an in-flight verb instead of hanging it forever', async () => {
      const { info, dial } = await attach(registry);
      const run = registry.exec(info.name, 'sleep 100');
      await Promise.resolve();
      expect(dial.channel.framesOfType('exec.request')).toHaveLength(1);

      dial.reconnect();

      const result = await run;
      expect(result.exitCode).toBe(1);
      expect(result.error).toMatch(/connection/i);
    });

    // It must not silently re-issue: a re-sent `user_message` costs a second
    // turn and a re-sent `exec.request` runs the command twice.
    it('does not re-issue the request on the new channel', async () => {
      const { info, dial } = await attach(registry);
      const run = registry.exec(info.name, 'rm -rf /important');
      await Promise.resolve();
      const next = dial.reconnect();
      await run;
      expect(next.framesOfType('exec.request')).toHaveLength(0);
    });

    it('re-sends hello on the new channel and stays usable', async () => {
      const { info, dial } = await attach(registry);
      const next = dial.reconnect();
      expect(next.framesOfType('hello')).toHaveLength(1);

      // The attachment survives the drop — a NEW verb works on the new channel.
      const run = registry.exec(info.name, 'echo ok');
      await Promise.resolve();
      const requestId = next.framesOfType('exec.request')[0].requestId as string;
      next.deliver({ type: 'exec.response', requestId, exitCode: 0 });
      expect(await run).toMatchObject({ exitCode: 0 });
    });
  });

  describe('verb preconditions', () => {
    it('rejects a verb against an unknown attachment', async () => {
      await expect(registry.prompt('nope', 'hi')).rejects.toThrow('no such attachment: nope');
    });

    it('rejects a verb against a detached attachment', async () => {
      const { info } = await attach(registry);
      registry.detach(info.name);
      await expect(registry.exec(info.name, 'ls')).rejects.toThrow('no such attachment');
    });
  });
});
