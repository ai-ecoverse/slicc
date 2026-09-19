import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { RestrictedFS } from '../../src/fs/restricted-fs.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import {
  DEFAULT_JSH_SEARCH_ROOTS,
  DEFAULT_SHELL_PATH,
  discoverJshCommandIndex,
  discoverJshCommands,
  formatJshCommandCollisions,
  type JshDiscoveryFS,
  pathToScanRoots,
  withJshCommandCollisions,
} from '../../src/shell/jsh-discovery.js';

function upskillRecord(skill: string, installed: string): string {
  return `${JSON.stringify({
    version: 1,
    kind: 'github',
    source: 'ai-ecoverse/skills',
    skill,
    installed,
  })}\n`;
}

function mockDiscoveryFs(files: Record<string, string>): JshDiscoveryFS {
  const paths = Object.keys(files);
  return {
    exists: async (path) =>
      paths.some((p) => p === path || p.startsWith(path.endsWith('/') ? path : `${path}/`)),
    walk: async function* (root) {
      const prefix = root.endsWith('/') ? root : `${root}/`;
      for (const p of paths) {
        if (p.startsWith(prefix) || p === root) yield p;
      }
    },
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  };
}

describe('pathToScanRoots', () => {
  it('derives scan roots from a PATH value, preserving order', () => {
    expect(pathToScanRoots('/usr/bin:/workspace/skills:/shared/bin')).toEqual([
      '/workspace/skills',
      '/shared/bin',
    ]);
  });

  it('drops the synthetic registry dirs, empties, duplicates, and relative entries', () => {
    expect(pathToScanRoots('/usr/bin:/bin::/a:/a:relative/dir:/b/')).toEqual(['/a', '/b']);
  });

  it('the default PATH round-trips to the default search roots', () => {
    expect(pathToScanRoots(DEFAULT_SHELL_PATH)).toEqual(DEFAULT_JSH_SEARCH_ROOTS);
  });

  it('returns no roots for undefined or empty PATH', () => {
    expect(pathToScanRoots(undefined)).toEqual([]);
    expect(pathToScanRoots('')).toEqual([]);
  });
});

