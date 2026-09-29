/**
 * What the report knows about a model spec (`claude-opus-5-5@max`, `gpt-6-luna`, `kimi-k3`):
 * provider, family, tier, version and thinking variant. Two things use it:
 * - color: one hue per provider, one shade per model, older generations less saturated;
 * - comparisons: a model against its older version, its sibling at the other provider (tiers
 *   line up: haiku ↔ luna, sonnet ↔ terra, opus ↔ sol, fable ↔ astra), the next tier up or down
 *   at its own provider, and an effort variant against the same model at `@default`.
 *
 * A plain alias and `@default` are the same configuration (the bench sets no thinking level for
 * either), so {@link canonicalModel} folds `@default` away.
 */

/** Tier within a provider's lineup, lowest first. Same number = siblings across providers. */
const TIERS = {
  anthropic: { haiku: 1, sonnet: 2, opus: 3, fable: 4 },
  openai: { luna: 1, terra: 2, sol: 3, astra: 4 },
};

/** `claude-opus-5-5@default` and `claude-opus-5-5` are the same configuration. */
export function canonicalModel(spec) {
  return String(spec ?? '').replace(/@default$/, '');
}

const versionOf = (major, minor) => [Number(major), Number(minor ?? 0)];

/**
 * Parse a model spec. Unknown shapes still get a provider (`other`) and no tier, so they are
 * colored and listed but never paired by tier.
 */
export function parseModel(spec) {
  const canonical = canonicalModel(spec);
  const [base, variant = 'default'] = canonical.split('@');
  let m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(base);
  if (m) {
    const tier = TIERS.anthropic[m[1]] ?? null;
    return {
      spec: canonical,
      base,
      variant,
      provider: 'anthropic',
      family: m[1],
      tier,
      version: versionOf(m[2], m[3]),
    };
  }
  m = /^gpt-(\d+)(?:\.(\d+))?-([a-z]+)$/.exec(base);
  if (m) {
    const tier = TIERS.openai[m[3]] ?? null;
    return {
      spec: canonical,
      base,
      variant,
      provider: 'openai',
      family: m[3],
      tier,
      version: versionOf(m[1], m[2]),
    };
  }
  m = /^kimi-k(\d+)(?:\.(\d+))?$/.exec(base);
  if (m)
    return {
      spec: canonical,
      base,
      variant,
      provider: 'moonshot',
      family: 'kimi',
      tier: null,
      version: versionOf(m[1], m[2]),
    };
  return {
    spec: canonical,
    base,
    variant,
    provider: 'other',
    family: base,
    tier: null,
    version: [0, 0],
  };
}

/** Newer version first. */
export const compareVersions = (a, b) => b[0] - a[0] || b[1] - a[1];

/** The provider whose tier-mates are a model's siblings. */
const SIBLING_PROVIDER = { anthropic: 'openai', openai: 'anthropic' };

/** Hue per provider; `other` is grey. */
const HUES = { anthropic: 18, openai: 172, moonshot: 268, google: 215, other: 0 };

/**
 * One color per model spec, as `{ light, dark }` CSS colors.
 * - hue: the provider, stepped a little per family (±14°) so neighbouring families separate;
 * - lightness: the model's place among its provider's models (tier, then family), so models of
 *   one provider are told apart by shade;
 * - saturation: the generation, newest most colorful, each older major.minor step duller;
 * - a thinking variant keeps its model's shade, a little lighter (`low`) or darker (`max`).
 */
