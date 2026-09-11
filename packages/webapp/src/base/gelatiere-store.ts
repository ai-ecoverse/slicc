/**
 * The gelatiere's stores and its instruction-file contract — the pure half
 * of SLICC's resident advisor.
 *
 * The gelatiere itself is a persistent scoop (`scoops/gelatiere-unit.ts`)
 * that runs its passes inside its own conversation. What lives HERE is
 * everything that must be deterministic regardless of what the agent
 * writes: the config block of `/shared/GELATIERE.md`, the suggestion store
 * (`/shared/.gelatiere/suggestions.json`) with its id-keyed merge and
 * dismissal ledger, the run ledger (`state.json`), and the body of the
 * `gelatiere` lick every other cone receives. It sits in `base/` so the
 * `gelatiere` shell command (shell layer) and the page-side session hook
 * (ui layer) can both use it without a layer back-edge.
 */

import DEFAULT_GELATIERE_MD from '../../../vfs-root/shared/GELATIERE.md?raw';
import {
  parseFrontmatter,
  readOptionalString,
  splitInstructionDocument,
} from './instruction-frontmatter.js';
import { createLogger } from './logger.js';

export {
  GELATIERE_FOLDER,
  GELATIERE_NIGHTLY_CRON_NAME,
  GELATIERE_OWNER_JID,
  GELATIERE_SPRINKLE_NAME,
  isGelatiereUnit,
} from './gelatiere-constants.js';
export { DEFAULT_GELATIERE_MD };

const log = createLogger('gelatiere-store');

export const GELATIERE_INSTRUCTIONS_PATH = '/shared/GELATIERE.md';
export const GELATIERE_DIR = '/shared/.gelatiere';
export const GELATIERE_SUGGESTIONS_PATH = `${GELATIERE_DIR}/suggestions.json`;
export const GELATIERE_STATE_PATH = `${GELATIERE_DIR}/state.json`;
/** The lick action other cones receive when a pass delivered suggestions. */
export const GELATIERE_SUGGESTIONS_ACTION = 'gelatiere-suggestions';
/** The skill that tells a cone what to do with that lick. */
export const GELATIERE_SKILL_PATH = '/workspace/skills/gelatiere/SKILL.md';
export const DEFAULT_GELATIERE_NIGHTLY_CRON = '0 3 * * *';
export const DEFAULT_GELATIERE_INTERVAL_HOURS = 24;
export const DEFAULT_MAX_SUGGESTIONS = 5;
/** Hard cap on suggestions per pass, whatever the file asks for. */
export const MAX_SUGGESTIONS_PER_PASS = 10;
/** Oldest entries fall off the store past this many. */
export const MAX_STORED_SUGGESTIONS = 40;
/** How many open suggestions ride in one lick body. */
export const LICK_SUGGESTION_LIMIT = 5;

const GELATIERE_FRONTMATTER = {
  arrayKeys: new Set<string>(),
  scalarKeys: new Set(['intervalHours', 'nightly', 'maxSuggestions']),
};

export type GelatiereSuggestionKind = 'skill' | 'use-case' | 'tip';
const SUGGESTION_KINDS: ReadonlySet<string> = new Set(['skill', 'use-case', 'tip']);

export interface GelatiereSuggestion {
  /** Stable slug, so a repeat pass recognises what it already said. */
  id: string;
  kind: GelatiereSuggestionKind;
  title: string;
  body: string;
  /** `skill` kind: the catalog / repo skill name. */
  skill?: string;
  /** `skill` kind: the exact `upskill …` command that installs it. */
  install?: string;
  /** `use-case` kind: a message the user could send verbatim. */
  prompt?: string;
  url?: string;
  /** What in the sessions or memory motivated it. */
  evidence?: string;
  /** ISO timestamp of the pass that first produced it. */
  createdAt: string;
  /** ISO timestamp; set when the user waved it away ("Not now" / `gelatiere dismiss`). */
  dismissedAt?: string;
  /** ISO timestamp; set when the user acted on it ("Install" / "Try it"). */
  takenAt?: string;
}

