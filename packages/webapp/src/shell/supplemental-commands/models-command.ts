import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

function helpText(): string {
  return `models - list available LLM models

Usage: models [options]

Options:
  --all              List models across all configured providers
  --provider <id>    List models for a specific provider
  --json             Output as JSON (for programmatic use)
  -h, --help         Show this help message
`;
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`.replace('.0M', 'M');
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
  return `${tokens}`;
}

function classifyTier(id: string, name: string): { label: string; emoji: string } {
  const lower = (id + ' ' + name).toLowerCase();

  // Frontier: opus, pro variants, o1-pro, o3-pro, grok-4 (non-fast)
  if (
    /\b(opus|o[13]-pro|o3-pro|gpt-5[.\d]*-pro|grok-4(?!.*fast))/.test(lower) &&
    !/mini|nano|lite|fast/.test(lower)
  ) {
    return { label: 'frontier', emoji: '🧠' };
  }
  // Fast: haiku, mini, nano, lite, flash-lite
  if (/\b(haiku|mini|nano|lite)\b/.test(lower)) {
    return { label: 'fast', emoji: '💨' };
  }
  // Balanced: everything else (sonnet, flash, gpt-5, standard models)
  return { label: 'balanced', emoji: '⚡' };
}

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
  tier: string;
  tierEmoji: string;
  selected: boolean;
}

function toModelInfo(
  m: any,
  providerId: string,
  selectedModelId: string,
  selectedProvider: string
): ModelInfo {
  const tier = classifyTier(m.id, m.name);
  return {
    id: m.id,
    name: m.name,
    provider: providerId,
    cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow ?? 0,
    maxTokens: m.maxTokens ?? 0,
    reasoning: !!m.reasoning,
    input: m.input ?? ['text'],
    tier: tier.label,
    tierEmoji: tier.emoji,
    selected: m.id === selectedModelId && providerId === selectedProvider,
  };
}

function formatHumanReadable(
  providerName: string,
  providerId: string,
  models: ModelInfo[]
): string {
  const lines: string[] = [];
  lines.push(`Models for "${providerName}" (${providerId}):\n`);

  for (const m of models) {
    const prefix = m.selected ? '  ► ' : '    ';
    const id = m.id.padEnd(30);
    const cost = `${formatCost(m.cost.input)} / ${formatCost(m.cost.output)}`;
    const ctx = `${formatContextWindow(m.contextWindow)} ctx`;
    const reasoning = m.reasoning ? 'reasoning ✓' : '           ';
    lines.push(
      `${prefix}${id} ${cost.padEnd(16)} ${ctx.padEnd(10)} ${reasoning}   ${m.tierEmoji} ${m.tier}`
    );
  }

  const selected = models.find((m) => m.selected);
  lines.push(
    `\n  ${models.length} model${models.length !== 1 ? 's' : ''} available.${selected ? ` Currently using: ${selected.id}` : ''}`
  );
  return lines.join('\n') + '\n';
}

export function createModelsCommand(): Command {
  return defineCommand('models', async (args) => {
    const {
      getAccounts,
      getAvailableProviders,
      getProviderConfig,
      getProviderModels,
      getSelectedProvider,
      getSelectedModelId,
    } = await import('../../ui/provider-settings.js');

    if (args.includes('--help') || args.includes('-h')) {
      return { stdout: helpText(), stderr: '', exitCode: 0 };
    }

    const jsonMode = args.includes('--json');
    const allMode = args.includes('--all');
    const providerIdx = args.indexOf('--provider');
    const explicitProvider = providerIdx >= 0 ? args[providerIdx + 1] : undefined;

    const selectedProvider = getSelectedProvider();
    const selectedModelId = getSelectedModelId();
    const accounts = getAccounts();

    if (accounts.length === 0) {
      const msg = 'No provider accounts configured. Run the provider settings to add one.\n';
      return { stdout: '', stderr: msg, exitCode: 1 };
    }

    // Determine which providers to list
    let providerIds: string[];
    if (explicitProvider) {
      const available = getAvailableProviders();
      if (!available.includes(explicitProvider)) {
        return {
          stdout: '',
          stderr: `Unknown provider: ${explicitProvider}. Available: ${available.join(', ')}\n`,
          exitCode: 1,
        };
      }
      providerIds = [explicitProvider];
    } else if (allMode) {
      providerIds = [...new Set(accounts.map((a: any) => a.providerId))];
    } else {
      providerIds = [selectedProvider];
    }

    const allModels: ModelInfo[] = [];
    const outputParts: string[] = [];

    for (const pid of providerIds) {
      const rawModels = getProviderModels(pid);
      if (rawModels.length === 0) {
        if (!allMode) {
          return { stdout: '', stderr: `No models available for provider ${pid}.\n`, exitCode: 1 };
        }
        continue;
      }
      const models = rawModels
        .map((m: any) => toModelInfo(m, pid, selectedModelId, selectedProvider))
        .sort((a: ModelInfo, b: ModelInfo) => b.cost.input - a.cost.input);

      allModels.push(...models);
      if (!jsonMode) {
        const config = getProviderConfig(pid);
        outputParts.push(formatHumanReadable(config.name, pid, models));
      }
    }

    if (jsonMode) {
      return { stdout: JSON.stringify(allModels, null, 2) + '\n', stderr: '', exitCode: 0 };
    }

    return { stdout: outputParts.join('\n'), stderr: '', exitCode: 0 };
  });
}
