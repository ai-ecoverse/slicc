/**
 * `createSudoBroker` against a REAL `createRestCapabilityBroker` (#2276
 * round-1 review finding 2) — the sudo-layer unit tests mock the REST wire
 * and `capability-gesture-broker.ts` separately; this file proves the FULL
 * stack actually composes: `createSudoBroker` (the timeout wrap + tray-first,
 * which falls through to the raw leg here since no panel-RPC client exists
 * in this test env) → `capability-gesture-broker.ts` → a real
 * `createRestCapabilityBroker` → `restRequestApproval`. A malformed
 * `/api/sudo-approve` reply still comes out `deny` end-to-end — the REST
 * adapter's OWN `normalizeApprovalDecision` call already guarantees that
 * (see `capability-rest-adapter.test.ts`'s equivalent adapter-level test);
 * `capability-gesture-broker.test.ts`'s unit tests are what pin the gesture
 * broker's OWN defence-in-depth re-normalization specifically, using a fake
 * adapter that does NOT self-normalize.
 */

import { describe, expect, it } from 'vitest';
import { createSudoBroker } from '../../src/sudo/index.js';
import { createRestCapabilityBroker } from '../../src/work-unit/capability/index.js';

function sudoBrokerOverRest(body: string, status = 200) {
  const rest = createRestCapabilityBroker({
    resolveUrl: (path) => path,
    fetchImpl: (async () => new Response(body, { status })) as typeof fetch,
  });
  return createSudoBroker(rest);
}

describe('createSudoBroker over a real node-rest CapabilityBroker', () => {
  it('a 200 with an unrecognized decision shape denies end-to-end', async () => {
    const broker = sudoBrokerOverRest('{"decision":"maybe"}');
    const decision = await broker.requestApproval({ kind: 'command', detail: 'ls' });
    expect(decision).toEqual({ decision: 'deny' });
  });

  it('a 200 always with no pattern fills the suggested default end-to-end', async () => {
    const broker = sudoBrokerOverRest('{"decision":"always"}');
    const decision = await broker.requestApproval({
      kind: 'command',
      detail: 'git push',
      suggestedPattern: 'git push*',
    });
    expect(decision).toEqual({ decision: 'always', pattern: 'git push*' });
  });

  it('a genuine allow reaches the caller end-to-end', async () => {
    const broker = sudoBrokerOverRest('{"decision":"allow"}');
    const decision = await broker.requestApproval({ kind: 'command', detail: 'ls' });
    expect(decision).toEqual({ decision: 'allow' });
  });

  it('a transport failure (non-JSON reply) denies end-to-end', async () => {
    const broker = sudoBrokerOverRest('<html>502</html>', 502);
    const decision = await broker.requestApproval({ kind: 'command', detail: 'ls' });
    expect(decision).toEqual({ decision: 'deny' });
  });
});
