const RECENT_MESSAGE_LIMIT = 8;
const GENERIC_URL_PARTS = new Set([
  'catalog',
  'com',
  'html',
  'http',
  'https',
  'json',
  'known',
  'llms',
  'net',
  'org',
  'txt',
  'well',
  'www',
]);

export interface DiscoveryRoute {
  discoveryOrigin?: string;
  discoveryUrl?: string;
}

export interface DiscoveryRouteCandidate {
  jid: string;
}

interface WeightedNeedle {
  text: string;
  weight: number;
  match: 'substring' | 'hostname';
}

export function matchDiscoveryRouteCandidate<T extends DiscoveryRouteCandidate>(
  event: DiscoveryRoute,
  candidates: readonly T[],
  getMessages: (candidate: T) => readonly unknown[]
): T | undefined {
  const needles = discoveryNeedles(event);
  if (needles.length === 0) return undefined;

  let best: T | undefined;
  let bestScore = 0;
  let tied = false;

  for (const candidate of candidates) {
    const score = scoreRecentMessages(getMessages(candidate), needles);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
      tied = false;
    } else if (score > 0 && score === bestScore) {
      tied = true;
    }
  }

  return tied ? undefined : best;
}

function discoveryNeedles(event: DiscoveryRoute): WeightedNeedle[] {
  const needles = new Map<string, WeightedNeedle>();
  addUrlNeedles(needles, event.discoveryOrigin);
  addUrlNeedles(needles, event.discoveryUrl);
  return [...needles.values()];
}

function addUrlNeedles(needles: Map<string, WeightedNeedle>, value: string | undefined): void {
  if (!value) return;
  const normalized = value.toLowerCase().replace(/\/$/, '');
  addNeedle(needles, normalized, 12, 'substring');

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    addNeedle(needles, hostname, 8, 'hostname');
    for (const part of `${hostname}${url.pathname}${url.search}`
      .split(/[^a-z0-9]+/)
      .filter((part) => part.length >= 4 && !GENERIC_URL_PARTS.has(part))) {
      addNeedle(needles, part, 1, 'substring');
    }
  } catch {}
}

function addNeedle(
  needles: Map<string, WeightedNeedle>,
  text: string,
  weight: number,
  match: WeightedNeedle['match']
): void {
  if (text.length === 0) return;
  const key = `${match}:${text}`;
  const existing = needles.get(key);
  if (!existing || weight > existing.weight) needles.set(key, { text, weight, match });
}

function scoreRecentMessages(
  messages: readonly unknown[],
  needles: readonly WeightedNeedle[]
): number {
  const recent = messages.slice(-RECENT_MESSAGE_LIMIT);
  let score = 0;
  for (const [index, message] of recent.entries()) {
    const haystack = serializeMessage(message);
    if (haystack.length === 0) continue;

    const recency = RECENT_MESSAGE_LIMIT - (recent.length - 1 - index);
    for (const needle of needles) {
      if (matchesNeedle(haystack, needle)) score += needle.weight * recency;
    }
  }
  return score;
}

function matchesNeedle(haystack: string, needle: WeightedNeedle): boolean {
  if (needle.match === 'substring') return haystack.includes(needle.text);
  const escaped = needle.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return new RegExp(`(^|[^a-z0-9.-])(?:www\\.)?${escaped}($|[^a-z0-9.-])`).test(haystack);
}

function serializeMessage(message: unknown): string {
  try {
    return JSON.stringify(message)?.toLowerCase() ?? '';
  } catch {
    return '';
  }
}
