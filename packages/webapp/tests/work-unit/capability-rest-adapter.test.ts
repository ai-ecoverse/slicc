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

import { afterEach, describe, expect, it } from 'vitest';
import { setBridgeToken, setLocalApiBaseUrl } from '../../src/shell/proxied-fetch.js';
import {
  createRestCapabilityBroker,
  isCapabilityFailure,
  isCapabilityUnavailable,
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
    const got = await broker.secrets.getMasked({ name: 'GITHUB_TOKEN' });
    expect(log.every((r) => r.path === REST_CAPABILITY_PATHS.secretsMasked)).toBe(true);
    expect(listed.ok && listed.value.entries.length).toBe(2);
    // The scope comes back with the entry: `secret` prints it, and a caller
    // that had to re-fetch the list for it would double the round trips.
    expect(got).toEqual({
      ok: true,
      value: {
        name: 'GITHUB_TOKEN',
        maskedValue: 'ghp_25243876bf81',
        domains: ['api.github.com'],
      },
    });
  });

  it('defaults a set to the session store — persisting takes an explicit scope', async () => {
    const { log, broker } = harness();
    await broker.secrets.set({ name: 'A', value: 'x', domains: ['a.test'] });
    await broker.secrets.set({ name: 'B', value: 'y', scope: 'persisted' });
    // A durable write is never something a caller gets by omitting a field —
    // `secret set` likewise needs `--persist`.
    expect(log.map((r) => r.path)).toEqual([
      REST_CAPABILITY_PATHS.secretsSession,
      REST_CAPABILITY_PATHS.secretsPersisted,
    ]);
    // A secret with no declared domains is scoped to nothing, not to everything.
    expect(log[1].body).toEqual({ name: 'B', value: 'y', domains: [] });
  });

  it('reports the Swift persisted-write gap as unavailable, not as a retryable failure', async () => {
    const notFound = createRestCapabilityBroker({
      resolveUrl: (path) => path,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: 'not found' }), { status: 404 })) as typeof fetch,
    });
    // swift-server has no `POST /api/secrets` (#2806). A caller that retried
    // that 404 would retry forever, so it is a permanent shape fact.
    const persisted = await notFound.secrets.set({ name: 'A', value: 'x', scope: 'persisted' });
    expect(isCapabilityUnavailable(persisted)).toBe(true);
    if (isCapabilityUnavailable(persisted)) {
      expect(persisted.message).toContain('#2806');
      expect(persisted.message).toContain('session');
    }
    // The session route exists on both servers, so its 404 stays a failure —
    // which is also why `set` keeps its allowlist entry.
    const session = await notFound.secrets.set({ name: 'A', value: 'x' });
    expect(isCapabilityFailure(session)).toBe(true);
  });

  it('surfaces a delete 404 rather than swallowing it, and reports provenance', async () => {
    const { log, broker } = harness();
    // Whether "already gone" counts as success is the CALLER's policy, so the
    // broker reports what the server said instead of deciding for it.
    const missing = createRestCapabilityBroker({
      resolveUrl: (path) => path,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: 'no secret named "GONE"' }), {
          status: 404,
        })) as typeof fetch,
    });
    const gone = await missing.secrets.delete({ name: 'GONE' });
    expect(isCapabilityFailure(gone)).toBe(true);
    if (isCapabilityFailure(gone)) expect(gone.status).toBe(404);

    const removed = await broker.secrets.delete({ name: 'A' });
    expect(log[0].method).toBe('DELETE');
    expect(removed).toEqual({ ok: true, value: { removed: true, fromSession: false } });
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

  it('has its own, much larger, budget than the 10s control-plane deadline (#2276 round-1 review finding 1)', async () => {
    // S3 caps a single object at 25 MiB, so `mounts.signRequest` must not
    // die on the same 10s control-plane clock `secrets.listMaskedEnv` etc.
    // use. Proven with a SHORT shared `controlTimeoutMs` rather than a real
    // 10s/120s wait: if signRequest secretly inherited it, this response
    // would time it out exactly like the control call below — it doesn't,
    // because it hardcodes its own 120s deadline independent of the option.
    const delayedFetch = (ms: number, body: unknown): typeof fetch =>
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;

    const controlBroker = createRestCapabilityBroker({
      resolveUrl: (path) => path,
      controlTimeoutMs: 20,
      fetchImpl: delayedFetch(200, { entries: [] }),
    });
    const controlResult = await controlBroker.secrets.listMaskedEnv();
    expect(isCapabilityFailure(controlResult)).toBe(true);

    const mountBroker = createRestCapabilityBroker({
      resolveUrl: (path) => path,
      controlTimeoutMs: 20,
      fetchImpl: delayedFetch(200, { ok: true, status: 200, headers: {}, bodyBase64: '' }),
    });
    const signResult = await mountBroker.mounts.signRequest({
      backend: 's3',
      envelope: { profile: 'p', method: 'GET', bucket: 'b', key: 'k' },
    });
    expect(signResult.ok).toBe(true);
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

  it('bounds a control-plane call so a wedged server cannot hang a scoop', async () => {
    // A wedged server never rejects — it just never answers — so without the
    // deadline `initShellAndSkills` would await its masked env forever and the
    // terminal would never finish mounting.
    const broker = createRestCapabilityBroker({
      resolveUrl: (path) => path,
      // Production is 10s, longer than a test should sit for; the budget is a
      // composition seam, not a per-request knob.
      controlTimeoutMs: 25,
      fetchImpl: ((_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
          });
        })) as typeof fetch,
    });
    const result = await broker.secrets.listMaskedEnv();
    expect(isCapabilityFailure(result)).toBe(true);
    if (isCapabilityFailure(result)) expect(result.message).toContain('no answer within');
  });

  it('never puts a machine deadline on an approval — a slow human is not a failure', async () => {
    // `/api/sudo-approve` returns only once the OS dialog has been ANSWERED,
    // so the control deadline must not reach it: at 10s it would deny every
    // approval a person took a moment to read. The budget is the caller's
    // `signal`, i.e. `withApprovalTimeout`'s five minutes.
    const signals: Array<AbortSignal | null | undefined> = [];
    let answer: (() => void) | undefined;
    const broker = createRestCapabilityBroker({
      resolveUrl: (path) => path,
      controlTimeoutMs: 25,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        signals.push(init?.signal);
        // A human "thinking" for well past the control deadline.
        await new Promise<void>((resolve) => {
          answer = resolve;
          setTimeout(resolve, 60);
        });
        return new Response(JSON.stringify({ decision: 'allow' }), { status: 200 });
      }) as typeof fetch,
    });
    const decision = await broker.approvals.request({ kind: 'command', detail: 'ls' });
    expect(answer).toBeDefined();
    // No signal at all when the caller supplied none: nothing can cut it short.
    expect(signals[0]).toBeUndefined();
    expect(decision).toEqual({ ok: true, value: { decision: 'allow' } });

    // A caller's signal IS honoured, and is the only thing that is.
    const controller = new AbortController();
    controller.abort();
    await broker.approvals.request({
      kind: 'command',
      detail: 'ls',
      signal: controller.signal,
    });
    expect(signals[1]).toBe(controller.signal);
  });

  it('carries a caller signal into the fetch instead of imposing its own deadline', async () => {
    // A multi-MB download is not a hang, so `crossOriginFetch` takes the
    // caller's budget rather than the 10s control-plane one.
    const seen: Array<AbortSignal | null | undefined> = [];
    const controller = new AbortController();
    const broker = createRestCapabilityBroker({
      resolveUrl: (path) => path,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        seen.push(init?.signal);
        return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
      }) as typeof fetch,
    });
    await broker.network.crossOriginFetch({
      url: 'https://example.test/',
      signal: controller.signal,
    });
    await broker.network.crossOriginFetch({ url: 'https://example.test/' });
    expect(seen[0]).toBe(controller.signal);
    expect(seen[1]).toBeUndefined();
  });

  it('refuses a request or response body past the proxy ceilings', async () => {
    const { REQUEST_BODY_CAP } = await import('../../src/shell/proxied-fetch.js');
    const calls: number[] = [];
    const broker = createRestCapabilityBroker({
      resolveUrl: (path) => path,
      fetchImpl: (async () => {
        calls.push(1);
        return new Response('x', {
          status: 200,
          headers: { 'content-type': 'text/plain', 'content-length': String(1024 ** 4) },
        });
      }) as typeof fetch,
    });

    const tooBig = await broker.network.crossOriginFetch({
      url: 'https://example.test/',
      method: 'POST',
      body: 'a'.repeat(REQUEST_BODY_CAP + 1),
    });
    expect(isCapabilityFailure(tooBig)).toBe(true);
    if (isCapabilityFailure(tooBig)) expect(tooBig.message).toContain('proxy limit');
    // Refused before anything was sent — the point of a request-side cap.
    expect(calls).toHaveLength(0);

    const tooLarge = await broker.network.crossOriginFetch({ url: 'https://example.test/' });
    expect(isCapabilityFailure(tooLarge)).toBe(true);
    if (isCapabilityFailure(tooLarge)) expect(tooLarge.message).toContain('download limit');
  });

  it('forwards an approver directive so a delegated request keeps its routing', async () => {
    const { log, broker } = harness();
    await broker.approvals.request({
      kind: 'guest-tool',
      detail: 'rm -rf /',
      requester: 'seat-7',
      approver: { kind: 'cone', unitJid: 'cone_a' },
    });
    expect(log[0].body).toMatchObject({
      requester: 'seat-7',
      approver: { kind: 'cone', unitJid: 'cone_a' },
    });
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

// Restores coverage `sudo/http-broker.test.ts` used to carry before slice C
// (#2276 round-1 review finding 2): `restRequestApproval` reaches
// `/api/sudo-approve` through the SAME `resolveApiUrl` / `apiHeaders` every
// other REST operation uses, so a thin-bridge misconfiguration would affect
// approvals identically. Uses a plain captured-call mock rather than
// `scriptedRestFetch` — that fixture's route table matches on the RELATIVE
// path only, and the whole point here is asserting the ABSOLUTE URL
// `resolveApiUrl` produces once a thin-bridge base is set.
describe('node-rest adapter — thin-bridge URL + token on /api/sudo-approve', () => {
  afterEach(() => {
    setLocalApiBaseUrl(null);
    setBridgeToken(null);
  });

  function captureCall(): {
    fetchImpl: typeof fetch;
    getUrl: () => string | null;
    getHeaders: () => Record<string, string> | null;
  } {
    let capturedUrl: string | null = null;
    let capturedHeaders: Record<string, string> | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      capturedHeaders = (init?.headers ?? null) as Record<string, string> | null;
      return new Response(JSON.stringify({ decision: 'allow' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return { fetchImpl, getUrl: () => capturedUrl, getHeaders: () => capturedHeaders };
  }

  it('legacy / same-origin: POSTs the relative path with no X-Bridge-Token', async () => {
    const cap = captureCall();
    const broker = createRestCapabilityBroker({ fetchImpl: cap.fetchImpl });
    await broker.approvals.request({ kind: 'command', detail: 'git push origin main' });
    expect(cap.getUrl()).toBe(REST_CAPABILITY_PATHS.sudoApprove);
    expect(cap.getHeaders()?.['X-Bridge-Token']).toBeUndefined();
  });

  it('thin-bridge: POSTs to the bridge origin with X-Bridge-Token', async () => {
    setLocalApiBaseUrl('http://localhost:5710');
    setBridgeToken('abc-123');
    const cap = captureCall();
    const broker = createRestCapabilityBroker({ fetchImpl: cap.fetchImpl });
    await broker.approvals.request({ kind: 'command', detail: 'git push origin main' });
    expect(cap.getUrl()).toBe(`http://localhost:5710${REST_CAPABILITY_PATHS.sudoApprove}`);
    expect(cap.getHeaders()?.['X-Bridge-Token']).toBe('abc-123');
  });

  it('thin-bridge: base set but no token → absolute URL, still no X-Bridge-Token', async () => {
    setLocalApiBaseUrl('http://localhost:5710');
    const cap = captureCall();
    const broker = createRestCapabilityBroker({ fetchImpl: cap.fetchImpl });
    await broker.approvals.request({ kind: 'command', detail: 'git push origin main' });
    expect(cap.getUrl()).toBe(`http://localhost:5710${REST_CAPABILITY_PATHS.sudoApprove}`);
    expect(cap.getHeaders()?.['X-Bridge-Token']).toBeUndefined();
  });

  it('token set but no base → relative path, X-Bridge-Token omitted', async () => {
    setBridgeToken('abc-123');
    const cap = captureCall();
    const broker = createRestCapabilityBroker({ fetchImpl: cap.fetchImpl });
    await broker.approvals.request({ kind: 'command', detail: 'git push origin main' });
    expect(cap.getUrl()).toBe(REST_CAPABILITY_PATHS.sudoApprove);
    expect(cap.getHeaders()?.['X-Bridge-Token']).toBeUndefined();
  });
});
