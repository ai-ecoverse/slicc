import { describe, expect, it, vi } from 'vitest';
import type { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createHelpCommand } from '../../src/ui/slash-commands/help.js';
import { buildSlashCommandRegistry } from '../../src/ui/slash-commands/index.js';
import { createMemoryCommand } from '../../src/ui/slash-commands/memory.js';
import { createSessionsCommand } from '../../src/ui/slash-commands/sessions.js';
import { createSettingsCommand } from '../../src/ui/slash-commands/settings.js';
import { createSkillReference } from '../../src/ui/slash-commands/skill-reference.js';
import { createSkillsMenuCommand } from '../../src/ui/slash-commands/skills-menu.js';
import type { SlashCommandActions, SlashCommandContext } from '../../src/ui/slash-commands.js';
import { createSlashCommandRegistry } from '../../src/ui/slash-commands.js';

function makeCtx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  const actions: SlashCommandActions = {
    newSession: vi.fn(async () => {}),
    freezeSession: vi.fn(async () => {}),
    clearChat: vi.fn(async () => {}),
    openSettings: vi.fn(async () => {}),
    openMemory: vi.fn(async () => {}),
    openFrozenSessions: vi.fn(async () => {}),
  };
  return {
    chat: { addSystemMessage: vi.fn() },
    actions,
    isCone: () => true,
    getRegistry: () => createSlashCommandRegistry([]),
    ...overrides,
  };
}

describe('/help', () => {
  it('lists action+submenu commands and summarises skill count, not individual skills', async () => {
    const ctx = makeCtx({
      getRegistry: () =>
        createSlashCommandRegistry([
          { kind: 'action', name: 'clear', description: 'Clear chat.', run: async () => {} },
          { kind: 'action', name: 'new', description: 'New session.', run: async () => {} },
          { kind: 'skill', name: 'sprinkles', description: 'Reference the sprinkles skill' },
        ]),
    });
    const cmd = createHelpCommand();
    await cmd.run!(ctx);
    const body = (ctx.chat.addSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(body).toContain('/clear');
    expect(body).toContain('/new');
    // Skill count line must appear
    expect(body).toContain('Plus 1 installed skill');
    expect(body).toContain('/skills');
    // Individual skill name must NOT appear as a command line
    expect(body).not.toContain('/sprinkles');
  });
});

describe('createSkillsMenuCommand', () => {
  it('has kind submenu, name skills, and no run', () => {
    const cmd = createSkillsMenuCommand();
    expect(cmd.kind).toBe('submenu');
    expect(cmd.name).toBe('skills');
    expect(cmd.run).toBeUndefined();
  });
});

describe('/settings', () => {
  it('calls actions.openSettings', async () => {
    const ctx = makeCtx();
    await createSettingsCommand().run!(ctx);
    expect(ctx.actions.openSettings).toHaveBeenCalled();
  });
});

describe('/memory', () => {
  it('calls actions.openMemory', async () => {
    const ctx = makeCtx();
    await createMemoryCommand().run!(ctx);
    expect(ctx.actions.openMemory).toHaveBeenCalled();
  });
});

describe('/sessions', () => {
  it('calls actions.openFrozenSessions', async () => {
    const ctx = makeCtx();
    await createSessionsCommand().run!(ctx);
    expect(ctx.actions.openFrozenSessions).toHaveBeenCalled();
  });
});

import { createClearCommand } from '../../src/ui/slash-commands/clear.js';
import { createFreezeCommand } from '../../src/ui/slash-commands/freeze.js';
import { createNewCommand } from '../../src/ui/slash-commands/new.js';

describe('/new', () => {
  it('calls actions.newSession', async () => {
    const ctx = makeCtx();
    await createNewCommand().run!(ctx);
    expect(ctx.actions.newSession).toHaveBeenCalled();
  });
});

describe('/freeze', () => {
  it('calls actions.freezeSession', async () => {
    const ctx = makeCtx();
    await createFreezeCommand().run!(ctx);
    expect(ctx.actions.freezeSession).toHaveBeenCalled();
  });
});

describe('/clear', () => {
  it('calls actions.clearChat when on the cone', async () => {
    const ctx = makeCtx({ isCone: () => true });
    await createClearCommand().run!(ctx);
    expect(ctx.actions.clearChat).toHaveBeenCalled();
  });
  it('emits an error system message when on a scoop (not the cone)', async () => {
    const ctx = makeCtx({ isCone: () => false });
    await createClearCommand().run!(ctx);
    expect(ctx.actions.clearChat).not.toHaveBeenCalled();
    expect(ctx.chat.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('cone'));
  });
});

describe('skill reference', () => {
  it('has kind skill and no run', () => {
    const cmd = createSkillReference('sprinkles');
    expect(cmd.kind).toBe('skill');
    expect(cmd.name).toBe('sprinkles');
    expect(cmd.run).toBeUndefined();
  });
});

describe('buildSlashCommandRegistry — includeSessions', () => {
  // Minimal VFS stub: no /workspace/skills dir, so listInstalledSkills() → [].
  const vfs = {
    readDir: async () => {
      throw new Error('no skills dir');
    },
  } as unknown as VirtualFS;

  it('includes /sessions by default and when includeSessions is true', async () => {
    const def = await buildSlashCommandRegistry({ vfs });
    expect(def.get('sessions')).toBeDefined();
    const on = await buildSlashCommandRegistry({ vfs, includeSessions: true });
    expect(on.get('sessions')).toBeDefined();
  });

  it('omits /sessions when includeSessions is false (extension float)', async () => {
    const reg = await buildSlashCommandRegistry({ vfs, includeSessions: false });
    expect(reg.get('sessions')).toBeUndefined();
    // Other action commands still present.
    expect(reg.get('settings')).toBeDefined();
    expect(reg.get('skills')).toBeDefined();
  });
});