describe('discoverJshCommands', () => {
  let vfs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    vfs = await VirtualFS.create({
      dbName: `test-jsh-discovery-${dbCounter++}`,
      wipe: true,
    });
  });

  it('returns empty map when no .jsh files exist', async () => {
    const result = await discoverJshCommands(vfs);
    expect(result.size).toBe(0);
  });

  it('discovers a single .jsh file under a default root', async () => {
    await vfs.writeFile('/workspace/skills/greet/greet.jsh', '#!/bin/bash\necho hello');
    const result = await discoverJshCommands(vfs);
    expect(result.get('greet')).toBe('/workspace/skills/greet/greet.jsh');
  });

  it('discovers across all default roots (skills, mcp aliases, bin dirs)', async () => {
    await vfs.writeFile('/workspace/skills/a/foo.jsh', 'echo foo');
    await vfs.writeFile('/workspace/.mcp/aliases/mcp-tool.jsh', 'echo mcp');
    await vfs.writeFile('/workspace/bin/adhoc.jsh', 'echo adhoc');
    await vfs.writeFile('/shared/bin/team.jsh', 'echo team');
    const result = await discoverJshCommands(vfs);
    expect(result.get('foo')).toBe('/workspace/skills/a/foo.jsh');
    expect(result.get('mcp-tool')).toBe('/workspace/.mcp/aliases/mcp-tool.jsh');
    expect(result.get('adhoc')).toBe('/workspace/bin/adhoc.jsh');
    expect(result.get('team')).toBe('/shared/bin/team.jsh');
    expect(result.size).toBe(4);
  });

  it('first occurrence wins for duplicate basenames within a root', async () => {
    await vfs.writeFile('/workspace/skills/a/deploy.jsh', 'echo a');
    await vfs.writeFile('/workspace/skills/b/deploy.jsh', 'echo b');
    const result = await discoverJshCommands(vfs);
    expect(result.has('deploy')).toBe(true);
    const path = result.get('deploy')!;
    expect(path).toMatch(/\/deploy\.jsh$/);
  });

  it('records a collision when two unattributed skills ship the same command', async () => {
    await vfs.writeFile('/workspace/skills/wiki/wiki.jsh', 'echo stale');
    await vfs.writeFile('/workspace/skills/llm-wiki/wiki.jsh', 'echo live');
    const index = await discoverJshCommandIndex(vfs);
    expect(index.commands.has('wiki')).toBe(true);
    expect(index.collisions).toHaveLength(1);
    const collision = index.collisions[0];
    expect(collision.name).toBe('wiki');
    expect(collision.reason).toBe('first-scan');
    expect([collision.winnerPath, ...collision.shadowedPaths].sort()).toEqual([
      '/workspace/skills/llm-wiki/wiki.jsh',
      '/workspace/skills/wiki/wiki.jsh',
    ]);
    expect(collision.shadowedPaths).not.toContain(collision.winnerPath);
  });

  it('prefers a .upskill provenance record over a bundled copy of the same command', async () => {
    const fs = mockDiscoveryFs({
      '/workspace/skills/wiki/wiki.jsh': 'echo stale',
      '/workspace/skills/llm-wiki/wiki.jsh': 'echo live',
      '/workspace/skills/llm-wiki/.upskill': upskillRecord('llm-wiki', '2026-09-01T00:00:00.000Z'),
    });
    const index = await discoverJshCommandIndex(fs);
    expect(index.commands.get('wiki')).toBe('/workspace/skills/llm-wiki/wiki.jsh');
    expect(index.collisions).toEqual([
      {
        name: 'wiki',
        winnerPath: '/workspace/skills/llm-wiki/wiki.jsh',
        shadowedPaths: ['/workspace/skills/wiki/wiki.jsh'],
        reason: 'upskill-provenance',
      },
    ]);
  });

  it('prefers the newer .upskill installed timestamp when both skills are provenanced', async () => {
    const fs = mockDiscoveryFs({
      '/workspace/skills/wiki/wiki.jsh': 'echo old',
      '/workspace/skills/wiki/.upskill': upskillRecord('wiki', '2026-01-01T00:00:00.000Z'),
      '/workspace/skills/llm-wiki/wiki.jsh': 'echo new',
      '/workspace/skills/llm-wiki/.upskill': upskillRecord('llm-wiki', '2026-09-01T00:00:00.000Z'),
    });
    const index = await discoverJshCommandIndex(fs);
    expect(index.commands.get('wiki')).toBe('/workspace/skills/llm-wiki/wiki.jsh');
    expect(index.collisions[0]?.reason).toBe('newer-upskill');
    expect(index.collisions[0]?.shadowedPaths).toEqual(['/workspace/skills/wiki/wiki.jsh']);
  });

  it('keeps the first scan hit when neither skill has provenance, and still reports the loser', async () => {
    const fs = mockDiscoveryFs({
      '/workspace/skills/wiki/wiki.jsh': 'echo first',
      '/workspace/skills/llm-wiki/wiki.jsh': 'echo second',
    });
    const index = await discoverJshCommandIndex(fs);
    expect(index.commands.get('wiki')).toBe('/workspace/skills/wiki/wiki.jsh');
    expect(index.collisions[0]).toEqual({
      name: 'wiki',
      winnerPath: '/workspace/skills/wiki/wiki.jsh',
      shadowedPaths: ['/workspace/skills/llm-wiki/wiki.jsh'],
      reason: 'first-scan',
    });
  });

  it('does not let a later PATH root steal a name already claimed by an earlier root', async () => {
    const fs = mockDiscoveryFs({
      '/workspace/skills/wiki/wiki.jsh': 'echo skills',
      '/workspace/bin/wiki.jsh': 'echo bin',
    });
    const index = await discoverJshCommandIndex(fs);
    expect(index.commands.get('wiki')).toBe('/workspace/skills/wiki/wiki.jsh');
    expect(index.collisions).toEqual([]);
  });

  it('formats collisions for skill list / which consumers', () => {
    const text = formatJshCommandCollisions([
      {
        name: 'wiki',
        winnerPath: '/workspace/skills/llm-wiki/wiki.jsh',
        shadowedPaths: ['/workspace/skills/wiki/wiki.jsh'],
        reason: 'upskill-provenance',
      },
    ]);
    expect(text).toContain('Command collisions:');
    expect(text).toContain('live     /workspace/skills/llm-wiki/wiki.jsh');
    expect(text).toContain('shadowed /workspace/skills/wiki/wiki.jsh');
    expect(text).toContain('.upskill provenance');
    const warned = withJshCommandCollisions('skill', 'listing\n', [
      {
        name: 'wiki',
        winnerPath: '/workspace/skills/llm-wiki/wiki.jsh',
        shadowedPaths: ['/workspace/skills/wiki/wiki.jsh'],
        reason: 'upskill-provenance',
      },
    ]);
    expect(warned.stderr).toBe('skill: 1 command name collision — see listing\n');
    expect(warned.stdout).toContain('listing');
    expect(warned.stdout).toContain('Command collisions:');
  });

  it('an earlier root wins a basename conflict (PATH precedence)', async () => {
    await vfs.writeFile('/workspace/skills/deploy/deploy.jsh', 'echo skills');
    await vfs.writeFile('/shared/bin/deploy.jsh', 'echo shared');
    const result = await discoverJshCommands(vfs);
    expect(result.get('deploy')).toBe('/workspace/skills/deploy/deploy.jsh');
  });

  // The #2085 behavior change: lookup is bounded to the PATH roots — a .jsh
  // parked anywhere else no longer auto-registers. `export PATH="$PATH:/tools"`
  // (interactively or in ~/.profile) is the explicit opt-in.
  it('does NOT discover .jsh files outside the search roots', async () => {
    await vfs.writeFile('/tools/lint.jsh', 'echo lint');
    const result = await discoverJshCommands(vfs);
    expect(result.has('lint')).toBe(false);
  });

  it('discovers outside-root .jsh files when their dir is passed as a root', async () => {
    await vfs.writeFile('/tools/lint.jsh', 'echo lint');
    const result = await discoverJshCommands(vfs, [...DEFAULT_JSH_SEARCH_ROOTS, '/tools']);
    expect(result.get('lint')).toBe('/tools/lint.jsh');
  });

  it('never registers commands from node_modules or dot-dirs below a root', async () => {
    await vfs.writeFile('/workspace/skills/x/node_modules/dep/evil.jsh', 'echo no');
    await vfs.writeFile('/workspace/skills/x/.cache/hidden.jsh', 'echo no');
    await vfs.writeFile('/workspace/skills/x/ok.jsh', 'echo yes');
    const result = await discoverJshCommands(vfs);
    expect(result.has('evil')).toBe(false);
    expect(result.has('hidden')).toBe(false);
    expect(result.get('ok')).toBe('/workspace/skills/x/ok.jsh');
  });

  it('a dot-path ROOT still registers its own commands (/.mcp/aliases)', async () => {
    await vfs.writeFile('/workspace/.mcp/aliases/tool.jsh', 'echo tool');
    const result = await discoverJshCommands(vfs, ['/workspace/.mcp/aliases']);
    expect(result.get('tool')).toBe('/workspace/.mcp/aliases/tool.jsh');
  });

  it('ignores non-.jsh files', async () => {
    await vfs.writeFile('/workspace/skills/a/readme.md', '# hello');
    await vfs.writeFile('/workspace/skills/a/run.sh', 'echo run');
    await vfs.writeFile('/workspace/skills/a/test.jsh', 'echo test');
    const result = await discoverJshCommands(vfs);
    expect(result.size).toBe(1);
    expect(result.has('test')).toBe(true);
  });

  it('handles deeply nested .jsh files under a root', async () => {
    await vfs.writeFile('/workspace/skills/deep/nested/path/cmd.jsh', 'echo deep');
    const result = await discoverJshCommands(vfs);
    expect(result.get('cmd')).toBe('/workspace/skills/deep/nested/path/cmd.jsh');
  });

  it('can be called multiple times (re-discovery)', async () => {
    await vfs.writeFile('/workspace/skills/a/foo.jsh', 'echo foo');
    const first = await discoverJshCommands(vfs);
    expect(first.size).toBe(1);

    await vfs.writeFile('/workspace/skills/b/bar.jsh', 'echo bar');
    const second = await discoverJshCommands(vfs);
    expect(second.size).toBe(2);
    expect(second.has('bar')).toBe(true);
  });
});

