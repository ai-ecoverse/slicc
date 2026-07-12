/**
 * SecretStore implementation backed by a .env file.
 *
 * Default location: ~/.slicc/secrets.env
 * Override via SLICC_SECRETS_FILE env var.
 *
 * File is created with mode 0600 if it doesn't exist.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { DOMAINS_SUFFIX, pairEnvEntriesToSecrets, type SecretEnvEntry } from '@slicc/shared-ts';
import { type EnvEntry, parseEnvFile, serializeEnvFile } from './env-file.js';
import type { Secret, SecretEntry, SecretStore } from './types.js';

const DEFAULT_PATH = resolve(homedir(), '.slicc', 'secrets.env');
const FILE_MODE = 0o600;

export class EnvSecretStore implements SecretStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? process.env['SLICC_SECRETS_FILE'] ?? DEFAULT_PATH;
  }

  get(name: string): Secret | null {
    return this.readSecrets().find((secret) => secret.name === name) ?? null;
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
    return this.readSecrets().map(({ name, domains }) => ({ name, domains }));
  }

  // -- internal helpers --

  private readEntries(): EnvEntry[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, 'utf-8');
    return parseEnvFile(content);
  }

  private readSecrets(): SecretEnvEntry[] {
    return pairEnvEntriesToSecrets(this.readEntries());
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

function upsertEntry(entries: EnvEntry[], key: string, value: string): void {
  const idx = entries.findIndex((e) => e.key === key);
  if (idx >= 0) {
    entries[idx] = { key, value };
  } else {
    entries.push({ key, value });
  }
}
