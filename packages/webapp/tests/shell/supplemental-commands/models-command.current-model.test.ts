/**
 * The `models` command must report the model the agent ACTUALLY resolves and
 * streams with (`resolveCurrentModel()`), not the raw selected id — and must
 * never hide the active model behind version-family dedup. Regression for the
 * cloud-cone confusion where `models` echoed the selected `opus-4-8` (or hid it)
 * while the cone could be running something else.
 */
import type { IFileSystem } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/ui/provider-settings.js', () => ({
  getAccounts: vi.fn(),
  getAvailableProviders: vi.fn(),
  getProviderConfig: vi.fn(),
  getProviderModels: vi.fn(),
  getSelectedProvider: vi.fn(),
  getSelectedModelId: vi.fn(),
  resolveCurrentModel: vi.fn(),
}));

import { createModelsCommand } from '../../../src/shell/supplemental-commands/models-command.js';
import {
  getAccounts,
  getAvailableProviders,
  getProviderConfig,
  getProviderModels,
  getSelectedModelId,
  getSelectedProvider,
  resolveCurrentModel,
} from '../../../src/ui/provider-settings.js';

const mk = (id: string, costIn: number, costOut: number, ctx = 1_000_000, provider = 'adobe') => ({
  id,
  name: id,
  provider,
  cost: { input: costIn, output: costOut, cacheRead: 0, cacheWrite: 0 },
  contextWindow: ctx,
  maxTokens: 128000,
  reasoning: true,
  input: ['text', 'image'],
});

function ctx() {
  const fs: Partial<IFileSystem> = {
    resolvePath: (b: string, p: string) => (p.startsWith('/') ? p : `${b}/${p}`),
  };
  return { fs: fs as IFileSystem, cwd: '/home', env: new Map<string, string>(), stdin: '' };
}

describe('models command reports the resolved model (no guessing)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAccounts).mockReturnValue([{ providerId: 'adobe' }] as never);
    vi.mocked(getAvailableProviders).mockReturnValue(['adobe'] as never);
    vi.mocked(getProviderConfig).mockReturnValue({ id: 'adobe', name: 'Adobe' } as never);
    vi.mocked(getSelectedProvider).mockReturnValue('adobe');
    vi.mocked(getSelectedModelId).mockReturnValue('claude-opus-4-8');
  });

  it('shows the RESOLVED model when it differs from the selection (fallback exposed)', async () => {
    // Cold/fallback: selection is opus-4-8 but resolution fell to native Anthropic.
    vi.mocked(getProviderModels).mockReturnValue([
      mk('claude-opus-4-6', 5, 25),
      mk('claude-sonnet-4-6', 3, 15),
      mk('claude-haiku-4-5', 1, 5, 200_000),
    ] as never);
    vi.mocked(resolveCurrentModel).mockReturnValue({
      id: 'claude-sonnet-4-0',
      provider: 'anthropic',
    } as never);

    const res = await createModelsCommand().execute(['--no-benchmarks'], ctx() as never);
    expect(res.exitCode).toBe(0);
    // Reports the model the agent actually resolved...
    expect(res.stdout).toContain('claude-sonnet-4-0');
    // ...and flags that it diverged from the selected opus-4-8.
    expect(res.stdout).toContain('claude-opus-4-8');
    // Must NOT claim opus-4-8 is the active/current model.
    expect(res.stdout).not.toMatch(/Currently using:\s*adobe:claude-opus-4-8/);
  });

  it('never hides the active model behind version-family dedup', async () => {
    // opus-4-6 ($5) and opus-4-8 ($0, no pi-ai price) are the same family; cost-desc
    // sort puts 4-6 first, so the old dedup dropped the active 4-8.
    vi.mocked(getProviderModels).mockReturnValue([
      mk('claude-opus-4-6', 5, 25),
      mk('claude-opus-4-8', 0, 0),
    ] as never);
    vi.mocked(resolveCurrentModel).mockReturnValue({
      id: 'claude-opus-4-8',
      provider: 'adobe',
    } as never);

    // Default mode (dedup ON, no --all-versions).
    const res = await createModelsCommand().execute(['--no-benchmarks'], ctx() as never);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('claude-opus-4-8');
    expect(res.stdout).toMatch(/Currently using:\s*adobe:claude-opus-4-8/);
  });

  it('--json marks the RESOLVED model as selected, not the raw selection', async () => {
    // JSON consumers (`.find(m => m.selected)`) must get the resolved model.
    vi.mocked(getProviderModels).mockReturnValue([
      mk('claude-opus-4-6', 5, 25),
      mk('claude-opus-4-8', 0, 0),
    ] as never);
    vi.mocked(getSelectedModelId).mockReturnValue('claude-opus-4-6'); // selected = 4-6
    vi.mocked(resolveCurrentModel).mockReturnValue({
      id: 'claude-opus-4-8', // resolved = 4-8 (diverges)
      provider: 'adobe',
    } as never);

    const res = await createModelsCommand().execute(
      ['--json', '--all-versions', '--no-benchmarks'],
      ctx() as never
    );
    expect(res.exitCode).toBe(0);
    const models = JSON.parse(res.stdout) as Array<{ id: string; selected: boolean }>;
    const selected = models.filter((m) => m.selected);
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe('claude-opus-4-8');
  });

  it('--all reports the resolved model in a single global "Currently using" line', async () => {
    vi.mocked(getAccounts).mockReturnValue([
      { providerId: 'adobe' },
      { providerId: 'anthropic' },
    ] as never);
    vi.mocked(getProviderConfig).mockImplementation(((id: string) => ({
      id,
      name: id === 'adobe' ? 'Adobe' : 'Anthropic',
    })) as never);
    vi.mocked(getProviderModels).mockImplementation(((id: string) =>
      id === 'adobe'
        ? [mk('claude-opus-4-8', 0, 0)]
        : [mk('claude-sonnet-4-0', 3, 15, 200_000, 'anthropic')]) as never);
    vi.mocked(getSelectedModelId).mockReturnValue('claude-opus-4-8');
    vi.mocked(resolveCurrentModel).mockReturnValue({
      id: 'claude-opus-4-8',
      provider: 'adobe',
    } as never);

    const res = await createModelsCommand().execute(['--all', '--no-benchmarks'], ctx() as never);
    expect(res.exitCode).toBe(0);
    const usingLines = res.stdout.split('\n').filter((l) => l.includes('Currently using:'));
    expect(usingLines).toHaveLength(1);
    expect(usingLines[0]).toContain('adobe:claude-opus-4-8');
  });
});
