export interface FsPermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

export interface FsWritable {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

export interface FsFileHandle {
  createWritable(): Promise<FsWritable>;
}

export interface FsDirHandle {
  name: string;
  queryPermission?(descriptor: FsPermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor: FsPermissionDescriptor): Promise<PermissionState>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFileHandle>;
}

export type DirectoryPicker = (options?: { mode?: 'read' | 'readwrite' }) => Promise<FsDirHandle>;

export interface FeedbackRecord {
  storyId: string;
  storyTitle: string;
  subsystem: string;
  importPath: string;
  comment: string;
  createdAt: string;
}

export function getDirectoryPicker(): DirectoryPicker | undefined {
  return (globalThis as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
}

export function deriveSubsystem(importPath: string | undefined): string {
  if (!importPath) {
    return 'unknown';
  }
  const match = importPath.match(/(?:^|\/)src\/([^/]+)\//);
  return match ? match[1] : 'unknown';
}

export async function ensurePermission(
  dir: FsDirHandle,
  request: boolean
): Promise<PermissionState> {
  const descriptor: FsPermissionDescriptor = { mode: 'readwrite' };
  const current = (await dir.queryPermission?.(descriptor)) ?? 'prompt';
  if (current === 'granted') {
    return 'granted';
  }
  if (request) {
    return (await dir.requestPermission?.(descriptor)) ?? 'denied';
  }
  return current;
}

function sanitize(part: string): string {
  return part.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

export async function writeComment(dir: FsDirHandle, record: FeedbackRecord): Promise<string> {
  const filename = `${sanitize(record.subsystem)}__${sanitize(record.storyId)}__${Date.now()}.json`;
  const fileHandle = await dir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(JSON.stringify(record, null, 2));
  } finally {
    await writable.close();
  }
  return filename;
}
