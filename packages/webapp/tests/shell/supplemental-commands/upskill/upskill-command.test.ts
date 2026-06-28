import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../../../src/fs/index.js';
import {
  _resetGlobalFsCache,
  createSkillCommand,
  createUpskillCommand,
} from '../../../../src/shell/supplemental-commands/upskill/index.js';
import { createMockCtx } from './test-helpers.js';

let dbCounter = 0;

describe('skill/upskill command compatibility discovery', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-upskill-command-${dbCounter++}`,
      wipe: true,
    });
  });

  afterEach(() => {
    _resetGlobalFsCache();
  });

  it('skill help documents discoverable compatibility roots', async () => {
    const result = await createSkillCommand(fs).execute(['--help'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('List discoverable skills');
    expect(result.stdout).toContain('**/.agents/skills/*');
    expect(result.stdout).toContain('**/.claude/skills/*');
    // The `upskill search` line must list every registry the search actually
    // queries (Tessl + browse.sh), not just one of them — see PR #707 thread.
    expect(result.stdout).toMatch(/upskill search.*Tessl.*browse\.sh/);
    expect(result.stdout).toContain('browse:<host>/<task>');
  });

  it('skill list shows source and description for both native and compatibility skills', async () => {
    await fs.mkdir('/workspace/skills/native-skill', { recursive: true });
    await fs.writeFile(
      '/workspace/skills/native-skill/SKILL.md',
      '---\nname: native-skill\ndescription: Native skill\n---\n# Native\n'
    );

    await fs.mkdir('/repo/.claude/skills/compat-skill', { recursive: true });
    await fs.writeFile('/repo/.claude/skills/compat-skill/SKILL.md', '# Compat Skill');

    const result = await createSkillCommand(fs).execute(['list'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Discoverable skills:');
    expect(result.stdout).toContain('native-skill');
    expect(result.stdout).toContain('compat-skill');
    expect(result.stdout).toContain('native');
    expect(result.stdout).toContain('.claude');
  });

  it('skill info reports source for compatibility skills', async () => {
    await fs.mkdir('/repo/.agents/skills/agent-skill', { recursive: true });
    await fs.writeFile('/repo/.agents/skills/agent-skill/SKILL.md', '# Agent Skill');

    const result = await createSkillCommand(fs).execute(
      ['info', 'agent-skill'],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Skill: agent-skill');
    expect(result.stdout).toContain('Source: .agents');
    expect(result.stdout).toContain('Source root: /repo/.agents/skills');
    expect(result.stdout).toContain('Instructions: /repo/.agents/skills/agent-skill/SKILL.md');
  });

  it('skill install/uninstall subcommands no longer exist', async () => {
    const installResult = await createSkillCommand(fs).execute(
      ['install', 'anything'],
      createMockCtx() as never
    );
    expect(installResult.exitCode).toBe(1);
    expect(installResult.stderr).toContain('unknown command');

    const uninstallResult = await createSkillCommand(fs).execute(
      ['uninstall', 'anything'],
      createMockCtx() as never
    );
    expect(uninstallResult.exitCode).toBe(1);
    expect(uninstallResult.stderr).toContain('unknown command');
  });

  it('upskill list uses unified local discovery wording', async () => {
    await fs.mkdir('/repo/.agents/skills/local-agent-skill', { recursive: true });
    await fs.writeFile('/repo/.agents/skills/local-agent-skill/SKILL.md', '# Local Agent Skill');

    const result = await createUpskillCommand(fs, vi.fn() as never).execute(
      ['list'],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Discoverable local skills:');
    expect(result.stdout).toContain('local-agent-skill');
    expect(result.stdout).toContain('.agents');
  });

  it('skill list shows marketplace as source for marketplace skills', async () => {
    // Set up a marketplace plugin: a .claude-plugin/marketplace.json that points
    // to a local plugin directory containing a skills sub-tree.
    await fs.mkdir('/repo/.claude-plugin', { recursive: true });
    await fs.writeFile(
      '/repo/.claude-plugin/marketplace.json',
      JSON.stringify({ plugins: [{ source: './plugins/market-tools' }] })
    );
    await fs.mkdir('/repo/plugins/market-tools/skills/my-market-skill', { recursive: true });
    await fs.writeFile(
      '/repo/plugins/market-tools/skills/my-market-skill/SKILL.md',
      '---\nname: my-market-skill\ndescription: A marketplace skill\n---\n# My Market Skill\n'
    );

    const result = await createSkillCommand(fs).execute(['list'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('my-market-skill');
    expect(result.stdout).toContain('marketplace');
  });

  it('skill info shows Source: marketplace for marketplace skill', async () => {
    // Same marketplace layout: .claude-plugin/marketplace.json points to a local plugin dir.
    await fs.mkdir('/repo/.claude-plugin', { recursive: true });
    await fs.writeFile(
      '/repo/.claude-plugin/marketplace.json',
      JSON.stringify({ plugins: [{ source: './plugins/market-tools' }] })
    );
    await fs.mkdir('/repo/plugins/market-tools/skills/my-market-skill', { recursive: true });
    await fs.writeFile(
      '/repo/plugins/market-tools/skills/my-market-skill/SKILL.md',
      '---\nname: my-market-skill\ndescription: A marketplace skill\n---\n# My Market Skill\n'
    );

    const result = await createSkillCommand(fs).execute(
      ['info', 'my-market-skill'],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Skill: my-market-skill');
    expect(result.stdout).toContain('Source: marketplace');
  });
});
