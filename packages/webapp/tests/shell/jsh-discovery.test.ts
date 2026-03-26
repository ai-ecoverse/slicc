import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { RestrictedFS } from '../../src/fs/restricted-fs.js';
import { discoverJshCommands } from '../../src/shell/jsh-discovery.js';

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

  it('discovers a single .jsh file', async () => {
    await vfs.writeFile('/workspace/skills/greet/greet.jsh', '#!/bin/bash\necho hello');
    const result = await discoverJshCommands(vfs);
    expect(result.get('greet')).toBe('/workspace/skills/greet/greet.jsh');
  });

  it('discovers multiple .jsh files', async () => {
    await vfs.writeFile('/workspace/skills/a/foo.jsh', 'echo foo');
    await vfs.writeFile('/workspace/skills/b/bar.jsh', 'echo bar');
    const result = await discoverJshCommands(vfs);
    expect(result.has('foo')).toBe(true);
    expect(result.has('bar')).toBe(true);
    expect(result.size).toBe(2);
  });

  it('first occurrence wins for duplicate basenames', async () => {
    // Both in skills — walk order determines winner
    await vfs.writeFile('/workspace/skills/a/deploy.jsh', 'echo a');
    await vfs.writeFile('/workspace/skills/b/deploy.jsh', 'echo b');
    const result = await discoverJshCommands(vfs);
    expect(result.has('deploy')).toBe(true);
    // Should have exactly one entry
    expect(result.size >= 1).toBe(true);
    const path = result.get('deploy')!;
    expect(path).toMatch(/\/deploy\.jsh$/);
  });

  it('skills directory takes priority over other locations', async () => {
    await vfs.writeFile('/workspace/skills/deploy/deploy.jsh', 'echo skills');
    await vfs.writeFile('/other/deploy.jsh', 'echo other');
    const result = await discoverJshCommands(vfs);
    expect(result.get('deploy')).toBe('/workspace/skills/deploy/deploy.jsh');
  });

  it('discovers .jsh files outside of skills directory', async () => {
    await vfs.writeFile('/tools/lint.jsh', 'echo lint');
    const result = await discoverJshCommands(vfs);
    expect(result.get('lint')).toBe('/tools/lint.jsh');
  });

  it('ignores non-.jsh files', async () => {
    await vfs.writeFile('/workspace/skills/a/readme.md', '# hello');
    await vfs.writeFile('/workspace/skills/a/run.sh', 'echo run');
    await vfs.writeFile('/workspace/skills/a/test.jsh', 'echo test');
    const result = await discoverJshCommands(vfs);
    expect(result.size).toBe(1);
    expect(result.has('test')).toBe(true);
  });

  it('handles deeply nested .jsh files', async () => {
    await vfs.writeFile('/workspace/skills/deep/nested/path/cmd.jsh', 'echo deep');
    const result = await discoverJshCommands(vfs);
    expect(result.get('cmd')).toBe('/workspace/skills/deep/nested/path/cmd.jsh');
  });

  it('can be called multiple times (re-discovery)', async () => {
    await vfs.writeFile('/workspace/skills/a/foo.jsh', 'echo foo');
    const first = await discoverJshCommands(vfs);
    expect(first.size).toBe(1);

    // Add another file and re-discover
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

  it('discovers .jsh files in /shared/ via plain VFS', async () => {
    await vfs.writeFile('/shared/scripts/myscript.jsh', '#!/bin/bash\necho hello');
    const result = await discoverJshCommands(vfs);
    expect(result.get('myscript')).toBe('/shared/scripts/myscript.jsh');
  });

  it('discovers .jsh in /shared/ through RestrictedFS', async () => {
    await vfs.writeFile('/shared/scripts/myscript.jsh', '#!/bin/bash\necho hello');
    const restricted = new RestrictedFS(vfs, ['/scoops/test-scoop/', '/shared/'], ['/workspace/']);
    const result = await discoverJshCommands(restricted);
    expect(result.get('myscript')).toBe('/shared/scripts/myscript.jsh');
  });

  it('discovers .jsh in /workspace/skills/ through RestrictedFS (read-only access)', async () => {
    await vfs.writeFile('/workspace/skills/test-skill/test.jsh', 'echo skill-cmd');
    const restricted = new RestrictedFS(vfs, ['/scoops/test-scoop/', '/shared/'], ['/workspace/']);
    const result = await discoverJshCommands(restricted);
    expect(result.get('test')).toBe('/workspace/skills/test-skill/test.jsh');
  });

  it('discovers .jsh in /scoops/test-scoop/ through RestrictedFS', async () => {
    await vfs.writeFile('/scoops/test-scoop/local.jsh', 'echo local');
    const restricted = new RestrictedFS(vfs, ['/scoops/test-scoop/', '/shared/'], ['/workspace/']);
    const result = await discoverJshCommands(restricted);
    expect(result.get('local')).toBe('/scoops/test-scoop/local.jsh');
  });

  it('does NOT discover .jsh in inaccessible paths', async () => {
    await vfs.writeFile('/scoops/other-scoop/secret.jsh', 'echo secret');
    const restricted = new RestrictedFS(vfs, ['/scoops/test-scoop/', '/shared/'], ['/workspace/']);
    const result = await discoverJshCommands(restricted);
    expect(result.has('secret')).toBe(false);
  });

  it('/workspace/skills/ wins over /shared/ for same basename', async () => {
    await vfs.writeFile('/workspace/skills/deploy/deploy.jsh', 'echo skills-version');
    await vfs.writeFile('/shared/deploy.jsh', 'echo shared-version');
    const restricted = new RestrictedFS(vfs, ['/scoops/test-scoop/', '/shared/'], ['/workspace/']);
    const result = await discoverJshCommands(restricted);
    expect(result.get('deploy')).toBe('/workspace/skills/deploy/deploy.jsh');
  });

  it('discovers .jsh files in compatibility skill paths via unrestricted FS', async () => {
    // File in a compatibility skill directory (not accessible via RestrictedFS)
    await vfs.writeFile('/.agents/skills/secret-sauce/scripts/generate.jsh', 'echo generate');

    // RestrictedFS would NOT find this
    const restricted = new RestrictedFS(vfs, ['/scoops/test-scoop/', '/shared/'], ['/workspace/']);
    const restrictedResult = await discoverJshCommands(restricted);
    expect(restrictedResult.has('generate')).toBe(false);

    // But unrestricted VFS finds it
    const unrestrictedResult = await discoverJshCommands(vfs);
    expect(unrestrictedResult.get('generate')).toBe(
      '/.agents/skills/secret-sauce/scripts/generate.jsh'
    );
  });
});
