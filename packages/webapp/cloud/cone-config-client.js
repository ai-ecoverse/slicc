// Pure bundle-assembly helpers for the /cloud dashboard. No DOM access here.

// localStorage key the connect popup (?connect=1) writes the model catalog to,
// and the dashboard reads. Same-origin handoff, mirroring slicc_accounts.
export const MODEL_CATALOG_KEY = 'slicc_cloud_model_catalog';

// Safety net so the model picker is never empty for a connected provider that
// predates the catalog handoff (user hasn't reopened Connect since this shipped).
// The catalog from getAllAvailableModels() is always authoritative when present.
const FALLBACK_MODELS = {
  adobe: [{ id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }],
  anthropic: [
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  ],
  openai: [{ id: 'gpt-5', name: 'GPT-5' }],
};

// Parse the persisted model catalog. Returns a clean GroupedModels[]
// ([{providerId, providerName, models:[{id,name}]}]) or [] on any problem —
// never throws, so a corrupt/absent value degrades to "no catalog".
export function parseModelCatalog(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((g) => g && typeof g.providerId === 'string' && Array.isArray(g.models))
    .map((g) => ({
      providerId: g.providerId,
      providerName: typeof g.providerName === 'string' ? g.providerName : g.providerId,
      models: g.models
        .filter((m) => m && typeof m.id === 'string')
        .map((m) => ({ id: m.id, name: typeof m.name === 'string' ? m.name : m.id })),
    }));
}

// Friendly display name for a provider, from the catalog if known.
export function providerLabel(providerId, catalog) {
  const g = catalog.find((x) => x.providerId === providerId);
  return g?.providerName || providerId;
}

// The model groups the dashboard should offer: one per connected provider,
// using the catalog when it has models, else the fallback map. A connected
// provider with neither is omitted (nothing to pick).
export function modelsForConnected(catalog, accounts) {
  const byProvider = new Map(catalog.map((g) => [g.providerId, g]));
  const seen = new Set();
  const groups = [];
  for (const acc of accounts) {
    const providerId = acc.providerId;
    if (seen.has(providerId)) continue;
    seen.add(providerId);
    const fromCatalog = byProvider.get(providerId);
    if (fromCatalog && fromCatalog.models.length > 0) {
      groups.push(fromCatalog);
    } else if (FALLBACK_MODELS[providerId]) {
      groups.push({
        providerId,
        providerName: providerLabel(providerId, catalog),
        models: FALLBACK_MODELS[providerId],
      });
    }
  }
  return groups;
}

export function assembleBundle({ model, selectedProviderIds, allAccounts, secretRows }) {
  const selected = new Set(selectedProviderIds);
  const accounts = allAccounts
    // Skip selected-but-credential-less accounts (e.g. a logged-out token cleared
    // to '') so we don't ship a meaningless { kind:'apikey', apiKey:'' }.
    .filter((a) => selected.has(a.providerId) && (a.accessToken || a.apiKey))
    .map((a) =>
      a.accessToken
        ? {
            providerId: a.providerId,
            kind: 'oauth',
            accessToken: a.accessToken,
            ...(a.refreshToken ? { refreshToken: a.refreshToken } : {}),
            ...(a.tokenExpiresAt ? { tokenExpiresAt: a.tokenExpiresAt } : {}),
            ...(a.userName ? { userName: a.userName } : {}),
          }
        : { providerId: a.providerId, kind: 'apikey', apiKey: a.apiKey }
    );
  const secrets = secretRows
    .map((r) => ({
      name: r.name,
      value: r.value,
      domains: r.domains
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean),
    }))
    // A flat secret needs >=1 domain or the fetch-proxy can never inject it
    // (EnvSecretStore drops domain-less entries). Require name + value + domain
    // so we don't ship a silently-useless secret.
    .filter((s) => s.name && s.value && s.domains.length > 0);
  return { model, accounts, secrets };
}

// Explain which selected entries assembleBundle will silently drop, so the
// dashboard can warn the user instead of letting an item that's visible in the
// UI vanish from the cone. Returns human-readable strings (empty = nothing dropped).
export function bundleDropWarnings({ selectedProviderIds, allAccounts, secretRows }) {
  const warnings = [];
  const selected = new Set(selectedProviderIds);
  const credentialLess = allAccounts
    .filter((a) => selected.has(a.providerId) && !(a.accessToken || a.apiKey))
    .map((a) => a.providerId);
  if (credentialLess.length > 0) {
    warnings.push(
      `Skipping ${credentialLess.join(', ')}: no credential (re-connect the provider first).`
    );
  }
  // A blank row (every field empty) is an unused placeholder, not an error.
  // Flag only rows the user partially filled but left missing name/value/domain.
  const incomplete = secretRows
    .map((r) => ({
      name: (r.name || '').trim(),
      value: r.value || '',
      domains: (r.domains || '')
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean),
    }))
    .filter(
      (r) => (r.name || r.value || r.domains.length) && !(r.name && r.value && r.domains.length)
    )
    .map((r) => r.name || '(unnamed)');
  if (incomplete.length > 0) {
    warnings.push(
      `Skipping incomplete secret${incomplete.length > 1 ? 's' : ''} ${incomplete.join(', ')}: each needs a name, value, and at least one domain.`
    );
  }
  return warnings;
}

export function validateModelHasAccount(model, selectedProviderIds, authOptionalProviders) {
  const provider = model.split(':')[0];
  if (authOptionalProviders.includes(provider)) return true;
  return selectedProviderIds.includes(provider);
}

// Build the coneConfigDelta for a plain resume. The worker strips any
// user-supplied adobe account/secret (its fresh Auth header bearer is
// authoritative), but non-adobe accounts (e.g. github) are passed through.
// We still ship all connected accounts so their tokenExpiresAt values reach
// the cone — without expiry the kernel worker treats valid tokens as expired.
// Only accounts (no model/secrets/deletes) — a plain resume changes nothing else.
export function assembleResumeDelta(allAccounts) {
  return assembleDelta({
    upsertAccounts: allAccounts.filter((a) => a.accessToken || a.apiKey),
    upsertSecretRows: [],
    deleteProviderIds: [],
    deleteSecretNames: [],
  });
}

export function assembleDelta({
  model,
  upsertAccounts,
  upsertSecretRows,
  deleteProviderIds,
  deleteSecretNames,
}) {
  const { accounts, secrets } = assembleBundle({
    model: model ?? '',
    selectedProviderIds: upsertAccounts.map((a) => a.providerId),
    allAccounts: upsertAccounts,
    secretRows: upsertSecretRows,
  });
  const delta = {};
  if (model) delta.model = model;
  const upsert = {};
  if (accounts.length) upsert.accounts = accounts;
  if (secrets.length) upsert.secrets = secrets;
  if (Object.keys(upsert).length) delta.upsert = upsert;
  const del = {};
  if (deleteProviderIds.length) del.providerIds = deleteProviderIds;
  if (deleteSecretNames.length) del.secretNames = deleteSecretNames;
  if (Object.keys(del).length) delta.delete = del;
  return delta;
}
