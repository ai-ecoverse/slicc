const IMPLIED_SCOPES: Readonly<Record<string, readonly string[]>> = {
  repo: ['repo:status', 'repo_deployment', 'public_repo', 'repo:invite', 'security_events'],
  user: ['read:user', 'user:email', 'user:follow'],
  project: ['read:project'],
};

const PRIVILEGE_LADDER: Readonly<Record<string, readonly string[]>> = {
  'admin:': ['write:', 'read:'],
  'write:': ['read:'],
};

function normalizeScopes(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((scope) => scope.trim().toLowerCase())
      .filter((scope) => scope.length > 0)
  );
}

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
