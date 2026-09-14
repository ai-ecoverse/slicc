const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  adobe: 'Adobe',
  github: 'GitHub',
  bedrock: 'AWS Bedrock',
  azure: 'Azure',
  'azure-openai': 'Azure OpenAI',
  'azure-ai-foundry': 'Azure AI Foundry',
  groq: 'Groq',
  xai: 'xAI',
  openrouter: 'OpenRouter',
  local: 'your local model',
};

export function providerLabel(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  return PROVIDER_LABELS[id] ?? id;
}
