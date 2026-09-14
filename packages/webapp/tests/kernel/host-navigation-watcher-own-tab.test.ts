import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string): string =>
  readFileSync(join(here, '..', '..', 'src', ...path.split('/')), 'utf8');

const hostSource = source('kernel/host.ts');
const workerSource = source('kernel/kernel-worker.ts');

describe('kernel host leader-tab wiring', () => {
  it("forwards the init message's appPageUrl into createKernelHost", () => {
    const hostCall = workerSource.indexOf('await createKernelHost({');
    expect(hostCall).toBeGreaterThan(-1);
    expect(workerSource.slice(hostCall, hostCall + 600)).toContain(
      'appPageUrl: init.appPageUrl ?? null'
    );
  });

  it('hands the host config value to the NavigationWatcher starter', () => {
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
