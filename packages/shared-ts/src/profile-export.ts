/**
 * `slicc-profile` v1: the SLICC 6 → SLICC 7 profile export contract.
 *
 * Six writes it (webapp `transcript/profile-export.ts`); seven's
 * `freezer import` (ai-ecoverse/slicc-agent) reads it. Seven keeps a copy of
 * these validators because shared-ts is not published, and both repos check
 * in the same fixture zip (`packages/webapp/tests/fixtures/slicc6-profile-v1.zip`
 * here, `test/integration/fixtures/` there). Format: `docs/profile-export.md`.
 *
 * Container: ZIP32, stored (method 0), UTF-8 names, no directory entries, no
 * extra fields, external attributes 0. `manifest.json` is always entry 0;
 * every other entry is listed in `manifest.files[]`.
 */

export const SLICC_PROFILE_FORMAT = 'slicc-profile' as const;
export const SLICC_PROFILE_VERSION = 1 as const;
export const PROFILE_MANIFEST_PATH = 'manifest.json' as const;

/** One archive's ceiling: ZIP32 offsets stay far from 4 GiB, and seven refuses more. */
export const PROFILE_MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
/** One archive's entry ceiling (ZIP32 counts entries in a uint16). */
export const PROFILE_MAX_ARCHIVE_ENTRIES = 60_000;
/** Largest single file the exporter includes; seven refuses anything bigger. */
export const PROFILE_MAX_FILE_BYTES = 256 * 1024 * 1024;
/** Text files up to this size pass the redactor; larger ones are stored as-is. */
export const PROFILE_MAX_REDACTED_TEXT_BYTES = 1024 * 1024;

/** The folder rule both sides share for cone and scoop folders. */
export const PROFILE_FOLDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type ProfileSkipReason =
  | 'mount'
  | 'cache'
  | 'bundled'
  | 'secret'
  | 'too-large'
  | 'unreadable'
  | 'archive-limit';

export const PROFILE_SKIP_REASONS: readonly ProfileSkipReason[] = [
  'mount',
  'cache',
  'bundled',
  'secret',
  'too-large',
  'unreadable',
  'archive-limit',
];

export type ProfileFlagRule = 'env' | 'pem' | 'git-credentials' | 'npmrc' | 'slicc-oauth';

export const PROFILE_FLAG_RULES: readonly ProfileFlagRule[] = [
  'env',
  'pem',
  'git-credentials',
  'npmrc',
  'slicc-oauth',
];

/** What six had that never moves; the import report names each one. */
export type ProfileSecretKind = 'secrets-env' | 'github-token' | 'mcp-tokens' | 'chrome-storage';

export const PROFILE_SECRET_KINDS: readonly ProfileSecretKind[] = [
  'secrets-env',
  'github-token',
  'mcp-tokens',
  'chrome-storage',
];

export interface ProfileScoopEntry {
  /** Six conversation key (`<workspace>::<jid>`), seven's idempotency key. */
  key: string;
  folder: string;
  name: string;
  /** `TranscriptConversation.id` inside the owning cone's transcript, or null. */
  conversation: string | null;
  /** `files/scoops/<folder>/` when the scoop workspace has files, else null. */
  files: string | null;
}

export interface ProfileConeEntry {
  key: string;
  folder: string;
  name: string;
  /** `transcripts/<folder>.json`, or null when the cone had no transcript. */
  transcript: string | null;
  conversation: string | null;
  /** `files/cones/<folder>/` when the workspace has files, else null. */
  files: string | null;
  /** `memory/<folder>.md`, or null. */
  memory: string | null;
  scoops: ProfileScoopEntry[];
}

export interface ProfileFrozenEntry {
  id: string;
  title: string;
  frozenAt: string | null;
  /** `frozen/<safeId>.json`. */
  transcript: string;
}

export interface ProfileNamedPath {
  name: string;
  /** Directory prefix inside the zip, ending in `/`. */
  path: string;
}

export interface ProfileFileEntry {
  path: string;
  size: number;
  /** Lowercase hex SHA-256 of the stored bytes. */
  sha256: string;
}

export interface ProfileSkippedEntry {
  /** Six VFS path (or `/mnt/<name>` for a mount). */
  path: string;
  reason: ProfileSkipReason;
}

export interface ProfileFlaggedEntry {
  /** Zip entry path. */
  path: string;
  size: number;
  rule: ProfileFlagRule;
}

export interface ProfileMcpServer {
  name: string;
  url: string;
}

