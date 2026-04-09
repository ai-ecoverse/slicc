import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

function helpText(): string {
  return `models - list available LLM models

Usage: models [options]

Options:
  --all              List models across all configured providers
  --all-versions     Show all model versions (default: latest only)
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

/** Heuristic: exclude models that are clearly not chat/agent models. */
const NON_AGENT_PATTERN =
  /\b(embedding|embed|tts|whisper|dall-e|image-gen|audio|vision-preview)\b/i;

function isAgentModel(m: { id: string; name?: string }): boolean {
  const text = `${m.id} ${m.name ?? ''}`;
  return !NON_AGENT_PATTERN.test(text);
}

/**
 * Extract a "family" string from a model ID so we can group versions together.
 * Strategy:
 *  1. Remove date suffixes like -20251101, -2507, -0905
 *  2. Remove -preview, -latest
 *  3. Collapse version numbers to get a base family name
 */
function extractFamily(id: string): string {
  let f = id.toLowerCase();
  // Strip date suffixes (YYYYMMDD, YYMM, MMDD patterns at end)
  f = f.replace(/-\d{8}$/, '');
  f = f.replace(/-\d{4}$/, '');
  // Strip -preview, -latest
  f = f.replace(/-(preview|latest)$/, '');

  // Claude: claude-{tier}-{major}-{minor}... → claude-{tier}
  const claudeMatch = f.match(/^(claude-(?:opus|sonnet|haiku))/);
  if (claudeMatch) return claudeMatch[1];

  // GPT: gpt-{major}.{minor} or gpt-{major} → keep gpt-{major} plus any suffix like -mini
  const gptMatch = f.match(/^(gpt-\d+)(?:\.\d+)?(-[a-z][-a-z]*)?$/);
  if (gptMatch) return gptMatch[1] + (gptMatch[2] ?? '');

  // Gemini: gemini-{major}.{minor}-{variant} → gemini-{variant}
  const geminiMatch = f.match(/^gemini-[\d.]+-(.+)$/);
  if (geminiMatch) return `gemini-${geminiMatch[1]}`;
  const geminiMatch2 = f.match(/^gemini-(\d+)-(.+)$/);
  if (geminiMatch2) return `gemini-${geminiMatch2[2]}`;

  // Grok: grok-{major}(.{minor})?-{variant} → grok-{variant}
  const grokMatch = f.match(/^grok-[\d.]+-([\w-]+)$/);
  if (grokMatch) return `grok-${grokMatch[1]}`;
  // Plain grok-{version}
  const grokPlain = f.match(/^(grok)-[\d.]+$/);
  if (grokPlain) return 'grok';

  // o-series: o1, o3, o4-mini etc — strip version-like trailing numbers
  const oMatch = f.match(/^(o\d+(?:-[a-z]+)?)(?:-\d.*)?$/);
  if (oMatch) return oMatch[1];

  // Fallback: strip trailing version-like segments (digits, dots, dashes at end)
  return f.replace(/-[\d.]+$/, '');
}

function deduplicateByFamily(models: ModelInfo[]): ModelInfo[] {
  const familyMap = new Map<string, ModelInfo>();
  for (const m of models) {
    const family = extractFamily(m.id);
    // Keep the first occurrence per family (models are already sorted by cost desc,
    // so the first is typically the latest/most capable version)
    if (!familyMap.has(family)) {
      familyMap.set(family, m);
    }
  }
  return [...familyMap.values()];
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
    const allVersions = args.includes('--all-versions');
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
      const rawModels = getProviderModels(pid).filter(isAgentModel);
      if (rawModels.length === 0) {
        if (!allMode) {
          return { stdout: '', stderr: `No models available for provider ${pid}.\n`, exitCode: 1 };
        }
        continue;
      }
      let models = rawModels
        .map((m: any) => toModelInfo(m, pid, selectedModelId, selectedProvider))
        .sort((a: ModelInfo, b: ModelInfo) => b.cost.input - a.cost.input);

      if (!allVersions) {
        models = deduplicateByFamily(models);
      }

      allModels.push(...models);
      if (!jsonMode) {
        const config = getProviderConfig(pid);
        outputParts.push(formatHumanReadable(config.name, pid, models));
      }
    }

    if (jsonMode) {
      return { stdout: JSON.stringify(allModels, null, 2) + '\n', stderr: '', exitCode: 0 };
    }

    if (!allVersions && !jsonMode) {
      outputParts.push('Showing latest versions only. Use --all-versions to see all.\n');
    }

    return { stdout: outputParts.join('\n'), stderr: '', exitCode: 0 };
  });
}
