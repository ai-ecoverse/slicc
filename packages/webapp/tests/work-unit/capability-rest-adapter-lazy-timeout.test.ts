/**
 * `rest-adapter.ts` bounds its lazy `rest-ops.js` chunk load with the same
 * deadline the loaded module's control-plane calls use (#2276 slice C,
 * round-1 review finding 3): a stalled chunk fetch must not block the FIRST
 * privileged call forever — for `scoop-context/shell-and-skills.ts`, that's
 * `initShellAndSkills` and therefore kernel-ready.
 *
 * `createLazyOps`'s own timeout MECHANISM is unit-tested (with fake timers)
 * in `capability-boundary.test.ts`; this file only proves the WIRING: that
 * `rest-adapter.ts` actually passes a timeout, and the right one. It mocks
 * `boundary.js` module-wide, so it stays a separate file from
 * `capability-rest-adapter.test.ts`'s ~40 tests against the real wiring.
 */
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