export interface ProfileTotals {
  cones: number;
  scoops: number;
  frozen: number;
  /** Workspace / home files (`files/...`). */
  files: number;
  /** Sum of every entry's stored bytes, the manifest excluded. */
  bytes: number;
  /** Entries in this archive, the manifest included. */
  entries: number;
  attachments: number;
  skills: number;
  sprinkles: number;
  crontasks: number;
  tasks: number;
  webhooks: number;
  flagged: number;
}

export interface SliccProfileManifestV1 {
  format: typeof SLICC_PROFILE_FORMAT;
  version: typeof SLICC_PROFILE_VERSION;
  /** UUID; the same across every part of one export. */
  exportId: string;
  producer: { slicc: string; origin: string };
  createdAt: string;
  /** Present only when the export was split; `index` is 1-based. */
  part?: { index: number; of: number };
  cones: ProfileConeEntry[];
  frozen: ProfileFrozenEntry[];
  skills: ProfileNamedPath[];
  sprinkles: ProfileNamedPath[];
  /** `licks.json`, or null. */
  licks: string | null;
  /** `git/gitconfig` (the `[user]` section only), or null. */
  gitconfig: string | null;
  files: ProfileFileEntry[];
  skipped: ProfileSkippedEntry[];
  flagged: ProfileFlaggedEntry[];
  /** Provider ids six had accounts for. Names only, never keys or tokens. */
  providers: string[];
  mcp: ProfileMcpServer[];
  secrets: ProfileSecretKind[];
  redactionCounts: { [category: string]: number };
  totals: ProfileTotals;
}

// ---------------------------------------------------------------------------
// Credential-like files (G6)
// ---------------------------------------------------------------------------

/**
 * The flag rule a path matches, or null. Matched on the basename, except
 * `slicc-oauth`, which is any file below a `.slicc/oauth/` segment. Flagged
 * files are stored byte for byte (a redacted `.env` would be useless) and
 * listed in `manifest.flagged[]`.
 */
export function profileFlagRuleFor(path: string): ProfileFlagRule | null {
  const segments = path.split('/').filter((s) => s.length > 0);
  const base = segments[segments.length - 1] ?? '';
  for (let i = 0; i + 2 < segments.length; i++) {
    if (segments[i] === '.slicc' && segments[i + 1] === 'oauth') return 'slicc-oauth';
  }
  if (base === '.env' || base.startsWith('.env.')) return 'env';
  if (base.toLowerCase().endsWith('.pem')) return 'pem';
  if (base === '.git-credentials') return 'git-credentials';
  if (base === '.npmrc') return 'npmrc';
  return null;
}

