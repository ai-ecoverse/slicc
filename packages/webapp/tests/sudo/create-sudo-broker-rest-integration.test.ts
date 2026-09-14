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
