/**
 * SecretStore implementation backed by a .env file.
 *
 * Default location: ~/.slicc/secrets.env
 * Override via SLICC_SECRETS_FILE env var or --secrets-file flag.
 *
 * File is created with mode 0600 if it doesn't exist.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseEnvFile, serializeEnvFile, type EnvEntry } from './env-file.js';
import type { Secret, SecretEntry, SecretStore } from './types.js';

const DOMAINS_SUFFIX = '_DOMAINS';
const DEFAULT_PATH = resolve(homedir(), '.slicc', 'secrets.env');
const FILE_MODE = 0o600;

export class EnvSecretStore implements SecretStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? process.env['SLICC_SECRETS_FILE'] ?? DEFAULT_PATH;
  }

  get(name: string): Secret | null {
    const entries = this.readEntries();
    const valueEntry = entries.find((e) => e.key === name);
    const domainsEntry = entries.find((e) => e.key === name + DOMAINS_SUFFIX);

    if (!valueEntry || !domainsEntry) return null;

    const domains = parseDomains(domainsEntry.value);
    if (domains.length === 0) return null;

    return { name, value: valueEntry.value, domains };
  }

  set(name: string, value: string, domains: string[]): void {
    if (domains.length === 0) {
      throw new Error(`Secret "${name}" must have at least one authorized domain`);
    }

    const entries = this.readEntries();
    const domainsKey = name + DOMAINS_SUFFIX;

    upsertEntry(entries, name, value);
    upsertEntry(entries, domainsKey, domains.join(','));

    this.writeEntries(entries);
  }

  delete(name: string): void {
    const entries = this.readEntries();
    const domainsKey = name + DOMAINS_SUFFIX;
    const filtered = entries.filter((e) => e.key !== name && e.key !== domainsKey);
    this.writeEntries(filtered);
  }

  list(): SecretEntry[] {
    const entries = this.readEntries();
    const result: SecretEntry[] = [];

    for (const entry of entries) {
      if (entry.key.endsWith(DOMAINS_SUFFIX)) continue;

      const domainsEntry = entries.find((e) => e.key === entry.key + DOMAINS_SUFFIX);
      if (!domainsEntry) continue; // no _DOMAINS → skip (rejected)

      const domains = parseDomains(domainsEntry.value);
      if (domains.length > 0) {
        result.push({ name: entry.key, domains });
      }
    }

    return result;
  }

  // -- internal helpers --

  private readEntries(): EnvEntry[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, 'utf-8');
    return parseEnvFile(content);
  }

  private writeEntries(entries: EnvEntry[]): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const content = serializeEnvFile(entries);
    writeFileSync(this.filePath, content, { mode: FILE_MODE });
    // Ensure permissions even if file already existed
    try {
      chmodSync(this.filePath, FILE_MODE);
    } catch {
      // chmod may fail on some platforms (Windows); best-effort
    }
  }
}

function parseDomains(value: string): string[] {
  return value
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
}

function upsertEntry(entries: EnvEntry[], key: string, value: string): void {
  const idx = entries.findIndex((e) => e.key === key);
  if (idx >= 0) {
    entries[idx] = { key, value };
  } else {
    entries.push({ key, value });
  }
}
