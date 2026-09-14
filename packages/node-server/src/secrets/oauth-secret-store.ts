export interface OauthEntry {
  name: string;
  value: string;
  domains: string[];
}

export class OauthSecretStore {
  private entries = new Map<string, OauthEntry>();
  set(name: string, value: string, domains: string[]): void {
    if (!Array.isArray(domains) || domains.length === 0) {
      throw new Error('OauthSecretStore: domains must be non-empty');
    }
    this.entries.set(name, { name, value, domains });
  }
  delete(name: string): void {
    this.entries.delete(name);
  }
  list(): OauthEntry[] {
    return Array.from(this.entries.values());
  }
  get(name: string): string | undefined {
    return this.entries.get(name)?.value;
  }
}
