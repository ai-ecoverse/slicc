/**
 * Human-readable names for provider ids, for the few places a person reads the
 * provider rather than the machine routing on it.
 *
 * Lives in `base/` because both the secret-entry surface (`ui/`) and the tool
 * wiring that supplies it (`scoops/`) need the same wording, and neither may
 * import the other.
 *
 * Deliberately NOT a catalogue: an id with no entry is shown as-is. A provider
 * added tomorrow reads slightly worse rather than reading as "unknown".
 */

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

/** The display name for `id`, the id itself when unknown, `undefined` when absent. */
export function providerLabel(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  return PROVIDER_LABELS[id] ?? id;
}