export interface GelatiereState {
  /** When the last pass folded suggestions into the store (`gelatiere suggest`). */
  lastPassAt?: string;
  /**
   * When the page last sent a `session-settled` lick. Stamped where the
   * trigger is DECIDED, not where the pass lands: a pass that legitimately
   * suggests nothing never runs `gelatiere suggest`, and with only
   * `lastPassAt` as the gate every subsequent "New chat" would re-lick a
   * billable pass until the model happened to produce output.
   */
  lastTriggeredAt?: string;
  /** When the last delivery lick went out (`gelatiere deliver`). */
  lastDeliveredAt?: string;
  /** Passes recorded through `gelatiere suggest`. */
  passes: number;
}

export interface GelatiereConfig {
  /** Minimum hours between session-end passes (the nightly cron ignores it). */
  intervalHours: number;
  /** Cron expression of the nightly pass. */
  nightly: string;
  maxSuggestions: number;
  /** The pass instructions the gelatiere reads at the start of every pass. */
  instructions: string;
}

/** VFS surface the stores need, satisfied by the page and worker clients alike. */
export interface GelatiereVfs {
  readFile(path: string, options?: { encoding?: 'utf-8' }): Promise<string | Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

/** The body of the lick a cone receives after a delivery. */
export interface GelatiereLickBody {
  action: typeof GELATIERE_SUGGESTIONS_ACTION;
  data: {
    /** Open suggestions created since the previous delivery. */
    added: number;
    /** Open suggestions in total. */
    open: number;
    /** The newest open suggestions, capped at {@link LICK_SUGGESTION_LIMIT}. */
    suggestions: GelatiereSuggestion[];
    /** Where the full list lives. */
    path: string;
    /** What to do with this lick — the cone reads the skill, not a hint in the body. */
    skill: string;
  };
}

// ─── Instruction file ───────────────────────────────────────────────────────

export function parseGelatiereDocument(content: string): GelatiereConfig {
  const document = splitInstructionDocument(content, 'GELATIERE.md');
  const values = parseFrontmatter(document.frontmatter, GELATIERE_FRONTMATTER);
  const nightly = readOptionalString(values.nightly, 'nightly') ?? DEFAULT_GELATIERE_NIGHTLY_CRON;
  if (nightly.trim().split(/\s+/).length !== 5) {
    throw new Error('nightly must be a 5-field cron expression');
  }
  return {
    intervalHours: readPositiveNumber(
      values.intervalHours,
      'intervalHours',
      DEFAULT_GELATIERE_INTERVAL_HOURS
    ),
    nightly: nightly.trim(),
    maxSuggestions: Math.min(
      MAX_SUGGESTIONS_PER_PASS,
      readPositiveNumber(values.maxSuggestions, 'maxSuggestions', DEFAULT_MAX_SUGGESTIONS)
    ),
    instructions: document.body,
  };
}

function readPositiveNumber(
  value: string | string[] | undefined,
  key: string,
  fallback: number
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`${key} is invalid`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${key} must be positive`);
  return parsed;
}

/**
 * Read `/shared/GELATIERE.md`, falling back to the bundled default when the
 * file is absent or unparseable — a typo in the user's config block must
 * not silently switch the nightly pass off.
 */
export async function loadGelatiereConfig(
  vfs: Pick<GelatiereVfs, 'readFile'>
): Promise<GelatiereConfig> {
  try {
    return parseGelatiereDocument(await readText(vfs, GELATIERE_INSTRUCTIONS_PATH));
  } catch (error) {
    log.warn('Could not load valid GELATIERE.md; using built-in default', {
      error: errorText(error),
    });
    return parseGelatiereDocument(DEFAULT_GELATIERE_MD);
  }
}

// ─── Stores ─────────────────────────────────────────────────────────────────

async function readText(vfs: Pick<GelatiereVfs, 'readFile'>, path: string): Promise<string> {
  const raw = await vfs.readFile(path, { encoding: 'utf-8' });
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

async function readJson(vfs: Pick<GelatiereVfs, 'readFile'>, path: string): Promise<unknown> {
  try {
    return JSON.parse(await readText(vfs, path));
  } catch {
    return undefined;
  }
}

/** Every stored suggestion, newest first; `[]` when the store is absent or unreadable. */
export async function readGelatiereSuggestions(
  vfs: Pick<GelatiereVfs, 'readFile'>
): Promise<GelatiereSuggestion[]> {
  const parsed = await readJson(vfs, GELATIERE_SUGGESTIONS_PATH);
  if (!Array.isArray(parsed)) return [];
  const kept: GelatiereSuggestion[] = [];
  for (const entry of parsed) {
    const suggestion = coerceSuggestion(entry, null);
    if (!suggestion) continue;
    const { dismissedAt, takenAt } = entry as { dismissedAt?: unknown; takenAt?: unknown };
    if (typeof dismissedAt === 'string' && dismissedAt) suggestion.dismissedAt = dismissedAt;
    if (typeof takenAt === 'string' && takenAt) suggestion.takenAt = takenAt;
    kept.push(suggestion);
  }
  return kept;
}

export async function writeGelatiereSuggestions(
  vfs: GelatiereVfs,
  suggestions: GelatiereSuggestion[]
): Promise<void> {
  await vfs.mkdir(GELATIERE_DIR, { recursive: true });
  await vfs.writeFile(GELATIERE_SUGGESTIONS_PATH, `${JSON.stringify(suggestions, null, 2)}\n`);
}

export async function readGelatiereState(
  vfs: Pick<GelatiereVfs, 'readFile'>
): Promise<GelatiereState> {
  const parsed = await readJson(vfs, GELATIERE_STATE_PATH);
  if (!parsed || typeof parsed !== 'object') return { passes: 0 };
  const raw = parsed as Partial<GelatiereState>;
  return {
    passes: typeof raw.passes === 'number' && raw.passes >= 0 ? raw.passes : 0,
    ...(typeof raw.lastPassAt === 'string' ? { lastPassAt: raw.lastPassAt } : {}),
    ...(typeof raw.lastTriggeredAt === 'string' ? { lastTriggeredAt: raw.lastTriggeredAt } : {}),
    ...(typeof raw.lastDeliveredAt === 'string' ? { lastDeliveredAt: raw.lastDeliveredAt } : {}),
  };
}

export async function writeGelatiereState(vfs: GelatiereVfs, state: GelatiereState): Promise<void> {
  await vfs.mkdir(GELATIERE_DIR, { recursive: true });
  await vfs.writeFile(GELATIERE_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * True when the newest of `lastPassAt` / `lastTriggeredAt` is older than
 * `intervalHours` (or neither exists). Both stamps count: a trigger whose
 * pass produced no suggestions must still hold the interval.
 */
export function isPassDue(state: GelatiereState, now: Date, intervalHours: number): boolean {
  const newest = Math.max(
    ...[state.lastPassAt, state.lastTriggeredAt]
      .map((stamp) => (stamp ? Date.parse(stamp) : Number.NaN))
      .filter((parsed) => !Number.isNaN(parsed))
  );
  if (!Number.isFinite(newest)) return true;
  return now.getTime() - newest >= intervalHours * 3_600_000;
}

/**
 * Stamp `lastTriggeredAt` — the page decided to send a `session-settled`
 * lick. This is the interval gate's write half; see the field's doc for why
 * `lastPassAt` alone cannot bound billable passes.
 */
export async function recordGelatiereTrigger(
  vfs: GelatiereVfs,
  now: Date = new Date()
): Promise<void> {
  const state = await readGelatiereState(vfs);
  await writeGelatiereState(vfs, { ...state, lastTriggeredAt: now.toISOString() });
}

/** Suggestions still awaiting an answer: neither dismissed nor taken, newest first. */
export function openSuggestions(
  suggestions: readonly GelatiereSuggestion[]
): GelatiereSuggestion[] {
  return suggestions.filter((s) => !s.dismissedAt && !s.takenAt);
}

/** Suggestions the user acted on ("Install" / "Try it"), newest first. */
export function takenSuggestions(
  suggestions: readonly GelatiereSuggestion[]
): GelatiereSuggestion[] {
  return suggestions.filter((s) => Boolean(s.takenAt));
}

/** Open suggestions created after `since` (all of them when `since` is absent). */
export function suggestionsSince(
  suggestions: readonly GelatiereSuggestion[],
  since: string | undefined
): GelatiereSuggestion[] {
  const open = openSuggestions(suggestions);
  if (!since) return open;
  const cutoff = Date.parse(since);
  if (Number.isNaN(cutoff)) return open;
  return open.filter((s) => {
    const created = Date.parse(s.createdAt);
    return Number.isNaN(created) || created > cutoff;
  });
}

/**
 * Stamp `dismissedAt` on one suggestion. Returns `false` when no open
 * suggestion carries that id — a stale card or a double click, not an error.
 */
export async function dismissGelatiereSuggestion(
  vfs: GelatiereVfs,
  id: string,
  now: Date = new Date()
): Promise<boolean> {
  return settleSuggestion(vfs, id, 'dismissedAt', now);
}

/**
 * Stamp `takenAt` on one suggestion — the user clicked "Install" or "Try it".
 * Same stale-card semantics as {@link dismissGelatiereSuggestion}.
 */
export async function takeGelatiereSuggestion(
  vfs: GelatiereVfs,
  id: string,
  now: Date = new Date()
): Promise<boolean> {
  return settleSuggestion(vfs, id, 'takenAt', now);
}

/**
 * Settlements are read-modify-write on one JSON file, and two card clicks in
 * the same tick (dismiss one, install another) are an ordinary user gesture —
 * unserialized, the second write clobbers the first. One module-level chain
 * keeps them in order; a failed settle must not wedge the chain.
 *
 * The chain is PER REALM: page-side clicks and the worker-side `gelatiere
 * dismiss` / `recordPass` each get their own module instance, so a click
 * landing exactly inside a pass's read-merge-write can still be lost. That
 * loss is rare (a pass takes minutes, the merge window is one microtask) and
 * self-healing — the card renders again and the user clicks again. A shared
 * cross-realm writer is not worth its wiring until that stops being true.
 */
let settleChain: Promise<unknown> = Promise.resolve();

function settleSuggestion(
  vfs: GelatiereVfs,
  id: string,
  field: 'dismissedAt' | 'takenAt',
  now: Date
): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    const suggestions = await readGelatiereSuggestions(vfs);
    const target = suggestions.find((s) => s.id === id && !s.dismissedAt && !s.takenAt);
    if (!target) return false;
    target[field] = now.toISOString();
    await writeGelatiereSuggestions(vfs, suggestions);
    return true;
  };
  const next = settleChain.then(run, run);
  settleChain = next.catch(() => false);
  return next;
}

// ─── Validation + merge ─────────────────────────────────────────────────────

const SLUG_RE = /[^a-z0-9]+/g;

function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(SLUG_RE, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/**
 * `url` is the one agent-authored field that renders as an ATTRIBUTE (the
 * suggestion card's "Read more" href), not text — and the pass recipe has the
 * unit read external catalogs, so a crafted `javascript:` URL could ride a
 * suggestion into a same-origin click. Only http(s) survives this boundary.
 */
function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const scheme = new URL(value).protocol;
    return scheme === 'http:' || scheme === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `install` is the one agent-authored field a cone EXECUTES — the `gelatiere`
 * skill tells it to run the command verbatim, with cone authority, after one
 * click — and the pass recipe has the unit read external catalogs, so a
 * prompt-injected catalog entry could otherwise ride a suggestion straight
 * into a shell. Only a plain `upskill` invocation survives this boundary:
 * `upskill` plus bare tokens (repo, `--path`, `--skill`, `--all`, …), no
 * shell metacharacters, no quoting, no substitution.
 */
const INSTALL_TOKEN_RE = /^[A-Za-z0-9@._/:=-]+$/;

function upskillInstall(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const tokens = value.split(/\s+/);
  if (tokens[0] !== 'upskill' || tokens.length < 2) return undefined;
  return tokens.slice(1).every((token) => INSTALL_TOKEN_RE.test(token)) ? value : undefined;
}

/** What the agent (or the store) may hand us before validation — every field unchecked. */
interface RawSuggestion {
  id?: unknown;
  kind?: unknown;
  title?: unknown;
  body?: unknown;
  skill?: unknown;
  install?: unknown;
  prompt?: unknown;
  url?: unknown;
  evidence?: unknown;
  createdAt?: unknown;
}

/**
 * One suggestion out of whatever the agent wrote, or `null` when the required
 * fields are missing. Ids are normalized to slugs — the store is what the
 * next pass and the dismiss path key on, so the agent's spelling must not
 * decide whether two passes agree. `createdAt` is the pass stamp and always
 * wins for fresh output; `null` means "reading the store back", where the
 * stored stamp is the truth.
 */
function coerceSuggestion(raw: unknown, createdAt: string | null): GelatiereSuggestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as RawSuggestion;
  const kind = typeof entry.kind === 'string' ? entry.kind : '';
  const title = optionalText(entry.title, 200);
  const body = optionalText(entry.body, 1_000);
  if (!SUGGESTION_KINDS.has(kind) || !title || !body) return null;
  const idSource = optionalText(entry.id, 80) ?? `${kind}-${title}`;
  const id = slugOf(idSource) || slugOf(`${kind}-${title}`);
  if (!id) return null;
  const stamp = createdAt ?? optionalText(entry.createdAt, 40) ?? '';
  const skill = entry.skill !== undefined ? optionalText(entry.skill, 120) : undefined;
  const install =
    entry.install !== undefined ? upskillInstall(optionalText(entry.install, 300)) : undefined;
  const prompt = entry.prompt !== undefined ? optionalText(entry.prompt, 1_000) : undefined;
  // The kind contract GELATIERE.md documents, enforced: a `skill` card renders
  // an Install button that runs `install` verbatim, so one without a validated
  // command (missing, or rejected above) would be an actionable card with
  // nothing behind it — stamped taken on click, then the cone finds no
  // command. A `use-case` is its prompt. Malformed candidates drop here.
  if (kind === 'skill' && (!skill || !install)) return null;
  if (kind === 'use-case' && !prompt) return null;
  return {
    id,
    kind: kind as GelatiereSuggestionKind,
    title,
    body,
    ...(entry.skill !== undefined ? { skill } : {}),
    ...(entry.install !== undefined ? { install } : {}),
    ...(entry.prompt !== undefined ? { prompt } : {}),
    ...(entry.url !== undefined ? { url: httpUrl(optionalText(entry.url, 500)) } : {}),
    ...(entry.evidence !== undefined ? { evidence: optionalText(entry.evidence, 500) } : {}),
    createdAt: stamp,
  };
}

/** Parse and validate a pass's candidates; invalid entries are dropped, never fatal. */
export function coerceSuggestions(
  raw: unknown,
  createdAt: string,
  limit: number = MAX_SUGGESTIONS_PER_PASS
): GelatiereSuggestion[] {
  const list = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === 'object' &&
        Array.isArray((raw as { suggestions?: unknown }).suggestions)
      ? ((raw as { suggestions: unknown[] }).suggestions ?? [])
      : [];
  const seen = new Set<string>();
  const out: GelatiereSuggestion[] = [];
  for (const entry of list) {
    const suggestion = coerceSuggestion(entry, createdAt);
    if (!suggestion || seen.has(suggestion.id)) continue;
    seen.add(suggestion.id);
    out.push(suggestion);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Fold a pass's suggestions into the store. An id that is already present —
 * open, taken or dismissed — keeps its existing entry (and its settlement
 * stamps), so a repeat pass cannot resurrect what the user already answered.
 * New entries go first; the oldest fall off past
 * {@link MAX_STORED_SUGGESTIONS}, settled ones (dismissed, then taken) first.
 */
export function mergeSuggestions(
  existing: readonly GelatiereSuggestion[],
  incoming: readonly GelatiereSuggestion[],
  maxStored: number = MAX_STORED_SUGGESTIONS
): { merged: GelatiereSuggestion[]; added: GelatiereSuggestion[] } {
  const known = new Set(existing.map((s) => s.id));
  const added = incoming.filter((s) => !known.has(s.id));
  const merged = [...added, ...existing];
  while (merged.length > maxStored) {
    const dismissedIndex = findLastIndex(merged, (s) => Boolean(s.dismissedAt));
    const settledIndex =
      dismissedIndex >= 0 ? dismissedIndex : findLastIndex(merged, (s) => Boolean(s.takenAt));
    merged.splice(settledIndex >= 0 ? settledIndex : merged.length - 1, 1);
  }
  return { merged, added };
}

function findLastIndex<T>(list: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (predicate(list[index])) return index;
  }
  return -1;
}

/**
 * Record a pass: validate `raw` (what the gelatiere wrote), merge it into the
 * store, stamp the ledger. Returns what was added and what is open now.
 */
export async function recordPass(
  vfs: GelatiereVfs,
  raw: unknown,
  now: Date = new Date()
): Promise<{ added: GelatiereSuggestion[]; open: GelatiereSuggestion[] }> {
  const config = await loadGelatiereConfig(vfs);
  const incoming = coerceSuggestions(raw, now.toISOString(), config.maxSuggestions);
  const existing = await readGelatiereSuggestions(vfs);
  const { merged, added } = mergeSuggestions(existing, incoming);
  await writeGelatiereSuggestions(vfs, merged);
  const state = await readGelatiereState(vfs);
  await writeGelatiereState(vfs, {
    ...state,
    passes: state.passes + 1,
    lastPassAt: now.toISOString(),
  });
  return { added, open: openSuggestions(merged) };
}

export function buildGelatiereLickBody(
  added: readonly GelatiereSuggestion[],
  open: readonly GelatiereSuggestion[]
): GelatiereLickBody {
  return {
    action: GELATIERE_SUGGESTIONS_ACTION,
    data: {
      added: added.length,
      open: open.length,
      suggestions: open.slice(0, LICK_SUGGESTION_LIMIT),
      path: GELATIERE_SUGGESTIONS_PATH,
      skill: GELATIERE_SKILL_PATH,
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── Rendering help ─────────────────────────────────────────────────────────

/** What a gelatiere lick says, for the transcript card — never the raw JSON. */
export interface GelatiereLickDescription {
  action: string;
  /** One-line headline for the card body. */
  headline: string;
  /** Suggestion titles (delivery licks only). */
  titles: string[];
}

/**
 * Describe a `[Sprinkle Event: gelatiere]` message body (the formatted lick
 * content, JSON fence included) for the lick card. Returns `null` for
 * anything that is not a gelatiere lick with a readable body, so the caller
 * falls back to the generic rendering.
 */
export function describeGelatiereLick(content: string): GelatiereLickDescription | null {
  const parsed = parseGelatiereLickBody(content);
  if (!parsed) return null;
  const { action, bag } = parsed;
  if (action === GELATIERE_SUGGESTIONS_ACTION) return describeSuggestionsLick(action, bag);
  if (action === 'session-settled') return describeSessionSettledLick(action, bag);
  if (action === 'run') return describeRunLick(action, bag);
  return { action, headline: `gelatiere: ${action}`, titles: [] };
}

/** Extract `{ action, data }` from the lick body's embedded JSON, if readable. */
function parseGelatiereLickBody(
  content: string
): { action: string; bag: GelatiereLickData } | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { action, data } = parsed as { action?: unknown; data?: unknown };
  if (typeof action !== 'string') return null;
  const bag = data && typeof data === 'object' ? (data as GelatiereLickData) : {};
  return { action, bag };
}

function describeSuggestionsLick(action: string, bag: GelatiereLickData): GelatiereLickDescription {
  const titles = suggestionTitles(bag.suggestions);
  const added = typeof bag.added === 'number' ? bag.added : titles.length;
  const open = typeof bag.open === 'number' ? bag.open : titles.length;
  const headline =
    added === 0
      ? `Nothing new — ${open} open ${open === 1 ? 'suggestion' : 'suggestions'} in the suggestions card.`
      : `${added} new ${added === 1 ? 'suggestion' : 'suggestions'} (${open} open) — the cards are in the suggestions sprinkle.`;
  return { action, headline, titles };
}

function suggestionTitles(suggestions: unknown): string[] {
  if (!Array.isArray(suggestions)) return [];
  return suggestions
    .map((s) => (s && typeof s === 'object' ? (s as { title?: unknown }).title : undefined))
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
}

function describeSessionSettledLick(
  action: string,
  bag: GelatiereLickData
): GelatiereLickDescription {
  const cone = typeof bag.cone === 'string' ? bag.cone : undefined;
  return {
    action,
    headline: cone
      ? `A session ended in ${cone} — time for a pass.`
      : 'A session ended — time for a pass.',
    titles: [],
  };
}

function describeRunLick(action: string, bag: GelatiereLickData): GelatiereLickDescription {
  const by = typeof bag.requestedBy === 'string' ? bag.requestedBy : undefined;
  return {
    action,
    headline: by ? `${by} asked for a pass now.` : 'Someone asked for a pass now.',
    titles: [],
  };
}

/** The loosely-typed `data` bag of a gelatiere lick as it arrives off the wire. */
interface GelatiereLickData {
  added?: unknown;
  open?: unknown;
  suggestions?: unknown;
  cone?: unknown;
  requestedBy?: unknown;
}
