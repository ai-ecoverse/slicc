import type { Account } from '../providers/account-store.js';

export const PROVIDER_API_KEY_ENV: Readonly<Record<string, string>> = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  'ant-ling': 'ANT_LING_API_KEY',
  'qwen-token-plan': 'QWEN_TOKEN_PLAN_API_KEY',
  'qwen-token-plan-cn': 'QWEN_TOKEN_PLAN_CN_API_KEY',

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

export function providerApiKeyEnvName(providerId: string): string | null {
  return PROVIDER_API_KEY_ENV[providerId] ?? null;
}

export type ProviderEnvSeed = Record<string, string>;

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

export function registerProviderEnvSeeder(
  seeder: ProviderEnvSeeder | null
): ProviderEnvSeeder | null {
  const previous = registeredSeeder;
  registeredSeeder = seeder;
  return previous;
}

export async function resolveProviderEnvSeed(): Promise<ProviderEnvSeed> {
  if (!registeredSeeder) return {};
  try {
    return (await registeredSeeder()) ?? {};
  } catch {
    return {};
  }
}

export function createAccountStoreEnvSeeder(): ProviderEnvSeeder {
  return async () => {
    const { getAccounts, getSelectedProvider } = await import('../providers/account-store.js');
    return buildProviderEnvSeed(getSelectedProvider(), getAccounts());
  };
}
