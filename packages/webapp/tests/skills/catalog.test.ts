import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { VirtualFS } from '../../src/fs/index.js';
import { createSudoFs, MONKEYPATCH_UNSAFE_FS } from '../../src/fs/sudo-fs.js';
import { emptyPolicy } from '../../src/shell/sudo/sudoers.js';
import { discoverSkillCandidates, resolveSkillNameCollisions } from '../../src/skills/catalog.js';

describe('discoverSkillCandidates', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    // VirtualFS' memory backend caches stores per dbName so multiple
    // alive instances share state. Pass `wipe: true` here so each
    // test starts with a clean tree (the prior LightningFS path
    // relied on `new IDBFactory()` for the same effect).
    fs = await VirtualFS.create({ wipe: true });
  });

  it('finds native, .agents, and .claude skill directories with stable precedence order', async () => {
    await fs.mkdir('/workspace/skills/native-skill', { recursive: true });
    await fs.writeFile('/workspace/skills/native-skill/SKILL.md', '# native');

    await fs.mkdir('/repo/tools/.agents/skills/agent-skill', { recursive: true });
    await fs.writeFile('/repo/tools/.agents/skills/agent-skill/SKILL.md', '# agent');

    await fs.mkdir('/repo/docs/.claude/skills/claude-skill', { recursive: true });
    await fs.writeFile('/repo/docs/.claude/skills/claude-skill/SKILL.md', '# claude');

    await fs.mkdir('/repo/ignored/.claude/skills/not-a-skill', { recursive: true });
    await fs.writeFile('/repo/ignored/.claude/skills/not-a-skill/README.md', 'ignore me');

    const candidates = await discoverSkillCandidates(fs);

    expect(
      candidates.map((candidate) => ({
        source: candidate.source,
        path: candidate.path,
      }))
    ).toEqual([
      { source: 'native', path: '/workspace/skills/native-skill' },
      { source: 'agents', path: '/repo/tools/.agents/skills/agent-skill' },
      { source: 'claude', path: '/repo/docs/.claude/skills/claude-skill' },
    ]);
  });

  it('uses lexicographic path order within the same compatibility source bucket', async () => {
    await fs.mkdir('/z-last/.agents/skills/duplicate', { recursive: true });
    await fs.writeFile('/z-last/.agents/skills/duplicate/SKILL.md', '# z');

    await fs.mkdir('/a-first/.agents/skills/duplicate', { recursive: true });
    await fs.writeFile('/a-first/.agents/skills/duplicate/SKILL.md', '# a');

    const candidates = await discoverSkillCandidates(fs);

    expect(
      candidates
        .filter((candidate) => candidate.source === 'agents')
        .map((candidate) => candidate.path)
    ).toEqual(['/a-first/.agents/skills/duplicate', '/z-last/.agents/skills/duplicate']);
  });

  it('continues scanning until later reachable compatibility roots are visited', async () => {
    // The historical `MAX_DISCOVERY_DIRECTORIES = 10_000` cap in catalog.ts
    // was removed in d14f81c6; today the BFS walks the whole tree. The
    // test now only needs to prove the queue does not stop early between
    // an early lexicographic neighbour and a late `.claude` root. A
    // modest synthetic count exercises the BFS past several pump rounds
    // without spending 25-30s on ZenFS InMemory mkdir under Node 24/25.
    for (let index = 0; index < 256; index += 1) {
      await fs.mkdir(`/node-${index.toString().padStart(5, '0')}`, { recursive: true });
    }

    await fs.mkdir('/zz-after-cap/.claude/skills/late-skill', { recursive: true });
    await fs.writeFile('/zz-after-cap/.claude/skills/late-skill/SKILL.md', '# late');

    const candidates = await discoverSkillCandidates(fs);

    expect(candidates).toContainEqual(
      expect.objectContaining({
        source: 'claude',
        path: '/zz-after-cap/.claude/skills/late-skill',
      })
    );
  });

  it('refreshes cached compatibility discovery after the same fs instance mutates', async () => {
    await fs.mkdir('/repo/.claude/skills/first-skill', { recursive: true });
    await fs.writeFile('/repo/.claude/skills/first-skill/SKILL.md', '# first');

    const initialCandidates = await discoverSkillCandidates(fs);
    expect(initialCandidates.map((candidate) => candidate.path)).toEqual([
      '/repo/.claude/skills/first-skill',
    ]);

    await fs.mkdir('/repo/tools/.agents/skills/second-skill', { recursive: true });
    await fs.writeFile('/repo/tools/.agents/skills/second-skill/SKILL.md', '# second');

    const refreshedCandidates = await discoverSkillCandidates(fs);
    expect(refreshedCandidates.map((candidate) => candidate.path)).toEqual([
      '/repo/tools/.agents/skills/second-skill',
      '/repo/.claude/skills/first-skill',
    ]);
  });

  it('prunes internal .slicc compatibility trees without skipping normal roots', async () => {
    await fs.mkdir('/.slicc/.claude/skills/hidden-skill', { recursive: true });
    await fs.writeFile('/.slicc/.claude/skills/hidden-skill/SKILL.md', '# hidden');

    await fs.mkdir('/repo/.claude/skills/visible-skill', { recursive: true });
    await fs.writeFile('/repo/.claude/skills/visible-skill/SKILL.md', '# visible');

    const candidates = await discoverSkillCandidates(fs);

    expect(candidates.map((candidate) => candidate.path)).toEqual([
      '/repo/.claude/skills/visible-skill',
    ]);
  });

  it('discovers marketplace skills from a .claude-plugin/marketplace.json', async () => {
    const manifest = JSON.stringify({
      name: 'test-marketplace',
      metadata: { version: '1.0.0' },
      plugins: [
        { name: 'my-tools', description: 'My tools', source: './plugins/my-tools', strict: false },
      ],
    });

    await fs.mkdir('/mnt/repo/.claude-plugin', { recursive: true });
    await fs.writeFile('/mnt/repo/.claude-plugin/marketplace.json', manifest);
    await fs.mkdir('/mnt/repo/plugins/my-tools/skills/my-skill', { recursive: true });
    await fs.writeFile(
      '/mnt/repo/plugins/my-tools/skills/my-skill/SKILL.md',
      '---\nname: my-skill\n---\n'
    );

    const candidates = await discoverSkillCandidates(fs);

    expect(candidates).toContainEqual(
      expect.objectContaining({
        source: 'marketplace',
        path: '/mnt/repo/plugins/my-tools/skills/my-skill',
      })
    );
  });

  it('skips marketplace plugins whose source is a git-subdir object', async () => {
    const manifest = JSON.stringify({
      name: 'test-marketplace',
      metadata: { version: '1.0.0' },
      plugins: [
        { name: 'local-plugin', source: './plugins/local', strict: false },
        {
          name: 'external-plugin',
          source: {
            source: 'git-subdir',
            url: 'https://github.com/org/repo',
            path: '.',
            sha: 'abc',
          },
          strict: false,
        },
      ],
    });

    await fs.mkdir('/mnt/repo/.claude-plugin', { recursive: true });
    await fs.writeFile('/mnt/repo/.claude-plugin/marketplace.json', manifest);
    await fs.mkdir('/mnt/repo/plugins/local/skills/local-skill', { recursive: true });
    await fs.writeFile(
      '/mnt/repo/plugins/local/skills/local-skill/SKILL.md',
      '---\nname: local-skill\n---\n'
    );

    const candidates = await discoverSkillCandidates(fs);
    const names = candidates.map((c) => c.path.split('/').pop());

    expect(names).toContain('local-skill');
    expect(candidates.filter((c) => c.source === 'marketplace')).toHaveLength(1);
  });

  it('discovers skills across multiple plugins in one manifest', async () => {
    const manifest = JSON.stringify({
      name: 'multi-marketplace',
      metadata: { version: '1.0.0' },
      plugins: [
        { name: 'plugin-a', source: './plugins/a', strict: false },
        { name: 'plugin-b', source: './plugins/b', strict: false },
      ],
    });

    await fs.mkdir('/mnt/repo/.claude-plugin', { recursive: true });
    await fs.writeFile('/mnt/repo/.claude-plugin/marketplace.json', manifest);
    await fs.mkdir('/mnt/repo/plugins/a/skills/skill-one', { recursive: true });
    await fs.writeFile(
      '/mnt/repo/plugins/a/skills/skill-one/SKILL.md',
      '---\nname: skill-one\n---\n'
    );
    await fs.mkdir('/mnt/repo/plugins/b/skills/skill-two', { recursive: true });
    await fs.writeFile(
      '/mnt/repo/plugins/b/skills/skill-two/SKILL.md',
      '---\nname: skill-two\n---\n'
    );

    const candidates = await discoverSkillCandidates(fs);
    const marketplaceCandidates = candidates.filter((c) => c.source === 'marketplace');

    expect(marketplaceCandidates.map((c) => c.path.split('/').pop()).sort()).toEqual([
      'skill-one',
      'skill-two',
    ]);
  });

  it('native skill shadows marketplace skill with the same name', async () => {
    const manifest = JSON.stringify({
      name: 'test-marketplace',
      metadata: { version: '1.0.0' },
      plugins: [{ name: 'my-tools', source: './plugins/my-tools', strict: false }],
    });

    await fs.mkdir('/workspace/skills/shared-name', { recursive: true });
    await fs.writeFile(
      '/workspace/skills/shared-name/SKILL.md',
      '---\nname: shared-name\n---\n# native'
    );

    await fs.mkdir('/mnt/repo/.claude-plugin', { recursive: true });
    await fs.writeFile('/mnt/repo/.claude-plugin/marketplace.json', manifest);
    await fs.mkdir('/mnt/repo/plugins/my-tools/skills/shared-name', { recursive: true });
    await fs.writeFile(
      '/mnt/repo/plugins/my-tools/skills/shared-name/SKILL.md',
      '---\nname: shared-name\n---\n# marketplace'
    );

    const candidates = await discoverSkillCandidates(fs);
    const { winners } = resolveSkillNameCollisions(
      candidates,
      (c) => c.path.split('/').pop() ?? ''
    );
    const winner = winners.find((w) => w.path.split('/').pop() === 'shared-name');

    expect(winner?.source).toBe('native');
  });

  it('ignores malformed marketplace.json without throwing', async () => {
    await fs.mkdir('/mnt/repo/.claude-plugin', { recursive: true });
    await fs.writeFile('/mnt/repo/.claude-plugin/marketplace.json', 'not valid json {{{');

    const candidates = await discoverSkillCandidates(fs);
    expect(candidates.filter((c) => c.source === 'marketplace')).toHaveLength(0);
  });

  it('discovers skills when plugin source is repo root ("." or "./")', async () => {
    // Regression: source "." and "./" must resolve to the manifest parent dir,
    // not produce a leading "." or "/" that fails to match VFS paths.
    for (const source of ['.', './']) {
      globalThis.indexedDB = new IDBFactory();
      fs = await VirtualFS.create({ wipe: true });

      const manifest = JSON.stringify({
        name: 'root-source-marketplace',
        metadata: { version: '1.0.0' },
        plugins: [{ name: 'my-plugin', source, strict: false }],
      });

      await fs.mkdir('/mnt/repo/.claude-plugin', { recursive: true });
      await fs.writeFile('/mnt/repo/.claude-plugin/marketplace.json', manifest);
      await fs.mkdir('/mnt/repo/skills/root-skill', { recursive: true });
      await fs.writeFile('/mnt/repo/skills/root-skill/SKILL.md', '---\nname: root-skill\n---\n');

      const candidates = await discoverSkillCandidates(fs);
      const marketplace = candidates.filter((c) => c.source === 'marketplace');

      expect(marketplace).toHaveLength(1);
      expect(marketplace[0].path).toBe('/mnt/repo/skills/root-skill');
    }
  });
});