describe('discoverJshCommands with RestrictedFS', () => {
  let vfs: VirtualFS;
  let dbCounter = 100;

  beforeEach(async () => {
    vfs = await VirtualFS.create({
      dbName: `test-jsh-restricted-${dbCounter++}`,
      wipe: true,
    });
  });

  it('discovers .jsh in an explicitly-rooted /shared dir through RestrictedFS', async () => {
    await vfs.writeFile('/shared/bin/myscript.jsh', '#!/bin/bash\necho hello');
    const restricted = new RestrictedFS(vfs, ['/scoops/test-scoop/', '/shared/'], ['/workspace/']);
    const result = await discoverJshCommands(restricted);
    expect(result.get('myscript')).toBe('/shared/bin/myscript.jsh');
  });

  it('discovers .jsh in /workspace/skills/ through RestrictedFS (read-only access)', async () => {
    await vfs.writeFile('/workspace/skills/test-skill/test.jsh', 'echo skill-cmd');
    const restricted = new RestrictedFS(vfs, ['/scoops/test-scoop/', '/shared/'], ['/workspace/']);
    const result = await discoverJshCommands(restricted);
    expect(result.get('test')).toBe('/workspace/skills/test-skill/test.jsh');
  });

  it('discovers scoop-local commands via the scoop roots the shell pins in $PATH', async () => {
    await vfs.writeFile('/scoops/test-scoop/workspace/bin/local.jsh', 'echo local');
    const restricted = new RestrictedFS(vfs, ['/scoops/test-scoop/', '/shared/'], ['/workspace/']);
    const result = await discoverJshCommands(restricted, [
      '/scoops/test-scoop/workspace/skills',
      '/scoops/test-scoop/workspace/bin',
      ...DEFAULT_JSH_SEARCH_ROOTS,
    ]);
    expect(result.get('local')).toBe('/scoops/test-scoop/workspace/bin/local.jsh');
  });

  it('an ACL-inaccessible root is skipped silently, not an error', async () => {
    await vfs.writeFile('/scoops/other-scoop/workspace/bin/secret.jsh', 'echo secret');
    const restricted = new RestrictedFS(vfs, ['/scoops/test-scoop/', '/shared/'], ['/workspace/']);
    const result = await discoverJshCommands(restricted, [
      '/scoops/other-scoop/workspace/bin',
      ...DEFAULT_JSH_SEARCH_ROOTS,
    ]);
    expect(result.has('secret')).toBe(false);
  });

  it('/workspace/skills/ wins over /shared/bin for same basename', async () => {
    await vfs.writeFile('/workspace/skills/deploy/deploy.jsh', 'echo skills-version');
    await vfs.writeFile('/shared/bin/deploy.jsh', 'echo shared-version');
    const restricted = new RestrictedFS(vfs, ['/scoops/test-scoop/', '/shared/'], ['/workspace/']);
    const result = await discoverJshCommands(restricted);
    expect(result.get('deploy')).toBe('/workspace/skills/deploy/deploy.jsh');
  });

  it('compatibility skill scripts register only via an explicit root', async () => {
    // Pre-#2085 the full-VFS walk picked these up implicitly; now their dir
    // must be on the PATH (the skill-declared-roots future of the issue).
    await vfs.writeFile('/.agents/skills/secret-sauce/scripts/generate.jsh', 'echo generate');

    const implicit = await discoverJshCommands(vfs);
    expect(implicit.has('generate')).toBe(false);

    const explicit = await discoverJshCommands(vfs, ['/.agents/skills/secret-sauce/scripts']);
    expect(explicit.get('generate')).toBe('/.agents/skills/secret-sauce/scripts/generate.jsh');
  });
});
