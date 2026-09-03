/**
 * The `node-rest` adapter against the shared REST contract fixture
 * (#2276 slice B).
 *
 * `packages/shared-ts/fixtures/capability-rest-contract.json` is replayed
 * three ways: here (the requests the adapter EMITS), in
 * `packages/node-server/tests/routes/capability-rest-contract.test.ts` and in
 * `packages/swift-server/Tests/CapabilityRestContractTests.swift` (the
 * responses each server GIVES). A route that drifts on any of the three
 * fails here or there, not in a float at runtime.
 */

import { describe, expect, it } from 'vitest';
import {
  createRestCapabilityBroker,
  isCapabilityFailure,
  REST_CAPABILITY_PATHS,
} from '../../src/work-unit/capability/index.js';
import {
  loadRestContract,
  type RecordedRequest,
  scriptedRestFetch,
} from './capability-transport-fixtures.js';

const contract = loadRestContract();

function harness(): {
  log: RecordedRequest[];
  broker: ReturnType<typeof createRestCapabilityBroker>;
} {
  const log: RecordedRequest[] = [];
  return {
    log,
    broker: createRestCapabilityBroker({
      fetchImpl: scriptedRestFetch(log),
      resolveUrl: (path) => path,
      headers: (extra) => ({ ...extra, 'X-Bridge-Token': 'test-token' }),
    }),
  };
}

/** `path` with the contract's `{name}` placeholder collapsed to a segment match. */
function pathMatches(contractPath: string, actual: string): boolean {
  if (!contractPath.includes('{')) return contractPath === actual;
  const prefix = contractPath.slice(0, contractPath.indexOf('{'));
  return actual.startsWith(prefix) && actual.length > prefix.length;
}

describe('REST contract fixture', () => {
  it('names a route for every path the adapter knows, and no others', () => {
    const fromContract = new Set(
      contract.operations.map((op) => op.path.replace(/\/\{name\}$/, ''))
    );
    expect([...fromContract].sort()).toEqual(
      [...new Set(Object.values(REST_CAPABILITY_PATHS))].sort()
    );
  });

  it('covers every operation the adapter allowlists', () => {
    const { broker } = harness();
    const allowlisted = [
      ...broker.network.allowlist
        .filter((op) => op !== 'localNodeServer')
        .map((op) => `network.${op}`),
      ...broker.secrets.allowlist.map((op) => `secrets.${op}`),
      ...broker.mounts.allowlist.map((op) => `mounts.${op}`),
      ...broker.approvals.allowlist.map((op) => `approvals.${op}`),
    ];
    const covered = new Set(contract.operations.map((op) => op.operation.split('/')[0]));
    for (const op of allowlisted) expect([...covered]).toContain(op);
  });
});

