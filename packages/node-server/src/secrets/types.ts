export interface Secret {
  name: string;
  value: string;
  domains: string[];
}

export interface SecretEntry {
  name: string;
  domains: string[];
}

export interface SecretStore {
  get(name: string): Secret | null;

  set(name: string, value: string, domains: string[]): void;

  delete(name: string): void;

  list(): SecretEntry[];
}

export type { MaskedSecret } from '@slicc/shared-ts';
