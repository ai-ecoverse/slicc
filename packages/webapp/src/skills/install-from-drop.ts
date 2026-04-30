import { unzipSync } from 'fflate';
import type { VirtualFS } from '../fs/index.js';
import { joinPath, splitPath } from '../fs/index.js';
import {
  MAX_SKILL_ARCHIVE_ENTRY_COUNT,
  MAX_SKILL_ARCHIVE_SIZE_BYTES,
  MAX_SKILL_ARCHIVE_UNCOMPRESSED_SIZE_BYTES,
  SKILL_ARCHIVE_EXTENSION,
  SKILL_FILE,
  WORKSPACE_SKILLS_PATH,
} from './constants.js';

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

class ArchiveBudgetError extends Error {}

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
    throw new Error(`Invalid skill: skill name "${skillName}" must be a simple directory name.`);
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

/**
 * Find the SKILL.md entry that anchors the skill. The archive must contain
 * exactly one SKILL.md so the resulting skill directory is unambiguous.
 *
 * The skill name is derived from the SKILL.md's parent directory (the wrapping
 * folder inside the archive), or — when SKILL.md is at the archive root —
 * from the archive filename minus the .skill extension.
 */
function findSkillEntry(entries: ArchiveEntry[]): ArchiveEntry {
  const skillFiles = entries.filter(
    (entry) => entry.path === SKILL_FILE || entry.path.endsWith(`/${SKILL_FILE}`)
  );

  if (skillFiles.length === 0) {
    throw new Error(`Skill archive is missing ${SKILL_FILE}.`);
  }
  if (skillFiles.length > 1) {
    throw new Error(`Skill archive contains multiple ${SKILL_FILE} files.`);
  }

  return skillFiles[0];
}

function unzipArchiveWithSafetyLimits(bytes: Uint8Array): Record<string, Uint8Array> {
  let entryCount = 0;
  let totalUncompressedBytes = 0;

  return unzipSync(bytes, {
    filter(file) {
      entryCount++;
      if (entryCount > MAX_SKILL_ARCHIVE_ENTRY_COUNT) {
        throw new ArchiveBudgetError(
          `Skill archives may contain at most ${MAX_SKILL_ARCHIVE_ENTRY_COUNT} entries.`
        );
      }

      totalUncompressedBytes += file.originalSize;
      if (totalUncompressedBytes > MAX_SKILL_ARCHIVE_UNCOMPRESSED_SIZE_BYTES) {
        throw new ArchiveBudgetError(
          'Skill archives must expand to 50 MB or smaller after extraction.'
        );
      }

      return true;
    },
  });
}

function createTemporaryDestinationPath(skillName: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  return joinPath(WORKSPACE_SKILLS_PATH, `.${skillName}.tmp-${suffix}`);
}

function deriveSkillNameFromArchive(fileName: string, skillEntryPath: string): string {
  if (skillEntryPath === SKILL_FILE) {
    // SKILL.md sits at the archive root → fall back to the archive filename.
    const base = fileName.replace(/\.skill$/i, '');
    return base;
  }
  // SKILL.md lives inside a wrapper directory → use that directory name.
  return (
    skillEntryPath
      .slice(0, -(SKILL_FILE.length + 1))
      .split('/')
      .pop() ?? ''
  );
}

export async function installSkillFromDrop(
  fs: VirtualFS,
  file: DroppedSkillFile
): Promise<InstallSkillFromDropResult> {
  if (!file.name.toLowerCase().endsWith(SKILL_ARCHIVE_EXTENSION)) {
    throw new Error(
      `Only ${SKILL_ARCHIVE_EXTENSION} archives can be installed with drag and drop.`
    );
  }
  if (file.size > MAX_SKILL_ARCHIVE_SIZE_BYTES) {
    throw new Error('Skill archives must be 50 MB or smaller.');
  }

  let archive: Record<string, Uint8Array>;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    archive = unzipArchiveWithSafetyLimits(bytes);
  } catch (err) {
    if (err instanceof ArchiveBudgetError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid .skill archive: ${message}`);
  }

  const entries = collectArchiveEntries(archive);
  const skillEntry = findSkillEntry(entries);
  const skillName = deriveSkillNameFromArchive(file.name, skillEntry.path);
  assertValidSkillName(skillName);

  const destinationPath = joinPath(WORKSPACE_SKILLS_PATH, skillName);
  if (await fs.exists(destinationPath)) {
    throw new Error(`Skill "${skillName}" already exists at ${destinationPath}.`);
  }
  const temporaryDestinationPath = createTemporaryDestinationPath(skillName);

  const skillPrefix =
    skillEntry.path === SKILL_FILE ? '' : skillEntry.path.slice(0, -(SKILL_FILE.length + 1));

  await fs.mkdir(temporaryDestinationPath, { recursive: true });

  try {
    let fileCount = 0;
    for (const entry of entries) {
      if (skillPrefix) {
        if (entry.path === skillPrefix) continue;
        if (!entry.path.startsWith(`${skillPrefix}/`)) continue;
      }

      const relativePath = skillPrefix ? entry.path.slice(skillPrefix.length + 1) : entry.path;
      if (!relativePath) continue;

      const outputPath = joinPath(temporaryDestinationPath, relativePath);
      const { dir } = splitPath(outputPath);
      if (dir !== '/') {
        await fs.mkdir(dir, { recursive: true });
      }
      await fs.writeFile(outputPath, entry.bytes);
      fileCount++;
    }

    await fs.rename(temporaryDestinationPath, destinationPath);

    return {
      skillName,
      destinationPath,
      fileCount,
    };
  } catch (err) {
    if (await fs.exists(temporaryDestinationPath)) {
      await fs.rm(temporaryDestinationPath, { recursive: true });
    }
    throw err;
  }
}
