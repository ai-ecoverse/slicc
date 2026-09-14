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
