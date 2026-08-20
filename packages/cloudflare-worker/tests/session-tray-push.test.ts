/**
 * Follower push relay (issue #2062): the leader forwards `push.register`
 * over its controller socket, the DO stores tokens, and `push.send` fans a
 * metadata-only APNs push out to every device — forgetting dead tokens.
 */
import { describe, expect, it } from 'vitest';
import type { ApnsPushRequest, ApnsPushResult, ApnsSender } from '../src/apns.js';
import { buildApnsPayload } from '../src/apns.js';
import { SessionTrayDurableObject } from '../src/session-tray.js';
import { createCapabilityToken, type TrayRecord } from '../src/shared.js';
import type { FakeWebSocket } from './fake-do-state.js';
import { createFakeWebSocketPair, FakeDurableObjectState } from './fake-do-state.js';

const HOST = 'https://www.sliccy.ai';
const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

class FakeApns implements ApnsSender {
  readonly sent: ApnsPushRequest[] = [];
  constructor(
    private readonly respond: (req: ApnsPushRequest) => Partial<ApnsPushResult> = () => ({})
  ) {}
  async send(request: ApnsPushRequest): Promise<ApnsPushResult> {
    this.sent.push(request);
    return { token: request.token, status: 200, dropToken: false, ...this.respond(request) };
  }
}

interface TestTray {
  durable: SessionTrayDurableObject;
  state: FakeDurableObjectState;
  controllerUrl: string;
  trayId: string;
}

