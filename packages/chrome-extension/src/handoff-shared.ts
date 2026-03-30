import type { GenericHandoffPayload, PendingHandoff } from './messages.js';

export const HANDOFF_ALLOWED_ORIGINS = [
  'https://www.sliccy.ai',
  'https://slicc-tray-hub-staging.minivelos.workers.dev',
] as const;

export const HANDOFF_PATH = '/handoff';

function hashFragment(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function decodeBase64UrlUtf8(fragment: string): string {
  const normalized = fragment.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4;
  const padded = padding === 0 ? normalized : normalized + '='.repeat(4 - padding);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function normalizeHandoffPayload(value: unknown): GenericHandoffPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['instruction'] !== 'string' || !record['instruction'].trim()) return null;
  if (record['title'] !== undefined && typeof record['title'] !== 'string') return null;
  if (record['context'] !== undefined && typeof record['context'] !== 'string') return null;
  if (record['notes'] !== undefined && typeof record['notes'] !== 'string') return null;
  if (record['urls'] !== undefined && !isStringArray(record['urls'])) return null;
  if (record['acceptanceCriteria'] !== undefined && !isStringArray(record['acceptanceCriteria'])) {
    return null;
  }

  return {
    title: typeof record['title'] === 'string' ? record['title'] : undefined,
    instruction: record['instruction'].trim(),
    urls: isStringArray(record['urls']) ? record['urls'] : undefined,
    context: typeof record['context'] === 'string' ? record['context'] : undefined,
    acceptanceCriteria: isStringArray(record['acceptanceCriteria'])
      ? record['acceptanceCriteria']
      : undefined,
    notes: typeof record['notes'] === 'string' ? record['notes'] : undefined,
  };
}

export function normalizePendingHandoff(value: unknown): PendingHandoff | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const payload = normalizeHandoffPayload(record['payload']);
  if (!payload) return null;
  if (typeof record['handoffId'] !== 'string' || !record['handoffId']) return null;
  if (typeof record['sourceUrl'] !== 'string' || !record['sourceUrl']) return null;
  if (typeof record['receivedAt'] !== 'string' || !record['receivedAt']) return null;
  if (record['sourceTabId'] !== undefined && typeof record['sourceTabId'] !== 'number') {
    return null;
  }
  return {
    handoffId: record['handoffId'],
    sourceUrl: record['sourceUrl'],
    sourceTabId: typeof record['sourceTabId'] === 'number' ? record['sourceTabId'] : undefined,
    payload,
    receivedAt: record['receivedAt'],
  };
}

export function isAllowedHandoffUrl(parsedUrl: URL): boolean {
  if (parsedUrl.pathname !== HANDOFF_PATH) return false;
  if (parsedUrl.protocol !== 'https:') return false;
  return HANDOFF_ALLOWED_ORIGINS.includes(
    parsedUrl.origin as (typeof HANDOFF_ALLOWED_ORIGINS)[number]
  );
}

export function parseHandoffFromUrl(
  urlString: string,
  sourceTabId?: number
): PendingHandoff | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    return null;
  }

  if (!isAllowedHandoffUrl(parsedUrl)) {
    return null;
  }

  const fragment = parsedUrl.hash.replace(/^#/, '');
  if (!fragment) return null;

  try {
    const json = decodeBase64UrlUtf8(fragment);
    const payload = normalizeHandoffPayload(JSON.parse(json));
    if (!payload) return null;
    return {
      handoffId: `handoff-${hashFragment(fragment)}`,
      sourceUrl: parsedUrl.toString(),
      sourceTabId,
      payload,
      receivedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function getHandoffSourcePageUrl(sourceUrl: string): string {
  try {
    const parsedUrl = new URL(sourceUrl);
    return `${parsedUrl.origin}${parsedUrl.pathname}`;
  } catch {
    return sourceUrl;
  }
}
