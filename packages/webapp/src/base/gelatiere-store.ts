import DEFAULT_GELATIERE_MD from '../../../vfs-root/shared/GELATIERE.md?raw';
import { FsError } from '../fs/types.js';
import {
  type FrontmatterValue,
  parseFrontmatter,
  readArray,
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

export const GELATIERE_SUGGESTIONS_ACTION = 'gelatiere-suggestions';

export const GELATIERE_SKILL_PATH = '/workspace/skills/gelatiere/SKILL.md';
export const DEFAULT_GELATIERE_NIGHTLY_CRON = '0 3 * * *';
export const DEFAULT_GELATIERE_INTERVAL_HOURS = 24;
export const DEFAULT_MAX_SUGGESTIONS = 5;

export const MAX_SUGGESTIONS_PER_PASS = 10;

export const MAX_STORED_SUGGESTIONS = 40;

export const LICK_SUGGESTION_LIMIT = 5;

const MAX_SUGGESTION_CONES = 8;

const GELATIERE_FRONTMATTER = {
  arrayKeys: new Set(['allowedCommands']),
  scalarKeys: new Set(['intervalHours', 'nightly', 'maxSuggestions']),
};

export const GELATIERE_BASE_ALLOWED_COMMANDS = [
  'awk',
  'basename',
  'cat',
  'column',

  'cut',
  'date',
  'dirname',
  'echo',
  'expr',
  'false',
  'file',
  'find',

  'fold',
  'gelatiere',
  'grep',
  'head',
  'jq',
  'ls',
  'man',

  'memory',
  'mkdir',
  'nl',
  'paste',
  'printf',
  'realpath',
  'rg',
  'sed',
  'seq',
  'sort',
  'stat',
  'tail',
  'tee',
  'test',
  'touch',
  'tr',
  'true',
  'uniq',
  'upskill',
  'wc',
];

const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type GelatiereSuggestionKind = 'skill' | 'use-case' | 'tip' | 'skill-idea' | 'issue';
const SUGGESTION_KINDS: ReadonlySet<string> = new Set([
  'skill',
  'use-case',
  'tip',
  'skill-idea',
  'issue',
]);

const PROMPT_KINDS: ReadonlySet<string> = new Set(['use-case', 'skill-idea', 'issue']);

export interface GelatiereSuggestion {
  id: string;
  kind: GelatiereSuggestionKind;
  title: string;
  body: string;

  skill?: string;

  install?: string;

  prompt?: string;
  url?: string;

  evidence?: string;

  cones?: string[];

  retargets?: GelatiereRetarget[];

  createdAt: string;

  dismissedAt?: string;

  takenAt?: string;
}

export interface GelatiereRetarget {
  cone: string;
  at: string;
}

export interface GelatiereState {
  lastPassAt?: string;

  lastTriggeredAt?: string;

  lastDeliveredAt?: string;

  passes: number;
}

export interface GelatiereConfig {
  intervalHours: number;

  nightly: string;
  maxSuggestions: number;

  allowedCommands: string[];

  instructions: string;
}

export interface GelatiereVfs {
  readFile(path: string, options?: { encoding?: 'utf-8' }): Promise<string | Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface GelatiereLickBody {
  action: typeof GELATIERE_SUGGESTIONS_ACTION;
  data: {
    added: number;

    open: number;

    suggestions: GelatiereSuggestion[];

    path: string;

    skill: string;
  };
}

export function parseGelatiereDocument(content: string): GelatiereConfig {
  const document = splitInstructionDocument(content, 'GELATIERE.md');
  const values = parseFrontmatter(document.frontmatter, GELATIERE_FRONTMATTER);
  const nightly = readOptionalString(values.nightly, 'nightly') ?? DEFAULT_GELATIERE_NIGHTLY_CRON;
  if (nightly.trim().split(/\s+/).length !== 5) {
    throw new Error('nightly must be a 5-field cron expression');
  }
  return {
    allowedCommands: readAllowedCommands(values),
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

function readAllowedCommands(values: Record<string, FrontmatterValue>): string[] {
  const extra = readArray(values, 'allowedCommands', []);
  const bad = extra.find((command) => !COMMAND_NAME.test(command));
  if (bad !== undefined) {
    throw new Error(`allowedCommands must contain bare command names, not "${bad}"`);
  }
  return [...new Set([...GELATIERE_BASE_ALLOWED_COMMANDS, ...extra])];
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

async function readText(vfs: Pick<GelatiereVfs, 'readFile'>, path: string): Promise<string> {
  const raw = await vfs.readFile(path, { encoding: 'utf-8' });
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

async function readJson(vfs: Pick<GelatiereVfs, 'readFile'>, path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readText(vfs, path);
  } catch (err) {
    if (err instanceof FsError && err.code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function readGelatiereSuggestions(
  vfs: Pick<GelatiereVfs, 'readFile'>
): Promise<GelatiereSuggestion[]> {
  const parsed = await readJson(vfs, GELATIERE_SUGGESTIONS_PATH);
  if (!Array.isArray(parsed)) return [];
  const kept: GelatiereSuggestion[] = [];
  for (const entry of parsed) {
    const suggestion = coerceSuggestion(entry, null);
    if (!suggestion) continue;
    const { dismissedAt, takenAt, retargets } = entry as {
      dismissedAt?: unknown;
      takenAt?: unknown;
      retargets?: unknown;
    };
    if (typeof dismissedAt === 'string' && dismissedAt) suggestion.dismissedAt = dismissedAt;
    if (typeof takenAt === 'string' && takenAt) suggestion.takenAt = takenAt;
    const widened = storedRetargets(retargets);
    if (widened.length > 0) suggestion.retargets = widened;
    kept.push(suggestion);
  }
  return kept;
}

function storedRetargets(value: unknown): GelatiereRetarget[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is GelatiereRetarget =>
      Boolean(r) &&
      typeof (r as GelatiereRetarget).cone === 'string' &&
      typeof (r as GelatiereRetarget).at === 'string'
  );
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

export function isPassDue(state: GelatiereState, now: Date, intervalHours: number): boolean {
  const newest = Math.max(
    ...[state.lastPassAt, state.lastTriggeredAt]
      .map((stamp) => (stamp ? Date.parse(stamp) : Number.NaN))
      .filter((parsed) => !Number.isNaN(parsed))
  );
  if (!Number.isFinite(newest)) return true;
  return now.getTime() - newest >= intervalHours * 3_600_000;
}

export async function recordGelatiereTrigger(
  vfs: GelatiereVfs,
  now: Date = new Date()
): Promise<void> {
  const state = await readGelatiereState(vfs);
  await writeGelatiereState(vfs, { ...state, lastTriggeredAt: now.toISOString() });
}

export function openSuggestions(
  suggestions: readonly GelatiereSuggestion[]
): GelatiereSuggestion[] {
  return suggestions.filter((s) => !s.dismissedAt && !s.takenAt);
}

export function takenSuggestions(
  suggestions: readonly GelatiereSuggestion[]
): GelatiereSuggestion[] {
  return suggestions.filter((s) => Boolean(s.takenAt));
}

export function suggestionsSince(
  suggestions: readonly GelatiereSuggestion[],
  since: string | undefined
): GelatiereSuggestion[] {
  return openSuggestions(suggestions).filter((s) => isNewSince(s, since));
}

export function isNewSince(
  suggestion: GelatiereSuggestion,
  since: string | undefined,
  cone?: string
): boolean {
  const cutoff = since ? Date.parse(since) : Number.NaN;
  if (Number.isNaN(cutoff)) return true;
  const after = (stamp: string): boolean => {
    const parsed = Date.parse(stamp);
    return Number.isNaN(parsed) || parsed > cutoff;
  };
  if (after(suggestion.createdAt)) return true;
  return (suggestion.retargets ?? []).some(
    (r) => (cone === undefined || r.cone === cone) && after(r.at)
  );
}

export function suggestionsForCone(
  suggestions: readonly GelatiereSuggestion[],
  folder: string,
  primary: string,
  known: ReadonlySet<string>
): GelatiereSuggestion[] {
  return suggestions.filter((s) => {
    const live = s.cones?.filter((cone) => known.has(cone)) ?? [];
    return live.length > 0 ? live.includes(folder) : folder === primary;
  });
}

export async function dismissGelatiereSuggestion(
  vfs: GelatiereVfs,
  id: string,
  now: Date = new Date()
): Promise<boolean> {
  return settleSuggestion(vfs, id, 'dismissedAt', now);
}

export async function takeGelatiereSuggestion(
  vfs: GelatiereVfs,
  id: string,
  now: Date = new Date()
): Promise<boolean> {
  return settleSuggestion(vfs, id, 'takenAt', now);
}

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

function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const scheme = new URL(value).protocol;
    return scheme === 'http:' || scheme === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

const INSTALL_TOKEN_RE = /^[A-Za-z0-9@._/:=-]+$/;

function upskillInstall(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const tokens = value.split(/\s+/);
  if (tokens[0] !== 'upskill' || tokens.length < 2) return undefined;
  return tokens.slice(1).every((token) => INSTALL_TOKEN_RE.test(token)) ? value : undefined;
}

const CONE_FOLDER_RE = /^[a-z0-9][a-z0-9_-]*$/i;

function coneFolders(value: unknown): string[] | undefined {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  const folders = list
    .map((entry) => optionalText(entry, 80))
    .filter((entry): entry is string => entry !== undefined && CONE_FOLDER_RE.test(entry));
  const unique = [...new Set(folders)].slice(0, MAX_SUGGESTION_CONES);
  return unique.length > 0 ? unique : undefined;
}

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
  cones?: unknown;
  createdAt?: unknown;
}

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

  if (kind === 'skill' && (!skill || !install)) return null;
  if (PROMPT_KINDS.has(kind) && !prompt) return null;
  const cones = coneFolders(entry.cones);
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
    ...(cones ? { cones } : {}),
    createdAt: stamp,
  };
}

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

export function mergeSuggestions(
  existing: readonly GelatiereSuggestion[],
  incoming: readonly GelatiereSuggestion[],
  maxStored: number = MAX_STORED_SUGGESTIONS
): { merged: GelatiereSuggestion[]; added: GelatiereSuggestion[] } {
  const byId = new Map(incoming.map((s) => [s.id, s]));
  const known = new Set(existing.map((s) => s.id));
  const added = incoming.filter((s) => !known.has(s.id));
  const merged = [...added, ...existing.map((s) => widenCones(s, byId.get(s.id)))];
  while (merged.length > maxStored) {
    const dismissedIndex = findLastIndex(merged, (s) => Boolean(s.dismissedAt));
    const settledIndex =
      dismissedIndex >= 0 ? dismissedIndex : findLastIndex(merged, (s) => Boolean(s.takenAt));
    merged.splice(settledIndex >= 0 ? settledIndex : merged.length - 1, 1);
  }
  return { merged, added };
}

function widenCones(
  stored: GelatiereSuggestion,
  repeat: GelatiereSuggestion | undefined
): GelatiereSuggestion {
  if (!repeat?.cones || stored.dismissedAt || stored.takenAt) return stored;
  const have = stored.cones ?? [];
  const fresh = repeat.cones.filter((cone) => !have.includes(cone));
  const cones = [...have, ...fresh].slice(0, MAX_SUGGESTION_CONES);
  const joined = fresh.filter((cone) => cones.includes(cone));
  if (joined.length === 0) return stored;
  const retargets = [
    ...(stored.retargets ?? []),
    ...joined.map((cone) => ({ cone, at: repeat.createdAt })),
  ];
  return { ...stored, cones, retargets };
}

function findLastIndex<T>(list: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (predicate(list[index])) return index;
  }
  return -1;
}

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

export interface GelatiereLickDescription {
  action: string;

  headline: string;

  titles: string[];
}

export function describeGelatiereLick(content: string): GelatiereLickDescription | null {
  const parsed = parseGelatiereLickBody(content);
  if (!parsed) return null;
  const { action, bag } = parsed;
  if (action === GELATIERE_SUGGESTIONS_ACTION) return describeSuggestionsLick(action, bag);
  if (action === 'session-settled') return describeSessionSettledLick(action, bag);
  if (action === 'run') return describeRunLick(action, bag);
  return { action, headline: `gelatiere: ${action}`, titles: [] };
}

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

interface GelatiereLickData {
  added?: unknown;
  open?: unknown;
  suggestions?: unknown;
  cone?: unknown;
  requestedBy?: unknown;
}