async function createTestTray(apns: ApnsSender | null): Promise<TestTray> {
  const state = new FakeDurableObjectState();
  const clock = { now: Date.now() };
  const durable = new SessionTrayDurableObject(
    state,
    {},
    {
      now: () => clock.now,
      webSocketPairFactory: () => createFakeWebSocketPair(state),
      apnsSender: apns,
    }
  );
  state.instance = durable;
  const trayId = crypto.randomUUID();
  const controllerToken = createCapabilityToken(trayId);
  await durable.fetch(
    new Request(`${HOST}/internal/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trayId,
        createdAt: new Date(clock.now).toISOString(),
        joinToken: createCapabilityToken(trayId),
        controllerToken,
        webhookToken: createCapabilityToken(trayId),
      }),
    })
  );
  return { durable, state, trayId, controllerUrl: `${HOST}/controller/${controllerToken}` };
}

async function attachLeader(t: TestTray): Promise<FakeWebSocket> {
  const attachRes = await t.durable.fetch(
    new Request(t.controllerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerId: 'leader-1' }),
    })
  );
  const leader = (await attachRes.json()) as { websocket: { url: string } };
  const wsRes = await t.durable.fetch(
    new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } })
  );
  return (wsRes as unknown as { webSocket: FakeWebSocket }).webSocket;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function readTray(t: TestTray): Promise<TrayRecord> {
  return (await t.state.storage.get<TrayRecord>('tray'))!;
}

function register(socket: FakeWebSocket, token: string, environment = 'sandbox'): void {
  socket.send(
    JSON.stringify({
      type: 'push.register',
      bootstrapId: 'boot-1',
      platform: 'ios',
      token,
      environment,
    })
  );
}

describe('push.register', () => {
  it('stores a well-formed token on the tray record and refreshes on re-register', async () => {
    const t = await createTestTray(new FakeApns());
    const socket = await attachLeader(t);
    register(socket, TOKEN_A, 'production');
    await tick();
    let tray = await readTray(t);
    expect(tray.pushTokens?.[TOKEN_A]).toMatchObject({
      platform: 'ios',
      environment: 'production',
      bootstrapId: 'boot-1',
    });
    register(socket, TOKEN_A, 'sandbox');
    await tick();
    tray = await readTray(t);
    expect(Object.keys(tray.pushTokens ?? {})).toEqual([TOKEN_A]);
    expect(tray.pushTokens?.[TOKEN_A].environment).toBe('sandbox');
  });

  it('rejects malformed tokens and non-iOS platforms at the trust boundary', async () => {
    const t = await createTestTray(new FakeApns());
    const socket = await attachLeader(t);
    register(socket, 'zz not hex');
    socket.send(
      JSON.stringify({
        type: 'push.register',
        bootstrapId: 'b',
        platform: 'android',
        token: TOKEN_A,
        environment: 'sandbox',
      })
    );
    await tick();
    expect((await readTray(t)).pushTokens ?? {}).toEqual({});
  });

  it('caps registrations per tray, evicting the oldest', async () => {
    const t = await createTestTray(new FakeApns());
    const socket = await attachLeader(t);
    for (let i = 0; i < 18; i++) {
      register(socket, i.toString(16).padStart(64, '0'));
      await tick();
    }
    const tokens = Object.keys((await readTray(t)).pushTokens ?? {});
    expect(tokens).toHaveLength(16);
    expect(tokens).not.toContain('0'.repeat(64));
  });
});

describe('push.send', () => {
  it('fans out a metadata-only push to every registered device', async () => {
    const apns = new FakeApns();
    const t = await createTestTray(apns);
    const socket = await attachLeader(t);
    register(socket, TOKEN_A, 'sandbox');
    register(socket, TOKEN_B, 'production');
    await tick();
    socket.send(
      JSON.stringify({
        type: 'push.send',
        category: 'sudo_request',
        label: 'Researcher',
        requestId: 'sudo-1',
      })
    );
    await tick();
    expect(apns.sent.map((r) => [r.token, r.environment]).sort()).toEqual([
      [TOKEN_A, 'sandbox'],
      [TOKEN_B, 'production'],
    ]);
    expect(apns.sent[0]).toMatchObject({
      category: 'sudo_request',
      label: 'Researcher',
      requestId: 'sudo-1',
      trayId: t.trayId,
    });
  });

  it('is a no-op with no registered devices, with APNs unconfigured, and for unknown categories', async () => {
    const apns = new FakeApns();
    const t = await createTestTray(apns);
    const socket = await attachLeader(t);
    socket.send(JSON.stringify({ type: 'push.send', category: 'turn_end', label: 'SLICC' }));
    await tick();
    expect(apns.sent).toHaveLength(0);

    register(socket, TOKEN_A);
    await tick();
    socket.send(JSON.stringify({ type: 'push.send', category: 'marketing', label: 'SLICC' }));
    await tick();
    expect(apns.sent).toHaveLength(0);

    const off = await createTestTray(null);
    const offSocket = await attachLeader(off);
    register(offSocket, TOKEN_A);
    await tick();
    offSocket.send(JSON.stringify({ type: 'push.send', category: 'turn_end', label: 'SLICC' }));
    await tick();
    // No throw, socket still alive (an error frame would have been sent).
    expect(offSocket.sent.some((m) => m.includes('INVALID_JSON'))).toBe(false);
  });

  it('forgets tokens APNs reports dead and keeps the rest', async () => {
    const apns = new FakeApns((req) =>
      req.token === TOKEN_A
        ? { status: 410, reason: 'Unregistered', dropToken: true }
        : { status: 500, reason: 'InternalServerError' }
    );
    const t = await createTestTray(apns);
    const socket = await attachLeader(t);
    register(socket, TOKEN_A);
    register(socket, TOKEN_B);
    await tick();
    socket.send(JSON.stringify({ type: 'push.send', category: 'turn_end', label: 'SLICC' }));
    await tick();
    await tick();
    expect(Object.keys((await readTray(t)).pushTokens ?? {})).toEqual([TOKEN_B]);
  });
});

describe('buildApnsPayload', () => {
  it('marks sudo requests time-sensitive with the SUDO category and carries only metadata', () => {
    const payload = buildApnsPayload({
      token: TOKEN_A,
      environment: 'sandbox',
      category: 'sudo_request',
      label: 'Researcher',
      trayId: 'tray-1',
      requestId: 'sudo-9',
    }) as { aps: Record<string, unknown>; slicc: Record<string, unknown> };
    expect(payload.aps['interruption-level']).toBe('time-sensitive');
    expect(payload.aps.category).toBe('SLICC_SUDO_REQUEST');
    expect(payload.slicc).toEqual({
      category: 'sudo_request',
      trayId: 'tray-1',
      requestId: 'sudo-9',
    });
    expect(JSON.stringify(payload)).not.toContain('git ');
  });

  it('turn_end is an ordinary banner threaded by tray', () => {
    const payload = buildApnsPayload({
      token: TOKEN_A,
      environment: 'production',
      category: 'turn_end',
      label: 'SLICC',
      trayId: 'tray-1',
    }) as { aps: Record<string, unknown> };
    expect(payload.aps['interruption-level']).toBe('active');
    expect(payload.aps.category).toBe('SLICC_TURN_END');
    expect(payload.aps['thread-id']).toBe('tray-1');
  });
});
