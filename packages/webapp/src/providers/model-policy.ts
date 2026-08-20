/**
 * `/etc/models` — which `provider:model` combinations may be used while a
 * given provider is selected.
 *
 * Cross-provider model targeting (#2195) can move spend onto a DIFFERENT
 * account: a user may have one provider for work and one for personal use, and
 * `agent --model other:big-model` would silently bill the wrong one. So the
 * file is an ALLOW-LIST, keyed by the selected provider:
 *
 * ```ini
 * [adobe]                       # rules that apply while `adobe` is selected
 * openrouter:*                  # …every openrouter model may be targeted
 * anthropic:claude-opus-4-6     # …and exactly this one anthropic model
 * -adobe:claude-opus-5          # …but never adobe's own Opus 5
 * ```
 *
 * Semantics:
 *  - Every section implicitly allows the selected provider's OWN catalogue
 *    (`<selected>:*`); a `-<selected>:model` entry subtracts from it.
 *  - Any OTHER provider's model needs an explicit allow entry. No file, or no
 *    section for the selected provider, therefore means "own models only".
 *  - A deny entry always beats an allow entry, whatever the order.
 *
 * Two different surfaces consult this, and they are deliberately NOT the same:
 *  - Spawn resolution (`agent --model`, `scoop_scoop`) enforces the whole
 *    policy — this is the cost boundary.
 *  - The human model picker only hides EXPLICIT denials. Applying the
 *    cross-provider allow-list there would hide every other account's models
 *    and leave the user unable to switch providers at all; deliberately
 *    switching accounts is the user's call, spawning against another account
 *    behind their back is not.
 *
 * This module is pure (parse + evaluate) plus a process-wide snapshot the
 * synchronous resolvers read. `ModelPolicyFile` (scoops layer) owns loading
 * the file from the VFS and pushing it here on every change.
 */

import { createLogger } from '../base/logger.js';

const log = createLogger('model-policy');

/** VFS path of the model access policy. */
export const MODELS_POLICY_FILE = '/etc/models';

/** One `provider:model` / `provider:*` / `-provider:model` entry. */
export interface ModelPolicyEntry {
  providerId: string;
  /** Model id, or `*` for the provider's whole catalogue. */
  modelId: string;
  /** `true` for a leading-`-` denial. */
  deny: boolean;
}

/** Parsed `/etc/models`: entries grouped by the SELECTED provider they apply to. */
export interface ModelPolicy {
  /** Section name (selected provider id) → its entries, in file order. */
  sections: Record<string, ModelPolicyEntry[]>;
}

/** A policy with no sections: own-catalogue-only for every provider. */
export function emptyModelPolicy(): ModelPolicy {
  return { sections: {} };
}

/** Strip a `#` comment and surrounding whitespace from one line. */
function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

/**
 * Parse `/etc/models`. Unparseable lines are skipped with a warning rather
 * than failing the whole file — a typo in one entry must not silently widen
 * (or void) the rest of the policy.
 */
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

/** Whether an entry covers `providerId:modelId` (`*` covers the catalogue). */
function entryMatches(entry: ModelPolicyEntry, providerId: string, modelId: string): boolean {
  if (entry.providerId !== providerId) return false;
  return entry.modelId === '*' || entry.modelId === modelId;
}

/** Entries in force while `selectedProvider` is selected. */
function entriesFor(policy: ModelPolicy, selectedProvider: string): ModelPolicyEntry[] {
  return policy.sections[selectedProvider] ?? [];
}

/**
 * Whether `providerId:modelId` is explicitly denied — the only part of the
 * policy the human model picker applies. See the module doc for why the
 * allow-list half is not applied there.
 */
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

/**
 * Whether a scoop may be spawned against `providerId:modelId` while
 * `selectedProvider` is selected. Own catalogue: allowed unless denied. Any
 * other provider: needs an explicit allow entry.
 */
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

/**
 * The live policy. Defaults to empty (own catalogue only) so a float that
 * never loads the file — or loads it before the VFS is up — is closed rather
 * than open: an unloaded policy must not silently authorize another account.
 */
let activePolicy: ModelPolicy = emptyModelPolicy();

/** Publish a freshly parsed policy. Called by `ModelPolicyFile` on every change. */
export function setActiveModelPolicy(policy: ModelPolicy): void {
  activePolicy = policy;
}

/** The live policy snapshot the synchronous resolvers read. */
export function getActiveModelPolicy(): ModelPolicy {
  return activePolicy;
}

/**
 * The `/etc/models` line a user would add to permit `providerId:modelId`,
 * used verbatim in the rejection message so the fix is copy-pasteable.
 */
export function policyHintFor(
  selectedProvider: string,
  providerId: string,
  modelId: string
): string {
  return `add \`${providerId}:${modelId}\` (or \`${providerId}:*\`) under \`[${selectedProvider}]\` in ${MODELS_POLICY_FILE}`;
}
