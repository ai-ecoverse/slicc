import { describe, expect, it } from 'vitest';
import { FakeSubstrate } from './fake-substrate.js';

describe('SandboxSubstrate contract (FakeSubstrate)', () => {
  it('create returns a handle whose sandboxId appears in list()', async () => {
    const sub = new FakeSubstrate();
    const handle = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: { sliccVersion: '3.2.2' },
      autoPauseOnCap: true,
    });
    expect(handle.sandboxId).toMatch(/^fake-/);
    const list = await sub.list();
    expect(list.map((s) => s.sandboxId)).toContain(handle.sandboxId);
  });

  it('writeFile then readFile round-trips', async () => {
    const sub = new FakeSubstrate();
    const handle = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: {},
      autoPauseOnCap: true,
    });
    await handle.writeFile('/slicc/secrets.env', 'KEY=value');
    expect(await handle.readFile('/slicc/secrets.env')).toBe('KEY=value');
  });

  it('pause then connect resumes the same sandbox', async () => {
    const sub = new FakeSubstrate();
    const handle = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: {},
      autoPauseOnCap: true,
    });
    await handle.pause();
    expect((await handle.getInfo()).state).toBe('paused');
    const resumed = await sub.connect(handle.sandboxId);
    expect((await resumed.getInfo()).state).toBe('running');
  });

  it('kill removes the sandbox from list()', async () => {
    const sub = new FakeSubstrate();
    const handle = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: {},
      autoPauseOnCap: true,
    });
    await handle.kill();
    const list = await sub.list();
    expect(list.map((s) => s.sandboxId)).not.toContain(handle.sandboxId);
  });
});
