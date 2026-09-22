/**
 * Pins config-owned host mounts to the moment the shared filesystem exists,
 * before scoop restore, and to the later retry that also filters persisted
 * rows. A refactor that moves them back to step 9 alone reopens the race
 * where a picker mount takes the target during a long boot.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, '..', '..', 'src', 'kernel', 'host.ts');
const orchestratorPath = join(here, '..', '..', 'src', 'scoops', 'orchestrator.ts');
const host = readFileSync(hostPath, 'utf8');
const orchestrator = readFileSync(orchestratorPath, 'utf8');

describe('config-owned host mount boot order', () => {
  it('applies host mounts inside orchestrator.init, before buffer hydration', () => {
    const initCall = host.indexOf('await orchestrator.init(');
    const hook = host.indexOf('onSharedFsReady: async');
    const apply = host.indexOf('await applyConfiguredHostMounts(fs, bootLog)');
    const hydrate = host.indexOf('hydrateBuffersFromRecords');
    expect(initCall).toBeGreaterThan(0);
    expect(hook).toBeGreaterThan(initCall);
    expect(apply).toBeGreaterThan(hook);
    expect(apply).toBeLessThan(hydrate);
  });

  it('runs the shared-fs hook before the root cone wave', () => {
    const ready = orchestrator.indexOf('if (hooks?.onSharedFsReady)');
    const policy = orchestrator.indexOf('await this.initPolicyLayerAndLoadRecords');
    const wave = orchestrator.indexOf('await this.restoreScoopContexts');
    expect(ready).toBeGreaterThan(0);
    expect(ready).toBeLessThan(policy);
    expect(policy).toBeLessThan(wave);
  });

  it('retries host mounts from persisted-mount recovery so a failed early fetch is not final', () => {
    const recover = host.indexOf('async function recoverPersistedMounts');
    const apply = host.indexOf('await applyConfiguredHostMounts(sharedFs, log)', recover);
    const recoverMounts = host.indexOf('recoverMounts(entries', recover);
    expect(recover).toBeGreaterThan(0);
    expect(apply).toBeGreaterThan(recover);
    expect(recoverMounts).toBeGreaterThan(apply);
  });
});