describe('discoverSkillCandidates over a sudo-fs Proxy (OOM regression)', () => {
  let raw: VirtualFS;
  let gated: VirtualFS;

  const noopBroker = {
    async requestApproval() {
      return { decision: 'allow' as const };
    },
  };

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    raw = await VirtualFS.create({ wipe: true });
    // Empty policy => nothing is gated, so reads/writes pass straight through —
    // isolating the discovery/monkeypatch interaction from approval prompts.
    gated = createSudoFs(raw, { broker: noopBroker, getPolicy: () => emptyPolicy() });
  });

  it('advertises the monkeypatch-unsafe marker', () => {
    expect((gated as unknown as Record<symbol, unknown>)[MONKEYPATCH_UNSAFE_FS]).toBe(true);
    expect((raw as unknown as Record<symbol, unknown>)[MONKEYPATCH_UNSAFE_FS]).toBeUndefined();
  });

  it('does NOT monkeypatch the wrapped target (the override↔hook recursion that OOMed the worker)', async () => {
    await raw.mkdir('/workspace/.claude/skills/foo', { recursive: true });
    await raw.writeFile('/workspace/.claude/skills/foo/SKILL.md', '# foo');

    // Capturing the wrapped target's gated methods BEFORE discovery: the bug
    // reassigned `raw.writeFile`/`raw.mkdir`/etc. on the Proxy's target (the
    // `set` writes through), leaving the sudo override delegating to the hook
    // and the hook calling back into the override — an unbounded async cycle.
    const before = {
      writeFile: raw.writeFile,
      mkdir: raw.mkdir,
      rm: raw.rm,
    };

    const candidates = await discoverSkillCandidates(gated);

    // Discovery still works through the gated handle...
    expect(candidates.map((c) => c.path)).toContain('/workspace/.claude/skills/foo');
    // ...without having clobbered the wrapped target's real methods.
    expect(raw.writeFile).toBe(before.writeFile);
    expect(raw.mkdir).toBe(before.mkdir);
    expect(raw.rm).toBe(before.rm);

    // A gated write reaches the real fs exactly once (no recursion) and persists.
    let realWriteCalls = 0;
    const realWrite = raw.writeFile.bind(raw);
    raw.writeFile = (async (path: string, content: string | Uint8Array) => {
      realWriteCalls += 1;
      return realWrite(path, content);
    }) as typeof raw.writeFile;
    await gated.writeFile('/tmp/probe.txt', 'ok');
    expect(realWriteCalls).toBe(1);
    expect(await raw.readTextFile('/tmp/probe.txt')).toBe('ok');
  });

  it('returns the same candidates whether discovery runs over the raw fs or the gated Proxy', async () => {
    await raw.mkdir('/repo/.agents/skills/agent-skill', { recursive: true });
    await raw.writeFile('/repo/.agents/skills/agent-skill/SKILL.md', '# agent');
    await raw.mkdir('/workspace/skills/native-skill', { recursive: true });
    await raw.writeFile('/workspace/skills/native-skill/SKILL.md', '# native');

    const overRaw = (await discoverSkillCandidates(raw)).map((c) => c.path);
    const overGated = (await discoverSkillCandidates(gated)).map((c) => c.path);

    expect(overGated).toEqual(overRaw);
  });
});

describe('resolveSkillNameCollisions', () => {
  it('keeps the first entry and records later entries as shadowed', () => {
    const { winners, collisions } = resolveSkillNameCollisions(
      [
        { name: 'shared', path: '/workspace/skills/shared' },
        { name: 'shared', path: '/repo/.agents/skills/shared' },
        { name: 'shared', path: '/repo/.claude/skills/shared' },
      ],
      (entry) => entry.name
    );

    expect(winners).toEqual([{ name: 'shared', path: '/workspace/skills/shared' }]);
    expect(collisions).toEqual([
      {
        name: 'shared',
        winner: { name: 'shared', path: '/workspace/skills/shared' },
        shadowed: [
          { name: 'shared', path: '/repo/.agents/skills/shared' },
          { name: 'shared', path: '/repo/.claude/skills/shared' },
        ],
      },
    ]);
  });
});
