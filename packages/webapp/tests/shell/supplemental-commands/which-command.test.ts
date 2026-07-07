import 'fake-indexeddb/auto';
import type { IFileSystem } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { ScriptCatalog } from '../../../src/shell/script-catalog.js';
import { createWhichCommand } from '../../../src/shell/supplemental-commands/which-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const createMockCtx = (
  overrides: { registeredCommands?: string[]; fs?: Partial<IFileSystem> } = {}
) =>
  mockCommandContext({
    fs: overrides.fs,
    overrides: {
      getRegisteredCommands: () => overrides.registeredCommands ?? ['ls', 'cat', 'node', 'git'],
    },
  });

/** Create a minimal VirtualFS mock that yields the given file paths from walk(). */
function createMockVfs(files: string[]): VirtualFS {
  return {
    exists: async () => true,
    walk: async function* () {
      for (const f of files) yield f;
    },
  } as unknown as VirtualFS;
}

describe('which command', () => {
  it('has correct name', () => {
    const cmd = createWhichCommand();
    expect(cmd.name).toBe('which');
  });

  it('shows help with --help', async () => {
    const cmd = createWhichCommand();
    const result = await cmd.execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('locate a command');
  });

  it('returns error for no arguments', async () => {
    const cmd = createWhichCommand();
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('missing argument');
  });

  it('resolves built-in command to /usr/bin/<name>', async () => {
    const cmd = createWhichCommand();
    const result = await cmd.execute(['node'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/usr/bin/node\n');
  });

  it('resolves multiple built-in commands', async () => {
    const cmd = createWhichCommand();
    const result = await cmd.execute(['ls', 'cat'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/usr/bin/ls\n/usr/bin/cat\n');
  });

  it('returns exit code 1 for unknown command', async () => {
    const cmd = createWhichCommand();
    const result = await cmd.execute(['nonexistent'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('returns exit code 1 if any command is not found (mixed)', async () => {
    const cmd = createWhichCommand();
    const result = await cmd.execute(['node', 'nonexistent'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('/usr/bin/node\n');
  });

  it('finds .jsh file on VFS', async () => {
    const mockVfs = createMockVfs([
      '/workspace/skills/test-skill/SKILL.md',
      '/workspace/skills/test-skill/hello.jsh',
    ]);

    const cmd = createWhichCommand(mockVfs);
    const result = await cmd.execute(
      ['hello'],
      createMockCtx({
        registeredCommands: ['ls', 'cat'],
      })
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/workspace/skills/test-skill/hello.jsh\n');
  });

  it('resolves a saved workflow to its path labeled (workflow)', async () => {
    const fs = await VirtualFS.create({
      dbName: `which-wf-${Math.random()}`,
      wipe: true,
    });
    await fs.mkdir('/workspace/.workflows', { recursive: true });
    await fs.writeFile('/workspace/.workflows/audit.workflow.js', 'return 1');
    const catalog = new ScriptCatalog({ jshFs: fs });
    const ctx: any = {
      cwd: '/workspace',
      env: new Map(),
      getRegisteredCommands: () => ['ls', 'cat', 'audit'], // audit is dynamically registered
    };
    const res = await createWhichCommand({
      fs,
      scriptCatalog: catalog,
      getStaticBuiltins: () => ['ls', 'cat'], // audit is NOT a static builtin
    }).execute(['audit'], ctx);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('/workspace/.workflows/audit.workflow.js');
    expect(res.stdout).toContain('(workflow)');
  });

  it('shows the .jsh path and marks the workflow shadowed when both exist', async () => {
    const fs = await VirtualFS.create({
      dbName: `which-wf2-${Math.random()}`,
      wipe: true,
    });
    await fs.mkdir('/workspace/.workflows', { recursive: true });
    await fs.writeFile('/workspace/.workflows/foo.workflow.js', 'return 1');
    await fs.writeFile('/workspace/foo.jsh', 'x');
    const catalog = new ScriptCatalog({ jshFs: fs });
    const ctx: any = {
      cwd: '/workspace',
      env: new Map(),
      getRegisteredCommands: () => ['ls', 'cat', 'foo'], // foo is dynamically registered
    };
    const res = await createWhichCommand({
      fs,
      scriptCatalog: catalog,
      getStaticBuiltins: () => ['ls', 'cat'], // foo is NOT a static builtin
    }).execute(['foo'], ctx);
    expect(res.stdout).toContain('/workspace/foo.jsh');
    expect(res.stdout).toMatch(/shadow/i);
  });

  it('a static built-in wins over a same-named saved workflow (shadowed by built-in)', async () => {
    const fs = await VirtualFS.create({
      dbName: `which-wf3-${Math.random()}`,
      wipe: true,
    });
    await fs.mkdir('/workspace/.workflows', { recursive: true });
    await fs.writeFile('/workspace/.workflows/test.workflow.js', 'return 1');
    const catalog = new ScriptCatalog({ jshFs: fs });
    const ctx: any = {
      cwd: '/workspace',
      env: new Map(),
      getRegisteredCommands: () => ['ls', 'cat', 'test'],
    };
    const res = await createWhichCommand({
      fs,
      scriptCatalog: catalog,
      getStaticBuiltins: () => ['ls', 'cat', 'test'], // 'test' IS a static built-in
    }).execute(['test'], ctx);
    expect(res.stdout).toContain('/usr/bin/test'); // built-in wins
    expect(res.stdout).toMatch(/shadowed by built-in/i);
  });
});
