/**
 * #3459 wiring: `initShellAndSkills` puts the blind-read decorator on a
 * memory pass's gated handle — recognised by its grant on a staged curation
 * draft — and on nobody else's. The shell constructor is stubbed to capture
 * the fs it is handed, so the assertion is against the handle the model's
 * commands actually run on.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RestrictedFS, VirtualFS } from '../../../src/fs/index.js';
import type { RegisteredScoop } from '../../../src/scoops/types.js';
import type { WorkUnitDescriptor } from '../../../src/work-unit/types.js';
import { createFakeCapabilityBroker } from '../../helpers/fake-capability-broker.js';

const captures = vi.hoisted(() => ({
  shellFs: [] as VirtualFS[],
}));

vi.mock('../../../src/shell/almost-bash-shell-headless.js', () => ({
  AlmostBashShellHeadless: vi.fn(function (this: unknown, options: { fs: VirtualFS }) {
    captures.shellFs.push(options.fs);
    return this;
  }),
}));

vi.mock('../../../src/scoops/skills.js', () => ({
  createDefaultSkills: async () => {},
  loadSkills: async () => [],
  formatSkillsForPrompt: () => '',
}));

const { initShellAndSkills } = await import(
  '../../../src/scoops/scoop-context/shell-and-skills.js'
);

const DRAFT = '/sessions/.curation/dream-2026-09-24-cone.md/draft.md';
const VISIBLE = ['/sessions/', '/shared/', '/workspace/'];

function unitWith(writablePaths: string[]): WorkUnitDescriptor {
  return {
    policy: {
      filesystem: {
        kind: 'restricted',
        mode: 'shared-readonly',
        writablePaths,
        visiblePaths: VISIBLE,
      },
      approvalAuthority: { parentId: 'cone' },
    },
    workspace: { root: '/workspace' },
    display: { role: 'child' },
  } as unknown as WorkUnitDescriptor;
}

const scoop = { folder: 'agent-memory-dreamer', jid: 'jid-1' } as unknown as RegisteredScoop;

describe('#3459 — initShellAndSkills wires the blind-read ledger for a memory pass', () => {
  let vfs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    captures.shellFs.length = 0;
    vfs = await VirtualFS.create({ dbName: `test-blind-wiring-${dbCounter++}`, wipe: true });
    await vfs.mkdir('/etc', { recursive: true });
    await vfs.writeFile('/etc/llmstxtignore', 'www.printful.com\n');
  });

  afterEach(async () => {
    await vfs.dispose();
  });

  async function init(writablePaths: string[]) {
    const fs = new RestrictedFS(vfs, writablePaths, VISIBLE, 'sudo-delegated');
    const result = await initShellAndSkills({
      scoop,
      unit: unitWith(writablePaths),
      fs,
      skillsFs: null,
      getBrowserAPI: () => ({}) as never,
      sudoManager: null,
      capabilityBroker: createFakeCapabilityBroker({
        listMaskedEnv: { ok: true, value: { entries: [] } },
      }),
      processManager: null,
      processOwner: { kind: 'cone' },
      getTurnPid: () => undefined,
      lickTarget: undefined,
      tmpDir: '/scoops/agent-memory-dreamer/tmp',
    });
    expect(captures.shellFs).toHaveLength(1);
    return { result, shellFs: captures.shellFs[0] as VirtualFS };
  }

  it('gives a memory pass a ledger, and a shell whose blind reads land on it', async () => {
    // The bridge spells the file grant with a trailing slash; the predicate tolerates it.
    const { result, shellFs } = await init([`${DRAFT}/`, '/scoops/agent-memory-dreamer/', '/tmp/']);
    expect(result.blindReads).not.toBeNull();
    await expect(shellFs.readFile('/etc/llmstxtignore')).rejects.toMatchObject({ code: 'EACCES' });
    expect(result.blindReads?.outsidePaths()).toEqual(['/etc/llmstxtignore']);
    expect(result.blindReads?.takeNote()).toContain(
      '[not visible from this pass] /etc/llmstxtignore'
    );
    // The memory guard still sits on top: the draft is written only via memory_write.
    await expect(shellFs.writeFile(DRAFT, 'x')).rejects.toMatchObject({ code: 'EACCES' });
    await result.memoryFs.writeFile(DRAFT, '# Memory\n');
    expect(await vfs.readFile(DRAFT, { encoding: 'utf-8' })).toBe('# Memory\n');
  });

  it('leaves an ordinary scoop on the silent ENOENT surface', async () => {
    const { result, shellFs } = await init(['/scoops/agent-memory-dreamer/', '/tmp/']);
    expect(result.blindReads).toBeNull();
    await expect(shellFs.readFile('/etc/llmstxtignore')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
