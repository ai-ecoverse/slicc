/**
 * Provider env seeding for realm scripts (`.jsh`, `node -e`, `ipx`).
 *
 * When the user has configured an API-key account for the provider that is
 * currently steering the cone, realm scripts get that key under the same
 * environment variable name the upstream SDK / pi-ai would read it from
 * (`AI_GATEWAY_API_KEY` for `vercel-ai-gateway`, `OPENAI_API_KEY` for
 * `openai`, …). A skill that embeds a third-party agent runtime (e.g. the `fx`
 * skill in ai-ecoverse/skills, which hosts Vercel's fx on fx-core.wasm)
 * therefore needs zero credential plumbing: it reads `process.env.<NAME>`
 * exactly as it would under Node.
 *
 * Scope is deliberately narrow:
 *   - cone/system-owned realms only — `executeJsCode` skips the seed for
 *     `owner.kind === 'scoop'`, so a sandboxed scoop cannot read the key;
 *   - only the SELECTED provider, never every configured account;
 *   - only plain API keys (`account.apiKey`) — OAuth access tokens keep going
 *     through `oauth-token <provider>`, which owns their refresh semantics;
 *   - explicit shell env always wins (`AI_GATEWAY_API_KEY=x fx …` overrides).
 *
 * The seeder is registered by the kernel host at boot (next to
 * `__slicc_pm`) and resolved by `executeJsCode`; floats without a host
 * (vitest, standalone tools) have no seeder and see an empty seed.
 */

import type { Account } from '../providers/account-store.js';

/**
 * Provider id → env var pi-ai's `getApiKeyEnvVars()` reads for that
 * provider. pi-ai does not export the table (its `findEnvKeys()` only reports
 * variables that are already set), so the mapping is mirrored here. Keep in
 * sync with `@earendil-works/pi-ai/dist/env-api-keys.js` when bumping pi-ai.
 */
export const PROVIDER_API_KEY_ENV: Readonly<Record<string, string>> = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  'ant-ling': 'ANT_LING_API_KEY',
  'qwen-token-plan': 'QWEN_TOKEN_PLAN_API_KEY',
  'qwen-token-plan-cn': 'QWEN_TOKEN_PLAN_CN_API_KEY',
  // pi-ai 0.84.2 split the individual Qwen plan into its own provider id; it
  // reads the same variable as `qwen-token-plan`.
  'qwen-token-plan-individual': 'QWEN_TOKEN_PLAN_API_KEY',
  openai: 'OPENAI_API_KEY',
  'azure-openai-responses': 'AZURE_OPENAI_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  google: 'GEMINI_API_KEY',
  'google-vertex': 'GOOGLE_CLOUD_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  xai: 'XAI_API_KEY',
  radius: 'RADIUS_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
  zai: 'ZAI_API_KEY',
  'zai-coding-cn': 'ZAI_CODING_CN_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
  'moonshotai-cn': 'MOONSHOT_API_KEY',
  huggingface: 'HF_TOKEN',
  fireworks: 'FIREWORKS_API_KEY',
  together: 'TOGETHER_API_KEY',
  baseten: 'BASETEN_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  'kimi-coding': 'KIMI_API_KEY',
  'cloudflare-workers-ai': 'CLOUDFLARE_API_KEY',
  'cloudflare-ai-gateway': 'CLOUDFLARE_API_KEY',
  xiaomi: 'XIAOMI_API_KEY',
  'xiaomi-token-plan-cn': 'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'xiaomi-token-plan-ams': 'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'xiaomi-token-plan-sgp': 'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
});

/** Env var name a provider's API key is published under, or `null` if none. */
export function providerApiKeyEnvName(providerId: string): string | null {
  return PROVIDER_API_KEY_ENV[providerId] ?? null;
}

/** Env vars derived from one provider account. Empty unless it carries a plain API key. */
export type ProviderEnvSeed = Record<string, string>;

/**
 * Pure core: derive the seed for the selected provider from the account list.
 * Only `apiKey` accounts contribute; OAuth accounts (`accessToken`) and
 * providers without an env mapping yield `{}`.
 */
export function buildProviderEnvSeed(
  selectedProvider: string,
  accounts: ReadonlyArray<Pick<Account, 'providerId' | 'apiKey'>>
): ProviderEnvSeed {
  const name = providerApiKeyEnvName(selectedProvider);
  if (!name) return {};
  const account = accounts.find((a) => a.providerId === selectedProvider);
  const key = account?.apiKey?.trim();
  if (!key) return {};
  return { [name]: key };
}

export type ProviderEnvSeeder = () => ProviderEnvSeed | Promise<ProviderEnvSeed>;

let registeredSeeder: ProviderEnvSeeder | null = null;

/** Install (or, with `null`, remove) the process-wide seeder. Returns the previous one. */
export function registerProviderEnvSeeder(
  seeder: ProviderEnvSeeder | null
): ProviderEnvSeeder | null {
  const previous = registeredSeeder;
  registeredSeeder = seeder;
  return previous;
}

/**
 * Resolve the current seed. Never throws: a failing seeder (storage
 * unavailable, account-store import error) degrades to an empty seed so a
 * script still runs — it just sees no provider key.
 */
export async function resolveProviderEnvSeed(): Promise<ProviderEnvSeed> {
  if (!registeredSeeder) return {};
  try {
    return (await registeredSeeder()) ?? {};
  } catch {
    return {};
  }
}

/**
 * Seeder backed by the live account store. Imported lazily so the pure
 * helpers above stay free of `localStorage` for tests and headless tools —
 * the same pattern `oauth-token` uses to reach the provider registry.
 */
export function createAccountStoreEnvSeeder(): ProviderEnvSeeder {
  return async () => {
    const { getAccounts, getSelectedProvider } = await import('../providers/account-store.js');
    return buildProviderEnvSeed(getSelectedProvider(), getAccounts());
  };
}
