/**
 * Pure scope-coverage check for cached OAuth tokens.
 *
 * `oauth-token <provider> --scope <scopes>` used to force a fresh login on
 * every call. This helper lets the command reuse a stored token when the
 * scopes it was granted already cover what the caller asked for.
 *
 * The implied-scope hierarchy encoded here is GitHub's, but it is harmless for
 * other providers: it only ever widens an exact-match check, and a provider
 * that does not use these names simply never hits an implication.
 */

/**
 * Explicit parent → child implications that don't follow the generic
 * `admin:` ⊃ `write:` ⊃ `read:` suffix rule.
 */
const IMPLIED_SCOPES: Readonly<Record<string, readonly string[]>> = {
  repo: ['repo:status', 'repo_deployment', 'public_repo', 'repo:invite', 'security_events'],
  user: ['read:user', 'user:email', 'user:follow'],
  project: ['read:project'],
};

/** Generic privilege ladder: `admin:<x>` ⊃ `write:<x>` ⊃ `read:<x>`. */
const PRIVILEGE_LADDER: Readonly<Record<string, readonly string[]>> = {
  'admin:': ['write:', 'read:'],
  'write:': ['read:'],
};

/** Split on commas and/or whitespace, trim, lowercase, drop empties, dedupe. */
function normalizeScopes(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((scope) => scope.trim().toLowerCase())
      .filter((scope) => scope.length > 0)
  );
}

/** Scopes directly implied by `scope`, one level down. */
function directlyImplied(scope: string): string[] {
  const implied = [...(IMPLIED_SCOPES[scope] ?? [])];
  for (const [prefix, targets] of Object.entries(PRIVILEGE_LADDER)) {
    if (!scope.startsWith(prefix)) continue;
    const suffix = scope.slice(prefix.length);
    if (!suffix) continue;
    for (const target of targets) implied.push(`${target}${suffix}`);
  }
  return implied;
}

/** Transitive closure of a granted scope set under the implication rules. */
function expandScopes(scopes: Set<string>): Set<string> {
  const expanded = new Set(scopes);
  const pending = [...scopes];
  while (pending.length > 0) {
    const scope = pending.pop() as string;
    for (const implied of directlyImplied(scope)) {
      if (expanded.has(implied)) continue;
      expanded.add(implied);
      pending.push(implied);
    }
  }
  return expanded;
}

/**
 * True when every scope in `requested` is covered by `granted`.
 *
 * Returns false when `granted` is undefined or empty: unknown grants (tokens
 * stored before scopes were recorded) fail safe and force a fresh login.
 */
export function scopesSatisfied(granted: string | undefined, requested: string): boolean {
  const grantedSet = normalizeScopes(granted);
  if (grantedSet.size === 0) return false;
  const requestedSet = normalizeScopes(requested);
  if (requestedSet.size === 0) return true;
  const covered = expandScopes(grantedSet);
  for (const scope of requestedSet) {
    if (!covered.has(scope)) return false;
  }
  return true;
}