/** The archive filename for a date and an optional part. */
export function profileArchiveFilename(
  createdAt: string,
  part?: { index: number; of: number }
): string {
  const date = createdAt.slice(0, 10);
  return part
    ? `slicc6-profile-${date}-part${part.index}of${part.of}.zip`
    : `slicc6-profile-${date}.zip`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ProfileValidationResult = { ok: true } | { ok: false; error: string };

const SHA256_HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DRIVE_LETTER = /^[A-Za-z]:/;

/**
 * True for a zip entry name both sides accept: relative, `/`-separated, no
 * `.`/`..`/empty segment, no backslash, NUL or drive letter.
 */
export function isSafeProfileEntryPath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/')) return false;
  if (path.includes('\\') || path.includes('\0') || DRIVE_LETTER.test(path)) return false;
  return path.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

type Obj = { [key: string]: unknown };

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(error: string): ProfileValidationResult {
  return { ok: false, error };
}

const OK: ProfileValidationResult = { ok: true };

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function checkEach(
  value: unknown,
  label: string,
  check: (item: unknown, path: string) => ProfileValidationResult
): ProfileValidationResult {
  if (!Array.isArray(value)) return fail(`${label} must be an array`);
  for (let i = 0; i < value.length; i++) {
    const result = check(value[i], `${label}[${i}]`);
    if (!result.ok) return result;
  }
  return OK;
}

function checkStrings(item: Obj, path: string, fields: readonly string[]): ProfileValidationResult {
  for (const field of fields) {
    if (typeof item[field] !== 'string') return fail(`${path}.${field} must be a string`);
  }
  return OK;
}

function checkNullableStrings(
  item: Obj,
  path: string,
  fields: readonly string[]
): ProfileValidationResult {
  for (const field of fields) {
    if (!isNullableString(item[field])) return fail(`${path}.${field} must be a string or null`);
  }
  return OK;
}

function checkFolder(value: unknown, path: string): ProfileValidationResult {
  if (typeof value !== 'string' || !PROFILE_FOLDER_PATTERN.test(value)) {
    return fail(`${path}.folder must match ${PROFILE_FOLDER_PATTERN.source}`);
  }
  return OK;
}

function checkScoop(item: unknown, path: string): ProfileValidationResult {
  if (!isObj(item)) return fail(`${path} must be an object`);
  const strings = checkStrings(item, path, ['key', 'name']);
  if (!strings.ok) return strings;
  const folder = checkFolder(item['folder'], path);
  if (!folder.ok) return folder;
  return checkNullableStrings(item, path, ['conversation', 'files']);
}

function checkCone(item: unknown, path: string): ProfileValidationResult {
  if (!isObj(item)) return fail(`${path} must be an object`);
  const strings = checkStrings(item, path, ['key', 'name']);
  if (!strings.ok) return strings;
  const folder = checkFolder(item['folder'], path);
  if (!folder.ok) return folder;
  const nullable = checkNullableStrings(item, path, [
    'transcript',
    'conversation',
    'files',
    'memory',
  ]);
  if (!nullable.ok) return nullable;
  return checkEach(item['scoops'], `${path}.scoops`, checkScoop);
}

function checkFrozen(item: unknown, path: string): ProfileValidationResult {
  if (!isObj(item)) return fail(`${path} must be an object`);
  const strings = checkStrings(item, path, ['id', 'title', 'transcript']);
  if (!strings.ok) return strings;
  return checkNullableStrings(item, path, ['frozenAt']);
}

function checkNamedPath(item: unknown, path: string): ProfileValidationResult {
  if (!isObj(item)) return fail(`${path} must be an object`);
  const strings = checkStrings(item, path, ['name', 'path']);
  if (!strings.ok) return strings;
  return String(item['path']).endsWith('/') ? OK : fail(`${path}.path must end in "/"`);
}

function checkFile(item: unknown, path: string): ProfileValidationResult {
  if (!isObj(item)) return fail(`${path} must be an object`);
  const name = item['path'];
  if (typeof name !== 'string' || !isSafeProfileEntryPath(name)) {
    return fail(`${path}.path must be a safe relative entry path`);
  }
  if (name === PROFILE_MANIFEST_PATH) return fail(`${path}.path must not be the manifest`);
  if (!isCount(item['size'])) return fail(`${path}.size must be a non-negative integer`);
  if (typeof item['sha256'] !== 'string' || !SHA256_HEX.test(item['sha256'])) {
    return fail(`${path}.sha256 must be 64 lowercase hex characters`);
  }
  return OK;
}

function checkSkipped(item: unknown, path: string): ProfileValidationResult {
  if (!isObj(item) || typeof item['path'] !== 'string') {
    return fail(`${path}.path must be a string`);
  }
  return PROFILE_SKIP_REASONS.includes(item['reason'] as ProfileSkipReason)
    ? OK
    : fail(`${path}.reason must be one of ${PROFILE_SKIP_REASONS.join(', ')}`);
}

function checkFlagged(item: unknown, path: string): ProfileValidationResult {
  if (!isObj(item) || typeof item['path'] !== 'string') {
    return fail(`${path}.path must be a string`);
  }
  if (!isCount(item['size'])) return fail(`${path}.size must be a non-negative integer`);
  return PROFILE_FLAG_RULES.includes(item['rule'] as ProfileFlagRule)
    ? OK
    : fail(`${path}.rule must be one of ${PROFILE_FLAG_RULES.join(', ')}`);
}

function checkMcp(item: unknown, path: string): ProfileValidationResult {
  if (!isObj(item)) return fail(`${path} must be an object`);
  return checkStrings(item, path, ['name', 'url']);
}

function checkString(item: unknown, path: string): ProfileValidationResult {
  return typeof item === 'string' ? OK : fail(`${path} must be a string`);
}

function checkSecretKind(item: unknown, path: string): ProfileValidationResult {
  return PROFILE_SECRET_KINDS.includes(item as ProfileSecretKind)
    ? OK
    : fail(`${path} must be one of ${PROFILE_SECRET_KINDS.join(', ')}`);
}

const TOTAL_FIELDS: readonly (keyof ProfileTotals)[] = [
  'cones',
  'scoops',
  'frozen',
  'files',
  'bytes',
  'entries',
  'attachments',
  'skills',
  'sprinkles',
  'crontasks',
  'tasks',
  'webhooks',
  'flagged',
];

function checkHeader(m: Obj): ProfileValidationResult {
  if (m['format'] !== SLICC_PROFILE_FORMAT) return fail(`format must be "${SLICC_PROFILE_FORMAT}"`);
  if (m['version'] !== SLICC_PROFILE_VERSION)
    return fail(`version must be ${SLICC_PROFILE_VERSION}`);
  if (typeof m['exportId'] !== 'string' || !UUID.test(m['exportId'])) {
    return fail('exportId must be a lowercase UUID');
  }
  const producer = m['producer'];
  if (!isObj(producer)) return fail('producer must be an object');
  const producerStrings = checkStrings(producer, 'producer', ['slicc', 'origin']);
  if (!producerStrings.ok) return producerStrings;
  if (typeof m['createdAt'] !== 'string' || Number.isNaN(Date.parse(m['createdAt']))) {
    return fail('createdAt must be an ISO 8601 date-time string');
  }
  const part = m['part'];
  if (part !== undefined) {
    if (!isObj(part) || !isCount(part['index']) || !isCount(part['of'])) {
      return fail('part must be { index, of } with integer fields');
    }
    if (part['index'] < 1 || part['index'] > part['of']) {
      return fail('part.index must be between 1 and part.of');
    }
  }
  return checkNullableStrings(m, 'manifest', ['licks', 'gitconfig']);
}

function checkTotals(m: Obj): ProfileValidationResult {
  const totals = m['totals'];
  if (!isObj(totals)) return fail('totals must be an object');
  for (const field of TOTAL_FIELDS) {
    if (!isCount(totals[field])) return fail(`totals.${field} must be a non-negative integer`);
  }
  const counts = m['redactionCounts'];
  if (!isObj(counts)) return fail('redactionCounts must be an object');
  for (const [key, value] of Object.entries(counts)) {
    if (!isCount(value)) return fail(`redactionCounts.${key} must be a non-negative integer`);
  }
  return OK;
}

/** Every path the manifest points at must be an entry it lists. */
function checkReferences(m: SliccProfileManifestV1): ProfileValidationResult {
  const paths = new Set<string>();
  for (const file of m.files) {
    if (paths.has(file.path)) return fail(`files lists "${file.path}" twice`);
    paths.add(file.path);
  }
  const hasPrefix = (prefix: string): boolean => {
    for (const p of paths) if (p.startsWith(prefix)) return true;
    return false;
  };
  const exact: (string | null)[] = [m.licks, m.gitconfig];
  const prefixes: (string | null)[] = [];
  for (const cone of m.cones) {
    exact.push(cone.transcript, cone.memory);
    prefixes.push(cone.files, ...cone.scoops.map((s) => s.files));
  }
  for (const frozen of m.frozen) exact.push(frozen.transcript);
  for (const named of [...m.skills, ...m.sprinkles]) prefixes.push(named.path);
  for (const ref of exact) {
    if (ref !== null && !paths.has(ref)) return fail(`"${ref}" is not listed in files`);
  }
  for (const ref of prefixes) {
    if (ref !== null && !hasPrefix(ref)) return fail(`no entry in files lies under "${ref}"`);
  }
  for (const flagged of m.flagged) {
    if (!paths.has(flagged.path)) return fail(`flagged "${flagged.path}" is not listed in files`);
  }
  return OK;
}

/**
 * Validate a parsed `manifest.json`. Checks the shape, the enums, the entry
 * paths, and that every path the manifest references is an entry it lists.
 * It does not read the archive: matching entries to `files[]` and checking
 * their SHA-256 is the reader's job.
 */
export function validateSliccProfileManifestV1(value: unknown): ProfileValidationResult {
  if (!isObj(value)) return fail('manifest must be an object');
  const steps: (() => ProfileValidationResult)[] = [
    () => checkHeader(value),
    () => checkEach(value['cones'], 'cones', checkCone),
    () => checkEach(value['frozen'], 'frozen', checkFrozen),
    () => checkEach(value['skills'], 'skills', checkNamedPath),
    () => checkEach(value['sprinkles'], 'sprinkles', checkNamedPath),
    () => checkEach(value['files'], 'files', checkFile),
    () => checkEach(value['skipped'], 'skipped', checkSkipped),
    () => checkEach(value['flagged'], 'flagged', checkFlagged),
    () => checkEach(value['providers'], 'providers', checkString),
    () => checkEach(value['mcp'], 'mcp', checkMcp),
    () => checkEach(value['secrets'], 'secrets', checkSecretKind),
    () => checkTotals(value),
    () => checkReferences(value as unknown as SliccProfileManifestV1),
  ];
  for (const step of steps) {
    const result = step();
    if (!result.ok) return result;
  }
  return OK;
}
