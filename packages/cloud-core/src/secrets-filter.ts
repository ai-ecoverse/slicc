/**
 * Strip locally-only keys from secrets.env before upload. E2B_API_KEY is the
 * user's substrate credential — there is no reason for it to live inside the
 * cloud sandbox where the cone could use it to spawn additional sandboxes
 * against the user's e2b account. Keep this list narrow.
 */
const SECRETS_STRIP_KEYS = ['E2B_API_KEY', 'E2B_API_KEY_DOMAINS'] as const;

export function filterSecretsEnv(contents: string): string {
  const out: string[] = [];
  for (const line of contents.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && (SECRETS_STRIP_KEYS as readonly string[]).includes(m[1])) continue;
    out.push(line);
  }
  return out.join('\n');
}
