import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import { createProxiedFetch } from '../proxied-fetch.js';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest } from './subcommand-help.js';

/** Account/model accessors — providers/ sits outside the ranked stack (not ui/). */
type AccountStore = typeof import('../../providers/account-store.js');

const AA_CACHE_PATH = '/.cache/artificial-analysis.json';
const AA_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const AA_API_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models';

/** Boolean flags accepted by `models` (any position). */
const MODELS_BOOL_FLAGS = [
  '--all',
  '--all-versions',
  '--json',
  '--refresh',
  '--no-benchmarks',
  '--help',
  '-h',
] as const;

/** Value-taking flags — keep in sync with `isHelpRequest({ valueFlags })`. */
const MODELS_VALUE_FLAGS = ['--provider'] as const;

interface AAModelData {
  slug: string;
  name: string;
  creator_slug: string;
  intelligence_index: number | null;
  coding_index: number | null;
  speed_tps: number | null;
}

interface AACacheData {
  fetchedAt: number;
  models: AAModelData[];
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
  selected: boolean;
  intelligence?: number;
  codingScore?: number;
  speed?: number;
}

interface ModelsOptions {
  jsonMode: boolean;
  allMode: boolean;
  allVersions: boolean;
  forceRefresh: boolean;
  noBenchmarks: boolean;
  explicitProvider: string | undefined;
}

type CommandResult = { stdout: string; stderr: string; exitCode: number };

function fail(message: string): CommandResult {
  return { stdout: '', stderr: message.endsWith('\n') ? message : `${message}\n`, exitCode: 1 };
}

async function readAACache(vfs: VirtualFS): Promise<AAModelData[] | null> {
  try {
    const raw = (await vfs.readFile(AA_CACHE_PATH)) as string;
    const cached: AACacheData = JSON.parse(raw);
    if (Date.now() - cached.fetchedAt < AA_CACHE_TTL_MS) return cached.models;
  } catch {
    // Cache miss or invalid — fetch fresh
  }
  return null;
}

function aaApiKey(): string | null {
  try {
    return localStorage.getItem('aa_api_key');
  } catch {
    return null;
  }
}

function mapAAItems(items: unknown[]): AAModelData[] {
  return items.map((raw) => {
    const m = raw as {
      slug?: string;
      name?: string;
      model_creator?: { slug?: string };
      evaluations?: {
        artificial_analysis_intelligence_index?: number | null;
        artificial_analysis_coding_index?: number | null;
      };
      median_output_tokens_per_second?: number | null;
    };
    return {
      slug: m.slug ?? '',
      name: m.name ?? '',
      creator_slug: m.model_creator?.slug ?? '',
      intelligence_index: m.evaluations?.artificial_analysis_intelligence_index ?? null,
      coding_index: m.evaluations?.artificial_analysis_coding_index ?? null,
      speed_tps: m.median_output_tokens_per_second ?? null,
    };
  });
}

async function writeAACache(vfs: VirtualFS, models: AAModelData[]): Promise<void> {
  const cacheData: AACacheData = { fetchedAt: Date.now(), models };
  try {
    await vfs.mkdir('/.cache', { recursive: true });
    await vfs.writeFile(AA_CACHE_PATH, JSON.stringify(cacheData));
  } catch {
    // Cache write failure is non-fatal
  }
}

async function fetchAAData(vfs?: VirtualFS, forceRefresh = false): Promise<AAModelData[]> {
  if (vfs && !forceRefresh) {
    const cached = await readAACache(vfs);
    if (cached) return cached;
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  const apiKey = aaApiKey();
  if (apiKey) headers['x-api-key'] = apiKey;

  const proxiedFetch = createProxiedFetch();
  let result;
  try {
    result = await proxiedFetch(AA_API_URL, { method: 'GET', headers });
  } catch {
    return [];
  }

  if (result.status === 401 || result.status < 200 || result.status >= 300) return [];

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(result.body));
  } catch {
    return [];
  }

  if (body == null || typeof body !== 'object') return [];
  const record = body as { data?: unknown[]; models?: unknown[] } | unknown[];
  const items: unknown[] = Array.isArray(record) ? record : (record.data ?? record.models ?? []);
  const models = mapAAItems(items);

  if (vfs && models.length > 0) await writeAACache(vfs, models);
  return models;
}

