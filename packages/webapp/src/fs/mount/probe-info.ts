import { createLogger } from '../../base/logger.js';
import { joinPath, normalizePath, splitPath } from '../path-utils.js';
import { type DirEntry, type FileContent, FsError, type Stats } from '../types.js';
import type { MountKind } from './backend.js';

const log = createLogger('mount-info');

export const CASE_PROBE_NAME = 'Aa';
export const CASE_FOLDED_NAME = 'aa';

export const NFC_PROBE_NAME = 'caf\u00e9';
export const NFD_PROBE_NAME = 'cafe\u0301';

export const MAX_FILENAME_PROBE_CAP = 1024;

const SCRATCH_PREFIX = '.slicc-mi-';
const EXEC_BITS = 0o111;
const CHMOD_PROBE_MODE = 0o755;

export type NameSensitivity = 'sensitive' | 'insensitive';
export type UnicodeNormalization = 'byte-exact' | 'insensitive';
export type UnicodeStorage = 'nfc' | 'nfd' | 'as-written';

export interface MountInfo {
  path: string;

  mountPoint: string | null;
  kind: 'vfs' | MountKind;
  writable: boolean;

  hostBacked: boolean;
  caseSensitivity: NameSensitivity | null;
  unicodeNormalization: UnicodeNormalization | null;
  unicodeStorage: UnicodeStorage | null;
  executableBit: boolean | null;
  namesRoundTripByteExact: boolean | null;
  maxFilenameLength: number | null;
}

export interface MountProbeFs {
  writeFile(path: string, content: FileContent): Promise<void>;
  exists(path: string): Promise<boolean>;
  readDir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<Stats>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  listMountPoints?(): { path: string; kind: MountKind }[];
  chmod?(path: string, mode: number): Promise<void>;
}

export interface ProbeMountInfoOptions {
  randomId?: () => string;
}

function coveringMount(fs: MountProbeFs, path: string): { path: string; kind: MountKind } | null {
  const mounts = fs.listMountPoints?.() ?? [];
  let best: { path: string; kind: MountKind } | null = null;
  for (const mount of mounts) {
    if (path === mount.path || path.startsWith(`${mount.path}/`)) {
      if (!best || mount.path.length > best.path.length) best = mount;
    }
  }
  return best;
}

function listedNames(entries: DirEntry[]): string[] {
  return entries.map((e) => e.name);
}

function hasExactName(entries: DirEntry[], name: string): boolean {
  return entries.some((e) => e.name === name);
}

function unicodeStorageOf(written: string, listed: string): UnicodeStorage {
  if (listed === written) return 'as-written';
  if (listed === written.normalize('NFD') || listed === NFD_PROBE_NAME) return 'nfd';
  if (listed === written.normalize('NFC') || listed === NFC_PROBE_NAME) return 'nfc';
  return 'as-written';
}

async function listedIn(fs: MountProbeFs, dir: string, name: string): Promise<boolean> {
  const entries = await fs.readDir(dir);
  return hasExactName(entries, name);
}

