import { describe, expect, it, vi } from 'vitest';
import { type ProbeWorker, triageModuleWorkerHealth } from '../../../src/ui/boot/worker-triage.js';

/** A fake worker that signals on the given channel after `delayMs` (or never). */
function fakeWorker(behavior: 'message' | 'error' | 'silent', delayMs = 0) {
  const terminate = vi.fn();
  const spawn = (): ProbeWorker => ({
    addEventListener(type, listener) {
      if (type === behavior) setTimeout(listener, delayMs);
    },
    terminate,
  });
  return { spawn, terminate };
}

function throwingSpawn(): ProbeWorker {
  throw new Error('worker construction refused');
}

describe('triageModuleWorkerHealth (#1982)', () => {
  /** Defaults: probe script fetchable, short windows. Cases override. */
  function triage(deps: Parameters<typeof triageModuleWorkerHealth>[0]) {
    return triageModuleWorkerHealth({ fetchProbeScript: async () => true, timeoutMs: 20, ...deps });
  }

  it('classifies blob-alive + module-silent as browser-wedged', async () => {
    const blob = fakeWorker('message');
    const mod = fakeWorker('silent');
    const verdict = await triage({
      spawnBlobWorker: blob.spawn,
      spawnModuleWorker: mod.spawn,
    });
    expect(verdict).toBe('browser-wedged');
    // Both probes are torn down whatever they reported.
    expect(blob.terminate).toHaveBeenCalledTimes(1);
    expect(mod.terminate).toHaveBeenCalledTimes(1);
  });

  it('classifies a responsive module worker as workers-ok', async () => {
    const blob = fakeWorker('message');
    const mod = fakeWorker('message');
    await expect(
      triage({
        spawnBlobWorker: blob.spawn,
        spawnModuleWorker: mod.spawn,
      })
    ).resolves.toBe('workers-ok');
  });

  it("counts a module worker 'error' event as a signal — the wedge is silence", async () => {
    const blob = fakeWorker('message');
    const mod = fakeWorker('error');
    await expect(
      triage({
        spawnBlobWorker: blob.spawn,
        spawnModuleWorker: mod.spawn,
      })
    ).resolves.toBe('workers-ok');
  });

  it('is inconclusive when both probes stay silent', async () => {
    const blob = fakeWorker('silent');
    const mod = fakeWorker('silent');
    await expect(
      triage({
        spawnBlobWorker: blob.spawn,
        spawnModuleWorker: mod.spawn,
      })
    ).resolves.toBe('inconclusive');
  });

  it('is inconclusive when the blob probe cannot even spawn', async () => {
    const mod = fakeWorker('silent');
    await expect(
      triage({
        spawnBlobWorker: throwingSpawn,
        spawnModuleWorker: mod.spawn,
      })
    ).resolves.toBe('inconclusive');
  });

  it('still reports workers-ok when only the blob spawn fails', async () => {
    const mod = fakeWorker('message');
    await expect(
      triage({
        spawnBlobWorker: throwingSpawn,
        spawnModuleWorker: mod.spawn,
      })
    ).resolves.toBe('workers-ok');
  });

  it('never blames the browser when the probe script is not fetchable', async () => {
    // A network/SW outage produces the same blob-alive + module-silent
    // shape as the wedge; the page-realm fetch is the discriminator — in
    // the real incident the page fetched the asset the worker never
    // loaded. Unfetchable script → no restart diagnosis.
    const blob = fakeWorker('message');
    const mod = fakeWorker('silent');
    await expect(
      triage({
        spawnBlobWorker: blob.spawn,
        spawnModuleWorker: mod.spawn,
        fetchProbeScript: async () => false,
      })
    ).resolves.toBe('inconclusive');
  });
});
