import { describe, expect, it, vi } from 'vitest';
import { LickRegistry } from '../../src/scoops/lick-registry.js';
import type { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';

function navigateUpskill(body: Record<string, string>) {
  return {
    type: 'navigate' as const,
    timestamp: 't',
    body: { verb: 'upskill', ...body },
  };
}

function setup() {
  const executeCommand = vi.fn(async (_command: string) => ({
    stdout: 'Installed 1 skill(s)\n',
    stderr: '',
    exitCode: 0,
  }));
  const persistLickDecision = vi.fn(async () => undefined);
  const registry = new LickRegistry({
    getConeShell: () => ({ executeCommand }) as unknown as AlmostBashShellHeadless,
    getConeFs: () => null,
    persistLickDecision,
  });
  return { registry, executeCommand };
}

describe('navigate·upskill lick install', () => {
  it('composes a command with a skill selector so the confirm installs', async () => {
    const { registry, executeCommand } = setup();
    const id = registry.registerNavigate(
      navigateUpskill({ target: 'https://github.com/ai-ecoverse/skills', path: 'skills/firefly' })
    );
    await registry.resolve(id, { decision: 'allow' });
    expect(executeCommand).toHaveBeenCalledTimes(1);

    expect(executeCommand.mock.calls[0][0]).toBe(
      "upskill --path 'skills/firefly' 'https://github.com/ai-ecoverse/skills' --all"
    );
  });

  it('keeps the branch scope and single-quotes every Link-header value', async () => {
    const { registry, executeCommand } = setup();
    const id = registry.registerNavigate(
      navigateUpskill({ target: "evil'; rm -rf /", branch: 'main', path: "a'b" })
    );
    await registry.resolve(id, { decision: 'always' });
    expect(executeCommand.mock.calls[0][0]).toBe(
      "upskill --branch 'main' --path 'a'\\''b' 'evil'\\''; rm -rf /' --all"
    );
  });

  it('runs nothing on dismissal', async () => {
    const { registry, executeCommand } = setup();
    const id = registry.registerNavigate(
      navigateUpskill({ target: 'ai-ecoverse/skills', path: 'skills/firefly' })
    );
    await registry.resolve(id, { decision: 'deny' });
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
