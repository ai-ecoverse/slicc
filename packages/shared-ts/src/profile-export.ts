export const SLICC_PROFILE_FORMAT = 'slicc-profile' as const;
export const SLICC_PROFILE_VERSION = 1 as const;

export const SLICC_PROFILE_DIRECTORY_VERSION = 2 as const;
export const PROFILE_MANIFEST_PATH = 'manifest.json' as const;

export const PROFILE_DIRECTORY_ROOT = '/slicc-v6-upgrade/' as const;

export const PROFILE_SOURCE_ROOT = '/slicc-fs/' as const;

export const PROFILE_SOURCE_SIDECAR = '/slicc-fs/.metadata.json' as const;

export const PROFILE_SOURCE_PREFIXES: readonly string[] = ['files/', 'skills/', 'sprinkles/'];

export const PROFILE_MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

export const PROFILE_MAX_ARCHIVE_ENTRIES = 60_000;

export const PROFILE_MAX_FILE_BYTES = 256 * 1024 * 1024;

export const PROFILE_MAX_REDACTED_TEXT_BYTES = 1024 * 1024;

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

export type ProfileSecretKind = 'secrets-env' | 'github-token' | 'mcp-tokens' | 'chrome-storage';

export const PROFILE_SECRET_KINDS: readonly ProfileSecretKind[] = [
  'secrets-env',
  'github-token',
  'mcp-tokens',
  'chrome-storage',
];

export interface ProfileScoopEntry {
  key: string;
  folder: string;
  name: string;

  conversation: string | null;

  files: string | null;
}

export interface ProfileConeEntry {
  key: string;
  folder: string;
  name: string;

  transcript: string | null;
  conversation: string | null;

  files: string | null;

  memory: string | null;
  scoops: ProfileScoopEntry[];
}

export interface ProfileFrozenEntry {
  id: string;
  title: string;
  frozenAt: string | null;

  transcript: string;
}

export interface ProfileNamedPath {
  name: string;

  path: string;
}

export interface ProfileFileEntry {
  path: string;
  size: number;

  sha256: string;
}

export interface ProfileFileEntryV2 extends ProfileFileEntry {
  source?: string;
}

export interface ProfileSkippedEntry {
  path: string;
  reason: ProfileSkipReason;
}

export interface ProfileFlaggedEntry {
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

  files: number;

  bytes: number;

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

  exportId: string;
  producer: { slicc: string; origin: string };
  createdAt: string;

  part?: { index: number; of: number };
  cones: ProfileConeEntry[];
  frozen: ProfileFrozenEntry[];
  skills: ProfileNamedPath[];
  sprinkles: ProfileNamedPath[];

  licks: string | null;

  gitconfig: string | null;
  files: ProfileFileEntry[];
  skipped: ProfileSkippedEntry[];
  flagged: ProfileFlaggedEntry[];

  providers: string[];
  mcp: ProfileMcpServer[];
  secrets: ProfileSecretKind[];
  redactionCounts: { [category: string]: number };
  totals: ProfileTotals;
}

export interface SliccProfileManifestV2
  extends Omit<SliccProfileManifestV1, 'version' | 'part' | 'files'> {
  version: typeof SLICC_PROFILE_DIRECTORY_VERSION;

  files: ProfileFileEntryV2[];
}

export type SliccProfileManifest = SliccProfileManifestV1 | SliccProfileManifestV2;

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

export function profileArchiveFilename(
  createdAt: string,
  part?: { index: number; of: number }
): string {
  const date = createdAt.slice(0, 10);
  return part
    ? `slicc6-profile-${date}-part${part.index}of${part.of}.zip`
    : `slicc6-profile-${date}.zip`;
}

export type ProfileValidationResult = { ok: true } | { ok: false; error: string };

const SHA256_HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DRIVE_LETTER = /^[A-Za-z]:/;

export function isSafeProfileEntryPath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/')) return false;
  if (path.includes('\\') || path.includes('\0') || DRIVE_LETTER.test(path)) return false;
  return path.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

export function isSafeProfileSourcePath(path: string): boolean {
  if (!path.startsWith(PROFILE_SOURCE_ROOT) || path === PROFILE_SOURCE_SIDECAR) return false;
  return isSafeProfileEntryPath(path.slice(PROFILE_SOURCE_ROOT.length));
}

