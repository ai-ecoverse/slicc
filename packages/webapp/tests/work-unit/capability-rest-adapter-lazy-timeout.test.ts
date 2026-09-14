import { describe, expect, it, vi } from 'vitest';

const captured: Array<number | undefined> = [];

vi.mock('../../src/work-unit/capability/boundary.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/work-unit/capability/boundary.js')>();
  return {
    ...actual,
    createLazyOps: <T>(load: () => Promise<T>, timeoutMs?: number) => {
      captured.push(timeoutMs);
      return actual.createLazyOps(load, timeoutMs);
    },
  };
});

describe('#2276 slice C — rest-adapter.ts bounds its lazy chunk load', () => {
  it('passes REST_CONTROL_CALL_TIMEOUT_MS to createLazyOps by default', async () => {
    const { createRestCapabilityBroker } = await import(
      '../../src/work-unit/capability/rest-adapter.js'
    );
    const { REST_CONTROL_CALL_TIMEOUT_MS } = await import(
      '../../src/work-unit/capability/rest-paths.js'
    );
    createRestCapabilityBroker();
    expect(captured).toEqual([REST_CONTROL_CALL_TIMEOUT_MS]);
  });

  it('honours an explicit controlTimeoutMs override for the lazy-load deadline too', async () => {
    const { createRestCapabilityBroker } = await import(
      '../../src/work-unit/capability/rest-adapter.js'
    );
    createRestCapabilityBroker({ controlTimeoutMs: 42 });
    expect(captured.at(-1)).toBe(42);
  });
});
