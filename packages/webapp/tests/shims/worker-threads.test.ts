import { describe, expect, it } from 'vitest';

describe('worker-threads shim', () => {
  it('exports workerData as undefined before init', async () => {
    const mod = await import('../../src/shims/worker-threads.js');
    expect(mod.workerData).toBeUndefined();
  });

  it('exports parentPort as null before init', async () => {
    const mod = await import('../../src/shims/worker-threads.js');
    expect(mod.parentPort).toBeNull();
  });

  it('Worker class has the required host-side API surface', async () => {
    const mod = await import('../../src/shims/worker-threads.js');
    expect(mod.Worker).toBeTypeOf('function');
    expect(mod.Worker.prototype.on).toBeTypeOf('function');
    expect(mod.Worker.prototype.postMessage).toBeTypeOf('function');
    expect(mod.Worker.prototype.terminate).toBeTypeOf('function');
  });

  it('_initWorkerSide is exported as a function', async () => {
    const mod = await import('../../src/shims/worker-threads.js');
    expect(mod._initWorkerSide).toBeTypeOf('function');
  });
});