async function probeMaxFilenameLength(fs: MountProbeFs, dir: string): Promise<number | null> {
  const canHold = async (len: number): Promise<boolean> => {
    if (len < 1) return false;
    const name = 'x'.repeat(len);
    const path = joinPath(dir, name);
    try {
      await fs.writeFile(path, '1');
    } catch {
      return false;
    }
    try {
      return await listedIn(fs, dir, name);
    } finally {
      try {
        await fs.rm(path);
      } catch {}
    }
  };

  if (!(await canHold(1))) return null;
  if (await canHold(MAX_FILENAME_PROBE_CAP)) return MAX_FILENAME_PROBE_CAP;
  let lo = 1;
  let hi = MAX_FILENAME_PROBE_CAP;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (await canHold(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

async function probeExecutableBit(fs: MountProbeFs, filePath: string): Promise<boolean> {
  const modeHasExec = (mode: number | undefined): boolean =>
    typeof mode === 'number' && (mode & EXEC_BITS) !== 0;

  const first = await fs.stat(filePath);
  if (modeHasExec(first.mode)) return true;
  if (!fs.chmod) return false;
  try {
    await fs.chmod(filePath, CHMOD_PROBE_MODE);
  } catch {
    return false;
  }
  const after = await fs.stat(filePath);
  return modeHasExec(after.mode);
}

async function resolveProbeDir(fs: MountProbeFs, requested: string): Promise<string> {
  const normalized = normalizePath(requested);
  let st: Stats;
  try {
    st = await fs.stat(normalized);
  } catch (err) {
    if (err instanceof FsError) throw err;
    throw new FsError('ENOENT', err instanceof Error ? err.message : String(err), normalized);
  }
  if (st.type === 'directory') return normalized;
  const { dir } = splitPath(normalized);
  return dir;
}

function emptyInfo(
  path: string,
  mount: { path: string; kind: MountKind } | null,
  writable: boolean
): MountInfo {
  const kind = mount?.kind ?? 'vfs';
  return {
    path,
    mountPoint: mount?.path ?? null,
    kind,
    writable,
    hostBacked: kind === 'hostfs' || kind === 'local',
    caseSensitivity: null,
    unicodeNormalization: null,
    unicodeStorage: null,
    executableBit: null,
    namesRoundTripByteExact: null,
    maxFilenameLength: null,
  };
}

function newScratchId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export async function probeMountInfo(
  fs: MountProbeFs,
  path: string,
  opts: ProbeMountInfoOptions = {}
): Promise<MountInfo> {
  const dir = await resolveProbeDir(fs, path);
  const mount = coveringMount(fs, dir);
  const scratch = joinPath(dir, `${SCRATCH_PREFIX}${opts.randomId?.() ?? newScratchId()}`);

  try {
    await fs.mkdir(scratch);
  } catch {
    return emptyInfo(dir, mount, false);
  }

  try {
    return await runProbes(fs, dir, mount, scratch);
  } finally {
    await removeScratch(fs, scratch);
  }
}

async function removeScratch(fs: MountProbeFs, scratch: string): Promise<void> {
  try {
    const entries = await fs.readDir(scratch);
    for (const entry of entries) {
      const child = joinPath(scratch, entry.name);
      try {
        await fs.rm(child, entry.type === 'directory' ? { recursive: true } : undefined);
      } catch {
        try {
          await fs.rm(child);
        } catch {}
      }
    }
  } catch {}
  try {
    await fs.rm(scratch, { recursive: true });
    return;
  } catch {}
  try {
    await fs.rm(scratch);
  } catch (err) {
    if (err instanceof FsError && err.code === 'ENOENT') return;
    log.warn('mount info: failed to remove scratch dir', {
      scratch,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runProbes(
  fs: MountProbeFs,
  dir: string,
  mount: { path: string; kind: MountKind } | null,
  scratch: string
): Promise<MountInfo> {
  const info = emptyInfo(dir, mount, true);

  const casePath = joinPath(scratch, CASE_PROBE_NAME);
  await fs.writeFile(casePath, '1');
  const caseFoldedExists = await fs.exists(joinPath(scratch, CASE_FOLDED_NAME));
  info.caseSensitivity = caseFoldedExists ? 'insensitive' : 'sensitive';

  const nfcPath = joinPath(scratch, NFC_PROBE_NAME);
  await fs.writeFile(nfcPath, '1');
  const nfdExists = await fs.exists(joinPath(scratch, NFD_PROBE_NAME));
  info.unicodeNormalization = nfdExists ? 'insensitive' : 'byte-exact';

  if (!nfdExists) {
    await fs.writeFile(joinPath(scratch, NFD_PROBE_NAME), '1');
  }

  const entries = await fs.readDir(scratch);
  const names = listedNames(entries);

  const exactNfc: string | undefined = names.find((n) => n === NFC_PROBE_NAME);
  const exactNfd: string | undefined = names.find((n) => n === NFD_PROBE_NAME);
  if (exactNfc && exactNfd) {
    info.unicodeStorage = 'as-written';
  } else if (exactNfd && !exactNfc) {
    info.unicodeStorage = 'nfd';
  } else if (exactNfc && !exactNfd) {
    info.unicodeStorage = nfdExists ? 'as-written' : 'nfc';
  } else {
    const equiv = names.find((n) => n.normalize('NFC') === NFC_PROBE_NAME.normalize('NFC'));
    if (equiv) info.unicodeStorage = unicodeStorageOf(NFC_PROBE_NAME, equiv);
  }

  const caseExact = hasExactName(entries, CASE_PROBE_NAME);
  const nfcExact = hasExactName(entries, NFC_PROBE_NAME);
  const nfdExact = nfdExists ? true : hasExactName(entries, NFD_PROBE_NAME);
  info.namesRoundTripByteExact = caseExact && nfcExact && nfdExact;

  info.executableBit = await probeExecutableBit(fs, casePath);
  info.maxFilenameLength = await probeMaxFilenameLength(fs, scratch);
  return info;
}

function yn(value: boolean): string {
  return value ? 'yes' : 'no';
}

function execLabel(value: boolean | null): string {
  if (value === null) return '(not probed)';
  return value ? 'supported' : 'not supported';
}

function orUnmeasured(value: string | null | undefined): string {
  return value ?? '(not probed)';
}

export function formatMountInfo(info: MountInfo): string {
  const unicode =
    info.unicodeNormalization === null
      ? '(not probed)'
      : info.unicodeStorage
        ? `${info.unicodeNormalization} (stored ${info.unicodeStorage})`
        : info.unicodeNormalization;
  const names =
    info.namesRoundTripByteExact === null
      ? '(not probed)'
      : info.namesRoundTripByteExact
        ? 'byte-exact'
        : 'not byte-exact';
  const max = info.maxFilenameLength === null ? '(not probed)' : String(info.maxFilenameLength);
  const lines = [
    `${info.path} (${info.kind})`,
    ...(info.mountPoint && info.mountPoint !== info.path
      ? [`  mount-point: ${info.mountPoint}`]
      : []),
    `  case: ${orUnmeasured(info.caseSensitivity)}`,
    `  unicode: ${unicode}`,
    `  executable-bit: ${execLabel(info.executableBit)}`,
    `  names: ${names}`,
    `  max-filename-length: ${max}`,
    `  writable: ${yn(info.writable)}`,
    `  host-backed: ${yn(info.hostBacked)}`,
    '',
  ];
  return lines.join('\n');
}
