export interface SessionSecretRecord {
  name: string;
  value: string;
  domains: string[];
}

export class SessionSecretStore {
  private readonly entries = new Map<string, SessionSecretRecord>();

  set(name: string, value: string, domains: string[] = []): void {
    this.entries.set(name, { name, value, domains: [...domains] });
  }

  get(name: string): string | undefined {
    return this.entries.get(name)?.value;
  }

  getRecord(name: string): SessionSecretRecord | undefined {
    const r = this.entries.get(name);
    return r ? { name: r.name, value: r.value, domains: [...r.domains] } : undefined;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  setDomains(name: string, domains: string[]): boolean {
    const r = this.entries.get(name);
    if (!r) return false;
    r.domains = [...domains];
    return true;
  }

  delete(name: string): boolean {
    return this.entries.delete(name);
  }

  listAll(): SessionSecretRecord[] {
    return Array.from(this.entries.values()).map((r) => ({
      name: r.name,
      value: r.value,
      domains: [...r.domains],
    }));
  }

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

export function previewSecret(value: string, edge = 4): string {
  const len = value.length;
  if (len === 0) return '';
  if (len <= 2) return '…';
  const e = Math.min(Math.max(1, edge), Math.floor((len - 1) / 2));
  return `${value.slice(0, e)}…${value.slice(len - e)}`;
}
