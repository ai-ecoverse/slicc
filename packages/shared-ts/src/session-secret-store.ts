/**
 * In-memory, session-only secret store.
 *
 * Session secrets are set by the agent without approval and are NEVER
 * persisted to disk / Keychain / chrome.storage — they live only for the
 * lifetime of the process (node-server) or service-worker (extension) that
 * owns the instance, and vanish on session end.
 *
 * The store is wired into {@link SecretsPipeline} (via `sessionStore`) so the
 * fetch proxy can unmask session secrets exactly like persisted ones, while
 * the `secret` shell command writes to it through the per-float transport.
 */

export interface SessionSecretRecord {
  name: string;
  value: string;
  domains: string[];
}

export class SessionSecretStore {
  private readonly entries = new Map<string, SessionSecretRecord>();

  /** Create or replace a session secret. Domains default to empty. */
  set(name: string, value: string, domains: string[] = []): void {
    this.entries.set(name, { name, value, domains: [...domains] });
  }

  /** Real value for `name`, or undefined when absent. */
  get(name: string): string | undefined {
    return this.entries.get(name)?.value;
  }

  /** Full record (value + domains) for `name`, or undefined when absent. */
  getRecord(name: string): SessionSecretRecord | undefined {
    const r = this.entries.get(name);
    return r ? { name: r.name, value: r.value, domains: [...r.domains] } : undefined;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Replace the allowed domains of an existing secret. No-op when absent. */
  setDomains(name: string, domains: string[]): boolean {
    const r = this.entries.get(name);
    if (!r) return false;
    r.domains = [...domains];
    return true;
  }

  delete(name: string): boolean {
    return this.entries.delete(name);
  }

  /** All records including values (for pipeline reload). */
  listAll(): SessionSecretRecord[] {
    return Array.from(this.entries.values()).map((r) => ({
      name: r.name,
      value: r.value,
      domains: [...r.domains],
    }));
  }

  /** Names + domains only (no values) for listing/management surfaces. */
  list(): Array<{ name: string; domains: string[] }> {
    return Array.from(this.entries.values()).map((r) => ({
      name: r.name,
      domains: [...r.domains],
    }));
  }

  size(): number {
    return this.entries.size;
  }
}

/**
 * Build a partial, redacted preview of a secret value: the first and last
 * `edge` characters with the middle elided. Always elides at least one
 * character so the full value is never reconstructable from the preview.
 *
 *   previewSecret('sk-proj-ABCDEFGH1234')  → 'sk-p…1234'
 *   previewSecret('short')                 → 's…t'
 */
export function previewSecret(value: string, edge = 4): string {
  const len = value.length;
  if (len === 0) return '';
  if (len <= 2) return '…';
  const e = Math.min(Math.max(1, edge), Math.floor((len - 1) / 2));
  return `${value.slice(0, e)}…${value.slice(len - e)}`;
}
