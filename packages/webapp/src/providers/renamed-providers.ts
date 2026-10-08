export const RENAMED_PI_PROVIDERS: Readonly<Record<string, string>> = Object.freeze({
  'azure-openai-responses': 'azure',
});

export function canonicalProviderId(providerId: string): string {
  return Object.hasOwn(RENAMED_PI_PROVIDERS, providerId)
    ? RENAMED_PI_PROVIDERS[providerId]
    : providerId;
}
