/**
 * pi-ai provider ids that pi renamed, old → new. Every persisted place a
 * provider id lives — accounts, `selected-model`, work-unit records and
 * `/etc/models` — reads through {@link canonicalProviderId}, so state saved
 * under the old id keeps working after the upgrade.
 * (pi-ai 1.0.3: `azure-openai-responses` → `azure`.)
 *
 * Dependency-free on purpose: the work-unit record layer imports it.
 */
export const RENAMED_PI_PROVIDERS: Readonly<Record<string, string>> = Object.freeze({
  'azure-openai-responses': 'azure',
});

/** The current id for a provider id that may predate a pi-ai rename. */
export function canonicalProviderId(providerId: string): string {
  return Object.hasOwn(RENAMED_PI_PROVIDERS, providerId)
    ? RENAMED_PI_PROVIDERS[providerId]
    : providerId;
}