function normalizeForMatch(id: string): string {
  return id
    .toLowerCase()
    .replace(/\./g, '-')
    .replace(/-\d{8}$/, '')
    .replace(/-\d{4}$/, '');
}

function matchAAModel(piModelId: string, aaModels: AAModelData[]): AAModelData | undefined {
  const lower = piModelId.toLowerCase();

  const exact = aaModels.find((m) => m.slug === lower);
  if (exact) return exact;

  const norm = normalizeForMatch(piModelId);
  const normMatch = aaModels.find((m) => normalizeForMatch(m.slug) === norm);
  if (normMatch) return normMatch;

  const substringMatches = aaModels.filter((m) => lower.includes(m.slug) || m.slug.includes(lower));
  if (substringMatches.length === 0) return undefined;
  substringMatches.sort((a, b) => b.slug.length - a.slug.length);
  return substringMatches[0];
}

function helpText(): string {
  return `models - list available LLM models

Usage: models [options]

Options:
  --all              List models across all configured providers
  --all-versions     Show all model versions (default: latest only)
  --provider <id>    List models for a specific provider
  --json             Output as JSON (for programmatic use)
  --refresh          Force re-fetch benchmark data from Artificial Analysis
  --no-benchmarks    Skip benchmark data enrichment (faster, works offline)
  -h, --help         Show this help message
`;
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`.replace('.0M', 'M');
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
  return `${tokens}`;
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
function familyFromKnownVendor(f: string): string | undefined {
  const claudeMatch = f.match(/^(claude-(?:opus|sonnet|haiku))/);
  if (claudeMatch) return claudeMatch[1];

  const gptMatch = f.match(/^(gpt-\d+)(?:\.\d+)?(-[a-z][-a-z]*)?$/);
  if (gptMatch) return gptMatch[1] + (gptMatch[2] ?? '');

  const geminiMatch = f.match(/^gemini-[\d.]+-(.+)$/);
  if (geminiMatch) return `gemini-${geminiMatch[1]}`;
  const geminiMatch2 = f.match(/^gemini-(\d+)-(.+)$/);
  if (geminiMatch2) return `gemini-${geminiMatch2[2]}`;

  const grokMatch = f.match(/^grok-[\d.]+-([\w-]+)$/);
  if (grokMatch) return `grok-${grokMatch[1]}`;
  const grokPlain = f.match(/^(grok)-[\d.]+$/);
  if (grokPlain) return 'grok';

  const oMatch = f.match(/^(o\d+(?:-[a-z]+)?)(?:-\d.*)?$/);
  if (oMatch) return oMatch[1];

  return undefined;
}

function extractFamily(id: string): string {
  let f = id.toLowerCase();
  f = f.replace(/-\d{8}$/, '');
  f = f.replace(/-\d{4}$/, '');
  f = f.replace(/-(preview|latest)$/, '');

  return familyFromKnownVendor(f) ?? f.replace(/-[\d.]+$/, '');
}

function deduplicateByFamily(models: ModelInfo[]): ModelInfo[] {
  const familyMap = new Map<string, ModelInfo>();
  for (const m of models) {
    const family = extractFamily(m.id);
    // Keep the first occurrence per family (models are already sorted by cost desc,
    // so the first is typically the latest/most capable version) — BUT never
    // collapse away the active model. A newer model with placeholder $0 pricing
    // (e.g. an Adobe opus-4-8 not yet in pi-ai's cost registry) sorts last and
    // would otherwise be hidden behind the older same-family entry.
    if (!familyMap.has(family) || m.selected) {
      familyMap.set(family, m);
    }
  }
  return [...familyMap.values()];
}

function toModelInfo(
  m: {
    id: string;
    name: string;
    cost?: ModelInfo['cost'];
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    input?: string[];
  },
  providerId: string,
  activeModelId: string,
  activeProvider: string,
  aaModels?: AAModelData[]
): ModelInfo {
  const aaMatch = aaModels ? matchAAModel(m.id, aaModels) : undefined;
  const info: ModelInfo = {
    id: m.id,
    name: m.name,
    provider: providerId,
    cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow ?? 0,
    maxTokens: m.maxTokens ?? 0,
    reasoning: !!m.reasoning,
    input: m.input ?? ['text'],
    // "selected" marks the model the agent ACTUALLY resolves to (from
    // resolveCurrentModel), not the raw selected id — so a fallback shows the
    // real model, not a guess.
    selected: m.id === activeModelId && providerId === activeProvider,
  };
  if (aaMatch?.intelligence_index != null) info.intelligence = aaMatch.intelligence_index;
  if (aaMatch?.coding_index != null) info.codingScore = aaMatch.coding_index;
  if (aaMatch?.speed_tps != null) info.speed = aaMatch.speed_tps;
  return info;
}

function formatHumanReadable(
  providerName: string,
  providerId: string,
  models: ModelInfo[],
  hasAAData: boolean
): string {
  const lines: string[] = [];
  lines.push(`Models for "${providerName}" (${providerId}):\n`);

  for (const m of models) {
    const prefix = m.selected ? '  ► ' : '    ';
    const id = m.id.padEnd(30);
    const cost = `${formatCost(m.cost.input)} / ${formatCost(m.cost.output)}`;
    const ctx = `${formatContextWindow(m.contextWindow)} ctx`;
    const iq = m.intelligence != null ? `IQ:${m.intelligence}` : '';
    const spd = m.speed != null ? `${Math.round(m.speed)} t/s` : '';
    const reasoning = m.reasoning ? 'reasoning' : '';
    const benchPart = iq || spd ? `${iq.padEnd(6)} ${spd.padEnd(8)}` : '';
    lines.push(`${prefix}${id} ${cost.padEnd(16)} ${ctx.padEnd(10)} ${benchPart} ${reasoning}`);
  }

  lines.push(`\n  ${models.length} model${models.length !== 1 ? 's' : ''} available.`);
  if (hasAAData) {
    lines.push('  Intelligence data: artificialanalysis.ai');
  }
  return lines.join('\n') + '\n';
}

function parseModelsOptions(args: readonly string[]): ModelsOptions | { error: string } {
  const parsed = parseKnownFlags(args, {
    bool: MODELS_BOOL_FLAGS,
    value: MODELS_VALUE_FLAGS,
  });
  if ('error' in parsed) return parsed;
  return {
    jsonMode: parsed.bools.has('--json'),
    allMode: parsed.bools.has('--all'),
    allVersions: parsed.bools.has('--all-versions'),
    forceRefresh: parsed.bools.has('--refresh'),
    noBenchmarks: parsed.bools.has('--no-benchmarks'),
    explicitProvider: parsed.values.get('--provider'),
  };
}

function resolveProviderIds(
  store: AccountStore,
  opts: ModelsOptions,
  selectedProvider: string
): string[] | { error: string } {
  if (opts.explicitProvider) {
    const available = store.getAvailableProviders();
    if (!available.includes(opts.explicitProvider)) {
      return {
        error: `Unknown provider: ${opts.explicitProvider}. Available: ${available.join(', ')}\n`,
      };
    }
    return [opts.explicitProvider];
  }
  if (opts.allMode) {
    return [...new Set(store.getAccounts().map((a) => a.providerId))];
  }
  return [selectedProvider];
}

function modelsForProvider(
  store: AccountStore,
  pid: string,
  activeId: string,
  activeProvider: string,
  aaModels: AAModelData[] | undefined,
  allVersions: boolean
): ModelInfo[] {
  const rawModels = store.getProviderModels(pid).filter(isAgentModel);
  if (rawModels.length === 0) return [];
  let models = rawModels
    .map((m) => toModelInfo(m, pid, activeId, activeProvider, aaModels))
    .sort((a, b) => b.cost.input - a.cost.input);
  if (!allVersions) models = deduplicateByFamily(models);
  return models;
}

function currentlyUsingLine(
  activeProvider: string,
  activeId: string,
  selectedProvider: string,
  selectedModelId: string
): string {
  const activeRef = `${activeProvider}:${activeId}`;
  const selectedRef = `${selectedProvider}:${selectedModelId}`;
  return activeRef === selectedRef
    ? `Currently using: ${activeRef}\n`
    : `Currently using: ${activeRef}  (selected ${selectedRef} — resolved to a different model)\n`;
}

async function runModels(args: readonly string[], vfs?: VirtualFS): Promise<CommandResult> {
  if (isHelpRequest(args, { valueFlags: MODELS_VALUE_FLAGS })) {
    return { stdout: helpText(), stderr: '', exitCode: 0 };
  }

  const opts = parseModelsOptions(args);
  if ('error' in opts) return fail(`models: ${opts.error}`);

  // providers/ is outside the ranked layer stack — not a shell→ui back-edge.
  const store = await import('../../providers/account-store.js');

  if (store.getAccounts().length === 0) {
    return fail('No provider accounts configured. Run the provider settings to add one.\n');
  }

  // The model the agent ACTUALLY resolves and streams with — not the raw
  // selected id. resolveCurrentModel() falls back deterministically (and runs
  // identically in every float: standalone worker, panel terminal, and the
  // extension offscreen/panel shells — it only reads localStorage + the pi-ai
  // registry), so this reflects reality even when the selection can't be
  // honored (cold model list, id unknown to pi-ai). The ► marker, JSON
  // `selected` flag, and the "Currently using" line below all key off this.
  const activeModel = store.resolveCurrentModel();
  const activeId = activeModel.id;
  const activeProvider = activeModel.provider;
  const selectedProvider = store.getSelectedProvider();
  const selectedModelId = store.getSelectedModelId();

  let aaModels: AAModelData[] | undefined;
  if (!opts.noBenchmarks) {
    const fetched = await fetchAAData(vfs, opts.forceRefresh);
    if (fetched.length > 0) aaModels = fetched;
  }

  const providerIds = resolveProviderIds(store, opts, selectedProvider);
  if ('error' in providerIds) return fail(providerIds.error);

  const allModels: ModelInfo[] = [];
  const outputParts: string[] = [];

  for (const pid of providerIds) {
    const models = modelsForProvider(
      store,
      pid,
      activeId,
      activeProvider,
      aaModels,
      opts.allVersions
    );
    if (models.length === 0) {
      if (!opts.allMode) return fail(`No models available for provider ${pid}.\n`);
      continue;
    }
    allModels.push(...models);
    if (!opts.jsonMode) {
      const config = store.getProviderConfig(pid);
      outputParts.push(formatHumanReadable(config.name, pid, models, !!aaModels));
    }
  }

  if (opts.jsonMode) {
    return { stdout: JSON.stringify(allModels, null, 2) + '\n', stderr: '', exitCode: 0 };
  }

  if (!opts.allVersions) {
    outputParts.push('Showing latest versions only. Use --all-versions to see all.\n');
  }

  outputParts.push(currentlyUsingLine(activeProvider, activeId, selectedProvider, selectedModelId));
  return { stdout: outputParts.join('\n'), stderr: '', exitCode: 0 };
}

export function createModelsCommand(vfs?: VirtualFS): Command {
  return defineCommand('models', async (args) => runModels(args, vfs));
}
