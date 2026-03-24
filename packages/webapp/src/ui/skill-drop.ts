import { SKILL_ARCHIVE_EXTENSION } from '../skills/constants.js';

export interface NamedFileLike {
  name: string;
}

export interface DataTransferItemLike<T extends NamedFileLike = NamedFileLike> {
  kind?: string;
  getAsFile?: () => T | null;
}

export interface SkillDropTransferLike<T extends NamedFileLike = NamedFileLike> {
  files?: Iterable<T> | ArrayLike<T> | null;
  items?: Iterable<DataTransferItemLike<T>> | ArrayLike<DataTransferItemLike<T>> | null;
}

export function isSkillArchiveName(name: string): boolean {
  return name.toLowerCase().endsWith(SKILL_ARCHIVE_EXTENSION);
}

export function findDroppedSkillFile<T extends NamedFileLike>(
  files: Iterable<T> | ArrayLike<T>
): T | null {
  return Array.from(files).find((file) => isSkillArchiveName(file.name)) ?? null;
}

/**
 * Light check for dragenter/dragover — browsers restrict file access during drag.
 * Only checks items metadata (kind === 'file'), not file content or name.
 * Returns true if any file item is present (we can't read the name until drop).
 */
export function hasDroppedFiles(transfer: DataTransfer | null | undefined): boolean {
  if (!transfer) return false;
  if (transfer.items) {
    for (const item of Array.from(transfer.items)) {
      if (item.kind === 'file') return true;
    }
  }
  return false;
}

export function findDroppedSkillTransferFile<T extends NamedFileLike = NamedFileLike>(
  transfer: SkillDropTransferLike<T> | null | undefined
): T | null {
  if (!transfer) return null;

  if (transfer.files) {
    const fromFiles = findDroppedSkillFile(transfer.files);
    if (fromFiles) return fromFiles;
  }

  if (!transfer.items) return null;

  for (const item of Array.from(transfer.items)) {
    if (item.kind && item.kind !== 'file') continue;
    const file = item.getAsFile?.();
    if (file && isSkillArchiveName(file.name)) return file;
  }

  return null;
}
