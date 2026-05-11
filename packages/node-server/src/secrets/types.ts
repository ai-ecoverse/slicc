/**
 * A secret with its value and authorized domains.
 */
export interface Secret {
  name: string;
  value: string;
  domains: string[];
}

/**
 * A secret entry without the value — safe to expose to the agent.
 */
export interface SecretEntry {
  name: string;
  domains: string[];
}

/**
 * SecretStore interface for reading/writing secrets.
 * Implemented by EnvSecretStore (node-server) and Keychain (swift-server).
 */
export interface SecretStore {
  /** Read a secret by name. Returns null if not found or has no _DOMAINS entry. */
  get(name: string): Secret | null;

  /** Write a secret with its value and authorized domains. */
  set(name: string, value: string, domains: string[]): void;

  /** Remove a secret and its _DOMAINS entry. */
  delete(name: string): void;

  /** List all secrets with their domains (never values). */
  list(): SecretEntry[];
}

/**
 * Re-export MaskedSecret from @slicc/shared-ts to avoid duplication.
 * This was previously defined inline in proxy-manager.ts.
 */
export type { MaskedSecret } from '@slicc/shared-ts';