type Version = typeof SLICC_PROFILE_VERSION | typeof SLICC_PROFILE_DIRECTORY_VERSION;

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

function checkSource(
  item: Obj,
  name: string,
  path: string,
  version: Version
): ProfileValidationResult {
  const source = item['source'];
  if (source === undefined) return OK;
  if (version === SLICC_PROFILE_VERSION) return fail(`${path}.source needs version 2`);
  if (typeof source !== 'string' || !isSafeProfileSourcePath(source)) {
    return fail(`${path}.source must be a safe path under ${PROFILE_SOURCE_ROOT}`);
  }
  return PROFILE_SOURCE_PREFIXES.some((prefix) => name.startsWith(prefix))
    ? OK
    : fail(`${path} can't stay in place: only ${PROFILE_SOURCE_PREFIXES.join(', ')} entries can`);
}

function checkFile(version: Version) {
  return (item: unknown, path: string): ProfileValidationResult => {
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
    return checkSource(item, name, path, version);
  };
}

function checkSkipped(version: Version) {
  const reasons =
    version === SLICC_PROFILE_VERSION
      ? PROFILE_SKIP_REASONS
      : PROFILE_SKIP_REASONS.filter((reason) => reason !== 'archive-limit');
  return (item: unknown, path: string): ProfileValidationResult => {
    if (!isObj(item) || typeof item['path'] !== 'string') {
      return fail(`${path}.path must be a string`);
    }
    return reasons.includes(item['reason'] as ProfileSkipReason)
      ? OK
      : fail(`${path}.reason must be one of ${reasons.join(', ')}`);
  };
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

function checkHeader(m: Obj, version: Version): ProfileValidationResult {
  if (m['format'] !== SLICC_PROFILE_FORMAT) return fail(`format must be "${SLICC_PROFILE_FORMAT}"`);
  if (m['version'] !== version) return fail(`version must be ${version}`);
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
  if (part !== undefined && version === SLICC_PROFILE_DIRECTORY_VERSION) {
    return fail('part must be absent in version 2, which is never split');
  }
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

function checkReferences(m: SliccProfileManifest): ProfileValidationResult {
  const paths = new Set<string>();
  const sources = new Set<string>();
  for (const file of m.files as ProfileFileEntryV2[]) {
    if (paths.has(file.path)) return fail(`files lists "${file.path}" twice`);
    paths.add(file.path);
    if (file.source === undefined) continue;
    if (sources.has(file.source)) return fail(`files moves "${file.source}" twice`);
    sources.add(file.source);
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

function validateManifest(value: unknown, version: Version): ProfileValidationResult {
  if (!isObj(value)) return fail('manifest must be an object');
  const steps: (() => ProfileValidationResult)[] = [
    () => checkHeader(value, version),
    () => checkEach(value['cones'], 'cones', checkCone),
    () => checkEach(value['frozen'], 'frozen', checkFrozen),
    () => checkEach(value['skills'], 'skills', checkNamedPath),
    () => checkEach(value['sprinkles'], 'sprinkles', checkNamedPath),
    () => checkEach(value['files'], 'files', checkFile(version)),
    () => checkEach(value['skipped'], 'skipped', checkSkipped(version)),
    () => checkEach(value['flagged'], 'flagged', checkFlagged),
    () => checkEach(value['providers'], 'providers', checkString),
    () => checkEach(value['mcp'], 'mcp', checkMcp),
    () => checkEach(value['secrets'], 'secrets', checkSecretKind),
    () => checkTotals(value),
    () => checkReferences(value as unknown as SliccProfileManifest),
  ];
  for (const step of steps) {
    const result = step();
    if (!result.ok) return result;
  }
  return OK;
}

export function validateSliccProfileManifestV1(value: unknown): ProfileValidationResult {
  return validateManifest(value, SLICC_PROFILE_VERSION);
}

export function validateSliccProfileManifestV2(value: unknown): ProfileValidationResult {
  return validateManifest(value, SLICC_PROFILE_DIRECTORY_VERSION);
}

export function validateSliccProfileManifest(value: unknown): ProfileValidationResult {
  return isObj(value) && value['version'] === SLICC_PROFILE_DIRECTORY_VERSION
    ? validateSliccProfileManifestV2(value)
    : validateSliccProfileManifestV1(value);
}
