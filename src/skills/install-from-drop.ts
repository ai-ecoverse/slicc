import { unzipSync } from 'fflate';
import type { VirtualFS } from '../fs/index.js';
import { joinPath, splitPath } from '../fs/index.js';
import {
  MANIFEST_FILE,
  MAX_SKILL_ARCHIVE_SIZE_BYTES,
  SKILL_ARCHIVE_EXTENSION,
  WORKSPACE_SKILLS_PATH,
} from './constants.js';
import { parseManifestContent } from './manifest.js';

export interface DroppedSkillFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface InstallSkillFromDropResult {
  skillName: string;
  destinationPath: string;
  fileCount: number;
}

interface ArchiveEntry {
  originalPath: string;
  path: string;
  bytes: Uint8Array;
}

const VALID_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function sanitizeArchiveEntryPath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/');
  if (!normalized || normalized.endsWith('/')) return null;
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Blocked suspicious path "${path}".`);
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Blocked suspicious path "${path}".`);
  }

  return segments.join('/');
}

function assertValidSkillName(skillName: string): void {
  if (!VALID_SKILL_NAME.test(skillName)) {
    throw new Error(`Invalid manifest: skill name "${skillName}" must be a simple directory name.`);
  }
}

function collectArchiveEntries(files: Record<string, Uint8Array>): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const [originalPath, bytes] of Object.entries(files)) {
    const path = sanitizeArchiveEntryPath(originalPath);
    if (!path) continue;
    entries.push({ originalPath, path, bytes });
  }
  return entries;
}

function findManifestEntry(entries: ArchiveEntry[]): ArchiveEntry {
  const manifests = entries.filter((entry) =>
    entry.path === MANIFEST_FILE || entry.path.endsWith(`/${MANIFEST_FILE}`),
  );

  if (manifests.length === 0) {
    throw new Error(`Skill archive is missing ${MANIFEST_FILE}.`);
  }
  if (manifests.length > 1) {
    throw new Error(`Skill archive contains multiple ${MANIFEST_FILE} files.`);
  }

  return manifests[0];
}

export async function installSkillFromDrop(
  fs: VirtualFS,
  file: DroppedSkillFile,
): Promise<InstallSkillFromDropResult> {
  if (!file.name.toLowerCase().endsWith(SKILL_ARCHIVE_EXTENSION)) {
    throw new Error(`Only ${SKILL_ARCHIVE_EXTENSION} archives can be installed with drag and drop.`);
  }
  if (file.size > MAX_SKILL_ARCHIVE_SIZE_BYTES) {
    throw new Error('Skill archives must be 50 MB or smaller.');
  }

  let archive: Record<string, Uint8Array>;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    archive = unzipSync(bytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid .skill archive: ${message}`);
  }

  const entries = collectArchiveEntries(archive);
  const manifestEntry = findManifestEntry(entries);
  const manifest = parseManifestContent(decodeUtf8(manifestEntry.bytes), manifestEntry.path);
  assertValidSkillName(manifest.skill);

  const destinationPath = joinPath(WORKSPACE_SKILLS_PATH, manifest.skill);
  if (await fs.exists(destinationPath)) {
    throw new Error(`Skill "${manifest.skill}" already exists at ${destinationPath}.`);
  }

  const manifestPrefix = manifestEntry.path === MANIFEST_FILE
    ? ''
    : manifestEntry.path.slice(0, -(MANIFEST_FILE.length + 1));

  await fs.mkdir(destinationPath, { recursive: true });

  let fileCount = 0;
  for (const entry of entries) {
    if (manifestPrefix) {
      if (entry.path === manifestPrefix) continue;
      if (!entry.path.startsWith(`${manifestPrefix}/`)) continue;
    }

    const relativePath = manifestPrefix ? entry.path.slice(manifestPrefix.length + 1) : entry.path;
    if (!relativePath) continue;

    const outputPath = joinPath(destinationPath, relativePath);
    const { dir } = splitPath(outputPath);
    if (dir !== '/') {
      await fs.mkdir(dir, { recursive: true });
    }
    await fs.writeFile(outputPath, entry.bytes);
    fileCount++;
  }

  return {
    skillName: manifest.skill,
    destinationPath,
    fileCount,
  };
}