describe('node-rest adapter emits the contract wire', () => {
  it('localNodeServer is a composition-time fact — it never touches the network', async () => {
    const { log, broker } = harness();
    expect(await broker.network.localNodeServer()).toEqual({
      ok: true,
      value: { available: true },
    });
    expect(log).toHaveLength(0);
  });

  it('crossOriginFetch posts the target URL as a header, never in the path', async () => {
    const { log, broker } = harness();
    const result = await broker.network.crossOriginFetch({
      url: 'https://example.test/hello',
      method: 'POST',
      headers: { 'X-Custom': '1' },
      body: 'payload',
    });
    expect(log[0].path).toBe(REST_CAPABILITY_PATHS.fetchProxy);
    expect(log[0].method).toBe('POST');
    expect(log[0].headers['X-Target-URL']).toBe('https://example.test/hello');
    expect(log[0].headers['X-Bridge-Token']).toBe('test-token');
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        status: 200,
        ok: true,
        body: 'upstream-body',
        bodyEncoding: 'text',
        url: 'https://example.test/hello',
      }),
    });
  });

  it('base64-decodes a binary request body and base64-encodes a binary response', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250]);
    const base64 = Buffer.from(bytes).toString('base64');
    const captured: BodyInit[] = [];
    const broker = createRestCapabilityBroker({
      resolveUrl: (path) => path,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        if (init?.body) captured.push(init.body);
        return new Response(bytes, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }) as typeof fetch,
    });
    const result = await broker.network.crossOriginFetch({
      url: 'https://example.test/bin',
      method: 'PUT',
      body: base64,
      bodyEncoding: 'base64',
    });
    expect(new Uint8Array(captured[0] as Uint8Array)).toEqual(bytes);
    expect(result.ok && result.value.bodyEncoding).toBe('base64');
    expect(result.ok && result.value.body).toBe(base64);
  });

  it('reads secrets from the masked route only — a real value can never be requested', async () => {
    const { log, broker } = harness();
    const listed = await broker.secrets.listMaskedEnv();
    const got = await broker.secrets.get({ name: 'GITHUB_TOKEN' });
    expect(log.every((r) => r.path === REST_CAPABILITY_PATHS.secretsMasked)).toBe(true);
    expect(listed.ok && listed.value.entries.length).toBe(2);
    expect(got).toEqual({
      ok: true,
      value: { name: 'GITHUB_TOKEN', maskedValue: 'ghp_25243876bf81' },
    });
  });

  it('routes a session set away from the persisted store', async () => {
    const { log, broker } = harness();
    await broker.secrets.set({ name: 'A', value: 'x', domains: ['a.test'], scope: 'session' });
    await broker.secrets.set({ name: 'B', value: 'y' });
    expect(log.map((r) => r.path)).toEqual([
      REST_CAPABILITY_PATHS.secretsSession,
      REST_CAPABILITY_PATHS.secretsPersisted,
    ]);
    // A secret with no declared domains is scoped to nothing, not to everything.
    expect(log[1].body).toEqual({ name: 'B', value: 'y', domains: [] });
  });

  it('treats a 404 delete as the requested end state, and a 500 as a failure', async () => {
    const status = { code: 404 };
    const broker = createRestCapabilityBroker({
      resolveUrl: (path) => path,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: 'nope' }), { status: status.code })) as typeof fetch,
    });
    expect(await broker.secrets.delete({ name: 'GONE' })).toEqual({ ok: true, value: undefined });
    status.code = 500;
    const failed = await broker.secrets.delete({ name: 'BOOM' });
    expect(isCapabilityFailure(failed)).toBe(true);
    if (isCapabilityFailure(failed)) expect(failed.status).toBe(500);
  });

  it('picks the S3 or DA route from the envelope backend', async () => {
    const { log, broker } = harness();
    await broker.mounts.signRequest({
      backend: 's3',
      envelope: { profile: 'p', method: 'GET', bucket: 'b', key: 'k' },
    });
    await broker.mounts.signRequest({
      backend: 'da',
      envelope: { imsToken: 't', method: 'GET', path: '/source/x' },
    });
    expect(log.map((r) => r.path)).toEqual([
      REST_CAPABILITY_PATHS.s3SignAndForward,
      REST_CAPABILITY_PATHS.daSignAndForward,
    ]);
  });

  it('surfaces an upstream sign-and-forward refusal as a value, not as unavailable', async () => {
    const broker = createRestCapabilityBroker({
      resolveUrl: (path) => path,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: false, error: 'bad', errorCode: 'invalid_profile' }), {
          status: 400,
        })) as typeof fetch,
    });
    const result = await broker.mounts.signRequest({
      backend: 's3',
      envelope: { profile: '', method: 'GET', bucket: 'b', key: 'k' },
    });
    expect(result).toEqual({
      ok: true,
      value: { ok: false, error: 'bad', errorCode: 'invalid_profile' },
    });
  });

  it('falls back to the detail as the always-pattern and fails an approval closed', async () => {
    const { log, broker } = harness();
    await broker.approvals.request({ kind: 'command', detail: 'rm -rf /' });
    expect(log[0].path).toBe(REST_CAPABILITY_PATHS.sudoApprove);
    expect(log[0].body).toEqual({
      kind: 'command',
      detail: 'rm -rf /',
      suggestedPattern: 'rm -rf /',
    });

    for (const body of ['{"decision":"maybe"}', 'null', '"allow"']) {
      const closed = createRestCapabilityBroker({
        resolveUrl: (path) => path,
        fetchImpl: (async () => new Response(body, { status: 200 })) as typeof fetch,
      });
      const decision = await closed.approvals.request({ kind: 'command', detail: 'ls' });
      expect(decision).toEqual({ ok: true, value: { decision: 'deny' } });
    }
  });

  it('resolves an always decision with the server pattern, or the suggestion when it omits one', async () => {
    const make = (body: unknown) =>
      createRestCapabilityBroker({
        resolveUrl: (path) => path,
        fetchImpl: (async () =>
          new Response(JSON.stringify(body), { status: 200 })) as typeof fetch,
      });
    expect(
      await make({ decision: 'always', pattern: 'git *' }).approvals.request({
        kind: 'command',
        detail: 'git status',
        suggestedPattern: 'git status',
      })
    ).toEqual({ ok: true, value: { decision: 'always', pattern: 'git *' } });
    expect(
      await make({ decision: 'always' }).approvals.request({
        kind: 'command',
        detail: 'git status',
        suggestedPattern: 'git *',
      })
    ).toEqual({ ok: true, value: { decision: 'always', pattern: 'git *' } });
  });

  it('carries an authenticated requester through, and omits it when there is none', async () => {
    const { log, broker } = harness();
    await broker.approvals.request({ kind: 'guest-message', detail: 'hi', requester: 'seat-7' });
    await broker.approvals.request({ kind: 'guest-message', detail: 'hi' });
    expect(log[0].body).toHaveProperty('requester', 'seat-7');
    expect(log[1].body).not.toHaveProperty('requester');
  });

  it('every contract path the adapter can reach is answered by the scripted server', async () => {
    const { log, broker } = harness();
    await broker.network.crossOriginFetch({ url: 'https://example.test/' });
    await broker.secrets.listMaskedEnv();
    await broker.secrets.set({ name: 'A', value: 'x' });
    await broker.secrets.set({ name: 'A', value: 'x', scope: 'session' });
    await broker.secrets.delete({ name: 'A' });
    await broker.mounts.signRequest({
      backend: 's3',
      envelope: { profile: 'p', method: 'GET', bucket: 'b', key: 'k' },
    });
    await broker.mounts.signRequest({
      backend: 'da',
      envelope: { imsToken: 't', method: 'GET', path: '/x' },
    });
    await broker.approvals.request({ kind: 'command', detail: 'ls' });
    for (const recorded of log) {
      const matched = contract.operations.some(
        (op) =>
          (op.method === '*' || op.method === recorded.method) &&
          pathMatches(op.path, recorded.path)
      );
      expect({ path: recorded.path, method: recorded.method, matched }).toEqual({
        path: recorded.path,
        method: recorded.method,
        matched: true,
      });
    }
  });
});
