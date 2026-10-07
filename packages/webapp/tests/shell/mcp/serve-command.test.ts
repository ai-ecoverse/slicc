import { describe, expect, it } from 'vitest';
import { executeMcpServe, type McpServeCommandDeps } from '../../../src/shell/mcp/serve-command.js';
import type { McpPublication, PublishedCli } from '../../../src/shell/mcp/serve-store.js';

function cli(name: string, path = `/workspace/${name}.jsh`): PublishedCli {
  return { name, path, helpText: `usage: ${name}`, commands: [] };
}

function harness() {
  let stored: McpPublication | null = null;
  const calls = { publish: 0, generation: [] as number[], stop: 0 };
  const deps: McpServeCommandDeps = {
    discover: (path, explicitName) => {
      const base =
        path
          .split('/')
          .pop()
          ?.replace(/\.jsh$/i, '') ?? 'cli';
      return Promise.resolve(cli(explicitName ?? base, path));
    },
    load: () => Promise.resolve(stored),
    save: (publication) => {
      stored = publication;
      return Promise.resolve();
    },
    publish: (generation) => {
      calls.publish += 1;
      calls.generation.push(generation);
      return Promise.resolve({ url: 'https://7f3a9c.sliccy.now/mcp', token: 'token-1' });
    },
    setGeneration: (generation) => {
      calls.generation.push(generation);
      return Promise.resolve({ url: 'https://7f3a9c.sliccy.now/mcp', token: 'token-1' });
    },
    stopRemote: () => {
      calls.stop += 1;
      return Promise.resolve();
    },
  };
  return {
    deps,
    calls,
    stored: () => stored,
  };
}

describe('executeMcpServe', () => {
  it('prints one URL for several files and bumps once', async () => {
    const h = harness();
    const first = await executeMcpServe(
      ['--serve', '/workspace/jira.jsh', '--serve', '/workspace/gh.jsh'],
      h.deps
    );
    expect(first).toEqual({ stdout: 'https://7f3a9c.sliccy.now/mcp\n', stderr: '', exitCode: 0 });
    expect(h.calls.publish).toBe(1);
    expect(h.calls.generation).toEqual([1]);
    expect(h.stored()?.clis.map((item) => item.name)).toEqual(['jira', 'gh']);
  });

  it('treats the same path as a no-op and bumps once when the set grows', async () => {
    const h = harness();
    await executeMcpServe(['--serve', '/workspace/jira.jsh'], h.deps);
    const again = await executeMcpServe(['--serve', '/workspace/jira.jsh'], h.deps);
    expect(again.stdout).toBe('https://7f3a9c.sliccy.now/mcp\n');
    expect(h.calls.publish).toBe(1);
    expect(h.stored()?.grantGeneration).toBe(1);
    await executeMcpServe(
      ['--serve', '/workspace/slack.jsh', '--serve', '/workspace/gmail.jsh'],
      h.deps
    );
    expect(h.calls.generation).toEqual([1, 2]);
    expect(h.stored()?.grantGeneration).toBe(2);
    expect(h.stored()?.clis).toHaveLength(3);
  });

  it('refuses a duplicate prefix until one side is renamed', async () => {
    const h = harness();
    await executeMcpServe(['--serve', '/workspace/jira.jsh'], h.deps);
    const collided = await executeMcpServe(['--serve', '/elsewhere/jira.jsh'], h.deps);
    expect(collided.exitCode).toBe(1);
    expect(collided.stderr).toContain('name=path');
    expect(h.stored()?.grantGeneration).toBe(1);
    const renamed = await executeMcpServe(['--serve', 'other=/elsewhere/jira.jsh'], h.deps);
    expect(renamed.exitCode).toBe(0);
    expect(h.stored()?.clis.map((item) => item.name)).toEqual(['jira', 'other']);
  });

  it('stops one CLI without revoking and revokes when the set is empty', async () => {
    const h = harness();
    await executeMcpServe(
      ['--serve', '/workspace/jira.jsh', '--serve', '/workspace/gh.jsh'],
      h.deps
    );
    const listed = await executeMcpServe(['--serve', '--list'], h.deps);
    expect(listed.stdout).toContain('https://7f3a9c.sliccy.now/mcp');
    expect(listed.stdout).toContain('gh\t/workspace/gh.jsh');
    const one = await executeMcpServe(['--serve', '--stop', 'gh'], h.deps);
    expect(one.exitCode).toBe(0);
    expect(h.calls.stop).toBe(0);
    expect(h.stored()?.grantGeneration).toBe(1);
    expect(h.stored()?.clis.map((item) => item.name)).toEqual(['jira']);
    const all = await executeMcpServe(['--serve', '--stop'], h.deps);
    expect(all.stdout).toBe('stopped\n');
    expect(h.calls.stop).toBe(1);
    expect(h.stored()).toBeNull();
  });

  it('returns the publish error instead of throwing', async () => {
    const h = harness();
    h.deps.publish = () => Promise.reject(new Error('leader tray is not connected'));
    const result = await executeMcpServe(['--serve', '/workspace/jira.jsh'], h.deps);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('leader tray is not connected');
    expect(h.stored()).toBeNull();
  });
});
