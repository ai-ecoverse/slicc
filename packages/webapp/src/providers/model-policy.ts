import { createLogger } from '../base/logger.js';

const log = createLogger('model-policy');

export const MODELS_POLICY_FILE = '/etc/models';

export interface ModelPolicyEntry {
  providerId: string;

  modelId: string;

  deny: boolean;
}

export interface ModelPolicy {
  sections: Record<string, ModelPolicyEntry[]>;
}

export function emptyModelPolicy(): ModelPolicy {
  return { sections: {} };
}

function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

export function parseModelPolicy(text: string): ModelPolicy {
  const policy = emptyModelPolicy();
  if (typeof text !== 'string') return policy;
  let section: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line) continue;

    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      policy.sections[section] ??= [];
      continue;
    }

    if (section === null) {
      log.warn('model policy entry before any [provider] section — ignored', { entry: line });
      continue;
    }

    const deny = line.startsWith('-');
    const body = deny ? line.slice(1).trim() : line;
    const colon = body.indexOf(':');
    if (colon <= 0 || colon === body.length - 1) {
      log.warn('model policy entry is not provider:model — ignored', { entry: line });
      continue;
    }
    policy.sections[section].push({
      providerId: body.slice(0, colon).trim(),
      modelId: body.slice(colon + 1).trim(),
      deny,
    });
  }

  return policy;
}

function entryMatches(entry: ModelPolicyEntry, providerId: string, modelId: string): boolean {
  if (entry.providerId !== providerId) return false;
  return entry.modelId === '*' || entry.modelId === modelId;
}

function entriesFor(policy: ModelPolicy, selectedProvider: string): ModelPolicyEntry[] {
  return policy.sections[selectedProvider] ?? [];
}

export function isModelDeniedByPolicy(
  policy: ModelPolicy,
  selectedProvider: string,
  providerId: string,
  modelId: string
): boolean {
  return entriesFor(policy, selectedProvider).some(
    (entry) => entry.deny && entryMatches(entry, providerId, modelId)
  );
}

export function isModelAllowedByPolicy(
  policy: ModelPolicy,
  selectedProvider: string,
  providerId: string,
  modelId: string
): boolean {
  const entries = entriesFor(policy, selectedProvider);
  if (entries.some((entry) => entry.deny && entryMatches(entry, providerId, modelId))) return false;
  if (providerId === selectedProvider) return true;
  return entries.some((entry) => !entry.deny && entryMatches(entry, providerId, modelId));
}

let activePolicy: ModelPolicy = emptyModelPolicy();

export function setActiveModelPolicy(policy: ModelPolicy): void {
  activePolicy = policy;
}

export function getActiveModelPolicy(): ModelPolicy {
  return activePolicy;
}

export function policyHintFor(
  selectedProvider: string,
  providerId: string,
  modelId: string
): string {
  return `add \`${providerId}:${modelId}\` (or \`${providerId}:*\`) under \`[${selectedProvider}]\` in ${MODELS_POLICY_FILE}`;
}