export function modelColors(specs) {
  const parsed = [...new Set(specs.map(canonicalModel))].map(parseModel);
  const out = new Map();
  const byProvider = new Map();
  for (const p of parsed) byProvider.set(p.provider, [...(byProvider.get(p.provider) ?? []), p]);
  for (const [provider, ps] of byProvider) {
    const bases = [...new Map(ps.map((p) => [p.base, p])).values()].sort(
      (a, b) =>
        (a.tier ?? 9) - (b.tier ?? 9) ||
        a.family.localeCompare(b.family) ||
        compareVersions(b.version, a.version)
    );
    const generations = [...new Set(ps.map((p) => p.version.join('.')))].sort((a, b) =>
      compareVersions(a.split('.').map(Number), b.split('.').map(Number))
    );
    const hue = HUES[provider] ?? 0;
    const families = [...new Set(bases.map((b) => b.family))];
    for (const p of ps) {
      const i = bases.findIndex((b) => b.base === p.base);
      const f = families.indexOf(p.family);
      // Shade: lightness spread across 28–68% (light theme) by the model's place in the lineup,
      // plus a small per-family hue step (±14° around the provider's hue) so neighbouring
      // families separate while staying one provider's color.
      const shade = bases.length > 1 ? 28 + (40 * i) / (bases.length - 1) : 48;
      const hueStep = families.length > 1 ? -14 + (28 * f) / (families.length - 1) : 0;
      const age = generations.indexOf(p.version.join('.'));
      const sat = provider === 'other' ? 0 : Math.max(16, 82 - age * 30);
      const nudge = { low: 7, max: -7 }[p.variant] ?? 0;
      const light = Math.min(80, Math.max(20, shade + nudge));
      const h = (hue + hueStep + 360) % 360;
      out.set(p.spec, {
        light: `hsl(${h.toFixed(0)} ${sat}% ${light.toFixed(0)}%)`,
        dark: `hsl(${h.toFixed(0)} ${Math.min(90, sat + 6)}% ${Math.min(84, light + 14).toFixed(0)}%)`,
      });
    }
  }
  return out;
}

/**
 * The comparisons worth reading, as `{ kind, from, to }` pairs of model specs among `specs`:
 * - `version`: the newest older version of the same family;
 * - `sibling`: the same tier at the other provider (from the other provider's model to this one);
 * - `rung`: the next tier up at the same provider (each adjacent pair once, lower tier first);
 * - `effort`: a thinking variant against the same model at its default.
 * Version, sibling and rung compare default-effort models; the counterpart is the newest one with
 * data, preferring the same major version.
 */
export function modelComparisons(specs) {
  const all = [...new Set(specs.map(canonicalModel))].map(parseModel);
  const defaults = all.filter((p) => p.variant === 'default');
  const pairs = [];
  const seen = new Set();
  const add = (kind, from, to) => {
    const key = `${kind}|${from.spec}|${to.spec}`;
    if (from.spec !== to.spec && !seen.has(key)) {
      seen.add(key);
      pairs.push({ kind, from: from.spec, to: to.spec });
    }
  };
  // Closest counterpart: same major version when there is one, then the newest.
  const pick = (cands, p) =>
    [...cands].sort(
      (a, b) =>
        Number(b.version[0] === p.version[0]) - Number(a.version[0] === p.version[0]) ||
        compareVersions(a.version, b.version)
    )[0];
  for (const p of defaults) {
    const older = defaults.filter(
      (q) =>
        q.provider === p.provider &&
        q.family === p.family &&
        compareVersions(q.version, p.version) > 0
    );
    if (older.length)
      add('version', older.sort((a, b) => compareVersions(a.version, b.version))[0], p);
    if (p.tier != null && p.provider === 'anthropic') {
      const sib = defaults.filter(
        (q) => q.provider === SIBLING_PROVIDER[p.provider] && q.tier === p.tier
      );
      if (sib.length) add('sibling', pick(sib, p), p);
    }
    if (p.tier != null) {
      const up = defaults.filter((q) => q.provider === p.provider && q.tier === p.tier + 1);
      if (up.length) add('rung', p, pick(up, p));
    }
  }
  for (const p of all.filter((q) => q.variant !== 'default')) {
    const base = defaults.find((q) => q.base === p.base);
    if (base) add('effort', base, p);
  }
  return pairs;
}
