/**
 * Wiring guard for the leader-tab exclusion (#2417 follow-up).
 *
 * The predicate itself is unit-tested in `tests/cdp/navigation-watcher.test.ts`
 * and the page→worker hop in `spawn.test.ts`; what has no other coverage is the
 * middle of the chain, which lives inside `createKernelHost`'s boot sequence
 * and cannot be reached without booting an orchestrator. These are source-shape
 * assertions in the same style as `kernel-agent-bridge-topology.test.ts`: they
 * fail if the value stops being threaded, which is the failure mode that would
 * otherwise be invisible (the watcher just quietly re-attaches to our own tab).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string): string =>
  readFileSync(join(here, '..', '..', 'src', ...path.split('/')), 'utf8');

const hostSource = source('kernel/host.ts');
const workerSource = source('kernel/kernel-worker.ts');

describe('kernel host leader-tab exclusion wiring', () => {
  it("forwards the init message's appPageUrl into createKernelHost", () => {
    const hostCall = workerSource.indexOf('await createKernelHost({');
    expect(hostCall).toBeGreaterThan(-1);
    expect(workerSource.slice(hostCall, hostCall + 600)).toContain(
      'appPageUrl: init.appPageUrl ?? null'
    );
  });

  it('hands the host config value to the NavigationWatcher starter', () => {
    // The call site, not the declaration a few hundred lines above it.
    const call = hostSource.indexOf('= startNavigationWatcherForHost(');
    expect(call).toBeGreaterThan(-1);
    expect(hostSource.slice(call, hostSource.indexOf(');', call))).toContain('config.appPageUrl');
  });

  it('builds the watcher option from that URL rather than an origin test', () => {
    const watcher = hostSource.indexOf('new NavigationWatcher(');
    expect(watcher).toBeGreaterThan(-1);
    const ctor = hostSource.slice(watcher, watcher + 1600);
    expect(ctor).toContain('isOwnTab: createOwnTabMatcher(');
    expect(ctor).toContain('appPageUrl');
  });
});
