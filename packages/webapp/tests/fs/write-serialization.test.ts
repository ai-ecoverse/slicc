import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';

function lock<T>(fs: VirtualFS, fn: () => Promise<T>): Promise<T> {
  return (fs as unknown as { withWriteLock<R>(f: () => Promise<R>): Promise<R> }).withWriteLock(fn);
}

function section(gauge: { now: number; peak: number }) {
  return async () => {
    gauge.now += 1;
    gauge.peak = Math.max(gauge.peak, gauge.now);
    await Promise.resolve();
    await Promise.resolve();
    gauge.now -= 1;
  };
}

describe('VirtualFS write serialization', () => {
  it('serializes mutations across instances sharing a dbName', async () => {
    const dbName = `serialize-${Date.now()}`;
    const a = await VirtualFS.create({ dbName, wipe: true });
    const b = await VirtualFS.create({ dbName });

    const gauge = { now: 0, peak: 0 };
    await Promise.all([
      lock(a, section(gauge)),
      lock(b, section(gauge)),
      lock(a, section(gauge)),
      lock(b, section(gauge)),
    ]);

    expect(gauge.peak).toBe(1);
  });

  it('keeps separate dbNames independent', async () => {
    const left = await VirtualFS.create({ dbName: `indep-l-${Date.now()}`, wipe: true });
    const right = await VirtualFS.create({ dbName: `indep-r-${Date.now()}`, wipe: true });

    const gauge = { now: 0, peak: 0 };
    await Promise.all([lock(left, section(gauge)), lock(right, section(gauge))]);

    expect(gauge.peak).toBe(2);
  });

  it('releases the chain when a writer throws', async () => {
    const dbName = `throwing-${Date.now()}`;
    const fs = await VirtualFS.create({ dbName, wipe: true });

    await expect(
      lock(fs, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    await fs.writeFile('/after.txt', 'still writable');
    expect(await fs.readFile('/after.txt', { encoding: 'utf-8' })).toBe('still writable');
  });

  it('does not retain a chain entry per dbName once writers drain', async () => {
    const dbName = `drain-${Date.now()}`;
    const fs = await VirtualFS.create({ dbName, wipe: true });
    await Promise.all([fs.writeFile('/x.txt', 'x'), fs.writeFile('/y.txt', 'y')]);

    const chains = (VirtualFS as unknown as { writeChains: Map<string, unknown> }).writeChains;
    expect(chains.has(dbName)).toBe(false);
  });

  it('still writes correctly through two instances on one dbName', async () => {
    const dbName = `content-${Date.now()}`;
    const a = await VirtualFS.create({ dbName, wipe: true });
    const b = await VirtualFS.create({ dbName });

    await Promise.all([
      a.writeFile('/one.txt', 'from a'),
      b.writeFile('/two.txt', 'from b'),
      a.mkdir('/nested/deep', { recursive: true }),
    ]);

    expect(await b.readFile('/one.txt', { encoding: 'utf-8' })).toBe('from a');
    expect(await a.readFile('/two.txt', { encoding: 'utf-8' })).toBe('from b');
    expect(await b.exists('/nested/deep')).toBe(true);
  });
});
