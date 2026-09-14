import { createLogger } from '../base/logger.js';
import { shouldSkipNoiseDir } from './bounded-walk.js';

const log = createLogger('mount-index');

const MAX_INDEX_DEPTH = 400;
const MAX_INDEX_ENTRIES = 2_000_000;

const ENV_MAX_DEPTH = 'SLICC_MOUNT_INDEX_MAX_DEPTH';

const ENV_MAX_ENTRIES = 'SLICC_MOUNT_INDEX_MAX_ENTRIES';

const SIGNATURE_SAMPLE_CAP = 256;

export type MountIndexAbortCause =
  | 'depth-exceeded'
  | 'entries-exceeded'
  | 'cycle-detected'
  | 'indexing-error';

class MountIndexAbortError extends Error {
  readonly cause: MountIndexAbortCause;
  constructor(message: string, cause: MountIndexAbortCause) {
    super(message);
    this.name = 'MountIndexAbortError';
    this.cause = cause;
  }
}

interface AncestorEntry {
  path: string;
  handle: FileSystemDirectoryHandle;
  signature: string;
}

function computeDirSignature(children: Array<[string, FileSystemHandle]>): string {
  const tokens = children.map(([name, child]) => `${name}\u0000${child.kind}`).sort();
  const sampled =
    tokens.length > SIGNATURE_SAMPLE_CAP ? tokens.slice(0, SIGNATURE_SAMPLE_CAP) : tokens;
  return `${tokens.length}\u0001${sampled.join('\u0002')}`;
}

async function isSameEntrySafe(
  ancestor: FileSystemDirectoryHandle,
  candidate: FileSystemDirectoryHandle
): Promise<boolean> {
  const isSameEntry = (ancestor as { isSameEntry?: (other: FileSystemHandle) => Promise<boolean> })
    .isSameEntry;
  if (typeof isSameEntry !== 'function') return false;
  try {
    return await isSameEntry.call(ancestor, candidate);
  } catch {
    return false;
  }
}

export interface MountIndexLimits {
  maxDepth: number;
  maxEntries: number;

  skipNoiseDirs: boolean;
}

export const RESTORED_MOUNT_INDEX_LIMITS: MountIndexLimits = {
  maxDepth: 100,
  maxEntries: 100_000,
  skipNoiseDirs: true,
};

export type MountIndexEnv = ReadonlyMap<string, string> | Record<string, string | undefined>;

function readEnvValue(env: MountIndexEnv, name: string): string | undefined {
  return env instanceof Map ? env.get(name) : (env as Record<string, string | undefined>)[name];
}

function parsePositiveIntLimit(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

function resolveLimit(env: MountIndexEnv, name: string, fallback: number): number {
  const raw = readEnvValue(env, name);

  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = parsePositiveIntLimit(raw);
  if (parsed === undefined) {
    log.warn(`Ignoring invalid ${name}; expected a positive integer, using default`, {
      value: raw,
      fallback,
    });
    return fallback;
  }
  return parsed;
}

export function resolveMountIndexLimits(env: MountIndexEnv): MountIndexLimits {
  return {
    maxDepth: resolveLimit(env, ENV_MAX_DEPTH, MAX_INDEX_DEPTH),
    maxEntries: resolveLimit(env, ENV_MAX_ENTRIES, MAX_INDEX_ENTRIES),
    skipNoiseDirs: true,
  };
}

export interface MountIndexEntry {
  path: string;

  type: 'file' | 'directory';
}

export type IndexingStatus = 'pending' | 'indexing' | 'ready' | 'error';

export interface MountIndexState {
  status: IndexingStatus;

  indexed: number;

  total?: number;

  error?: string;

  abortCause?: MountIndexAbortCause;
}

type DirectoryChildren = Map<string, 'file' | 'directory'>;

interface MountData {
  handle: FileSystemDirectoryHandle;
  state: MountIndexState;

  files: Set<string>;

  directories: Set<string>;

  childrenByDirectory: Map<string, DirectoryChildren>;

  abortController: AbortController | null;

  limits: MountIndexLimits;
}

export class MountIndex {
  private mounts = new Map<string, MountData>();
  private listeners = new Set<() => void>();

  registerMount(
    mountPath: string,
    handle: FileSystemDirectoryHandle,
    limits: MountIndexLimits = resolveMountIndexLimits({})
  ): void {
    this.mounts.get(mountPath)?.abortController?.abort();

    const abortController = new AbortController();
    const data: MountData = {
      handle,
      state: { status: 'pending', indexed: 0 },
      files: new Set(),
      directories: new Set(),
      childrenByDirectory: new Map(),
      abortController,
      limits,
    };

    this.mounts.set(mountPath, data);
    this.notifyListeners();

    void this.indexMount(mountPath, data, abortController.signal);
  }

  unregisterMount(mountPath: string): void {
    const data = this.mounts.get(mountPath);
    if (data) {
      data.abortController?.abort();
      this.mounts.delete(mountPath);
      this.notifyListeners();
    }
  }

  async refreshMount(mountPath: string, limits?: MountIndexLimits): Promise<void> {
    const data = this.mounts.get(mountPath);
    if (!data) {
      throw new Error(`No mount at ${mountPath}`);
    }

    data.abortController?.abort();

    const abortController = new AbortController();
    data.abortController = abortController;
    data.state = { status: 'pending', indexed: 0 };
    data.files.clear();
    data.directories.clear();
    data.childrenByDirectory.clear();
    if (limits) data.limits = limits;
    this.notifyListeners();

    await this.indexMount(mountPath, data, abortController.signal);
  }

  isReady(mountPath: string): boolean {
    return this.mounts.get(mountPath)?.state.status === 'ready';
  }

  isAnyIndexing(): boolean {
    for (const data of this.mounts.values()) {
      if (data.state.status === 'indexing' || data.state.status === 'pending') {
        return true;
      }
    }
    return false;
  }

  dispose(): void {
    for (const data of this.mounts.values()) {
      data.abortController?.abort();
    }
    this.mounts.clear();
    this.listeners.clear();
  }

  getState(mountPath: string): MountIndexState | undefined {
    return this.mounts.get(mountPath)?.state;
  }

  getFiles(mountPath: string, filter?: (path: string) => boolean): string[] | undefined {
    const data = this.mounts.get(mountPath);
    if (data?.state.status !== 'ready') {
      return undefined;
    }

    if (!filter) {
      return [...data.files];
    }

    const result: string[] = [];
    for (const path of data.files) {
      if (filter(path)) {
        result.push(path);
      }
    }
    return result;
  }

  getDirectoryEntries(
    mountPath: string,
    dirPath: string
  ): Array<{ name: string; type: 'file' | 'directory' }> | undefined {
    const data = this.mounts.get(mountPath);
    if (data?.state.status !== 'ready') {
      return undefined;
    }

    const children = data.childrenByDirectory.get(dirPath);
    if (children) {
      return [...children].map(([name, type]) => ({ name, type }));
    }

    return undefined;
  }

  hasPath(mountPath: string, absolutePath: string): boolean | undefined {
    const data = this.mounts.get(mountPath);
    if (data?.state.status !== 'ready') {
      return undefined;
    }
    return data.files.has(absolutePath) || data.directories.has(absolutePath);
  }

  notifyWrite(absolutePath: string): void {
    const mountPath = this.findMountForPath(absolutePath);
    if (!mountPath) return;

    const data = this.mounts.get(mountPath);
    if (data?.state.status !== 'ready') return;

    if (this.isSkippedNoisePath(mountPath, absolutePath, data, 'file')) return;

    data.files.add(absolutePath);
    this.addPathToChildIndex(data, absolutePath, 'file');

    let parent = this.parentPath(absolutePath);
    while (parent === mountPath || parent.startsWith(`${mountPath}/`)) {
      data.directories.add(parent);
      this.ensureDirectoryChildren(data, parent);
      if (parent === mountPath) break;
      this.addPathToChildIndex(data, parent, 'directory');
      parent = this.parentPath(parent);
    }
  }

  notifyDelete(absolutePath: string): void {
    const mountPath = this.findMountForPath(absolutePath);
    if (!mountPath) return;

    const data = this.mounts.get(mountPath);
    if (data?.state.status !== 'ready') return;

    if (this.isSkippedNoisePath(mountPath, absolutePath, data, 'unknown')) return;

    data.files.delete(absolutePath);
    data.directories.delete(absolutePath);

    const prefix = absolutePath + '/';
    for (const path of data.files) {
      if (path.startsWith(prefix)) {
        data.files.delete(path);
      }
    }
    for (const path of data.directories) {
      if (path.startsWith(prefix)) {
        data.directories.delete(path);
      }
    }

    this.removePathFromChildIndex(data, absolutePath);
    for (const directoryPath of data.childrenByDirectory.keys()) {
      if (directoryPath === absolutePath || directoryPath.startsWith(prefix)) {
        data.childrenByDirectory.delete(directoryPath);
      }
    }
  }

  notifyRename(oldPath: string, newPath: string): void {
    const mountPath = this.findMountForPath(oldPath);
    if (!mountPath) return;

    const data = this.mounts.get(mountPath);
    if (data?.state.status !== 'ready') return;

    const kind: 'file' | 'directory' | 'unknown' = data.files.has(oldPath)
      ? 'file'
      : data.directories.has(oldPath)
        ? 'directory'
        : 'unknown';
    if (kind === 'unknown') return;

    if (this.isSkippedNoisePath(mountPath, oldPath, data, kind)) return;
    if (this.isSkippedNoisePath(mountPath, newPath, data, kind)) {
      this.notifyDelete(oldPath);
      return;
    }

    if (kind === 'file') {
      data.files.delete(oldPath);
      data.files.add(newPath);
      this.removePathFromChildIndex(data, oldPath);
      this.addPathToChildIndex(data, newPath, 'file');
      return;
    }

    data.directories.delete(oldPath);
    data.directories.add(newPath);

    const oldPrefix = oldPath + '/';
    const newPrefix = newPath + '/';

    for (const path of [...data.files]) {
      if (path.startsWith(oldPrefix)) {
        data.files.delete(path);
        data.files.add(newPrefix + path.slice(oldPrefix.length));
      }
    }
    for (const path of [...data.directories]) {
      if (path.startsWith(oldPrefix)) {
        data.directories.delete(path);
        data.directories.add(newPrefix + path.slice(oldPrefix.length));
      }
    }

    this.removePathFromChildIndex(data, oldPath);
    this.addPathToChildIndex(data, newPath, 'directory');
    const movedDirectories = [...data.childrenByDirectory.entries()].filter(
      ([path]) => path === oldPath || path.startsWith(oldPrefix)
    );
    for (const [path] of movedDirectories) {
      data.childrenByDirectory.delete(path);
    }
    for (const [path, children] of movedDirectories) {
      const renamedPath = path === oldPath ? newPath : newPrefix + path.slice(oldPrefix.length);
      data.childrenByDirectory.set(renamedPath, children);
    }
  }

  private ensureDirectoryChildren(data: MountData, dirPath: string): DirectoryChildren {
    let children = data.childrenByDirectory.get(dirPath);
    if (!children) {
      children = new Map();
      data.childrenByDirectory.set(dirPath, children);
    }
    return children;
  }

  private addPathToChildIndex(
    data: MountData,
    absolutePath: string,
    type: 'file' | 'directory'
  ): void {
    const name = absolutePath.slice(absolutePath.lastIndexOf('/') + 1);
    if (!name) return;

    const children = this.ensureDirectoryChildren(data, this.parentPath(absolutePath));
    children.set(name, type);
    if (type === 'directory') {
      this.ensureDirectoryChildren(data, absolutePath);
    }
  }

  private removePathFromChildIndex(data: MountData, absolutePath: string): void {
    const name = absolutePath.slice(absolutePath.lastIndexOf('/') + 1);
    const children = data.childrenByDirectory.get(this.parentPath(absolutePath));
    children?.delete(name);
  }

  private parentPath(absolutePath: string): string {
    const lastSlash = absolutePath.lastIndexOf('/');
    return lastSlash <= 0 ? '/' : absolutePath.slice(0, lastSlash);
  }

  private isSkippedNoisePath(
    mountPath: string,
    absolutePath: string,
    data: MountData,
    pathKind: 'file' | 'directory' | 'unknown'
  ): boolean {
    if (!data.limits.skipNoiseDirs) return false;
    if (!absolutePath.startsWith(`${mountPath}/`)) return false;

    const segments = absolutePath.slice(mountPath.length + 1).split('/');
    const kind =
      pathKind !== 'unknown'
        ? pathKind
        : data.files.has(absolutePath)
          ? 'file'
          : data.directories.has(absolutePath)
            ? 'directory'
            : 'unknown';

    for (let i = 0; i < segments.length; i++) {
      const isLeaf = i === segments.length - 1;
      if (isLeaf && kind === 'file') continue;

      if (isLeaf && kind === 'unknown' && !shouldSkipNoiseDir(segments[i]!)) continue;
      if (shouldSkipNoiseDir(segments[i]!)) return true;
    }
    return false;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private findMountForPath(absolutePath: string): string | undefined {
    let bestMatch: string | undefined;
    for (const mountPath of this.mounts.keys()) {
      if (absolutePath === mountPath || absolutePath.startsWith(mountPath + '/')) {
        if (!bestMatch || mountPath.length > bestMatch.length) {
          bestMatch = mountPath;
        }
      }
    }
    return bestMatch;
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
  }

  private async indexMount(mountPath: string, data: MountData, signal: AbortSignal): Promise<void> {
    data.state = { status: 'indexing', indexed: 0 };
    this.notifyListeners();

    try {
      await this.walkHandle(mountPath, data.handle, data, signal);

      if (signal.aborted) return;

      data.state = {
        status: 'ready',
        indexed: data.files.size + data.directories.size,
        total: data.files.size + data.directories.size,
      };
      data.abortController = null;

      log.info('Mount indexed', {
        path: mountPath,
        files: data.files.size,
        directories: data.directories.size,
      });
    } catch (err) {
      if (signal.aborted) return;

      const message = err instanceof Error ? err.message : String(err);
      const abortCause: MountIndexAbortCause =
        err instanceof MountIndexAbortError ? err.cause : 'indexing-error';
      data.state = { status: 'error', indexed: 0, error: message, abortCause };
      log.error('Mount indexing failed', { path: mountPath, error: message, abortCause });
    }

    this.notifyListeners();
  }

  private async walkHandle(
    basePath: string,
    handle: FileSystemDirectoryHandle,
    data: MountData,
    signal: AbortSignal,
    depth = 0,
    signatureBuckets: Map<string, AncestorEntry[]> = new Map()
  ): Promise<void> {
    if (signal.aborted) return;
    this.enforceWalkBounds(depth, data);

    data.directories.add(basePath);
    this.ensureDirectoryChildren(data, basePath);

    const children = await this.readChildren(handle, signal, data);
    if (signal.aborted) return;

    const signature = await this.confirmNoCycle(basePath, handle, children, signatureBuckets);

    const bucket = this.pushAncestor(signatureBuckets, signature, basePath, handle);
    try {
      await this.walkChildren(basePath, children, data, signal, depth, signatureBuckets);
    } finally {
      this.popAncestor(signatureBuckets, signature, bucket);
    }
  }

  private enforceWalkBounds(depth: number, data: MountData): void {
    if (depth > data.limits.maxDepth) {
      throw new MountIndexAbortError(
        `mount indexing aborted: directory nesting exceeded ${data.limits.maxDepth} levels`,
        'depth-exceeded'
      );
    }
    if (data.directories.size + data.files.size >= data.limits.maxEntries) {
      throw new MountIndexAbortError(
        `mount indexing aborted: exceeded ${data.limits.maxEntries} entries`,
        'entries-exceeded'
      );
    }
  }

  private async readChildren(
    handle: FileSystemDirectoryHandle,
    signal: AbortSignal,
    data: MountData
  ): Promise<Array<[string, FileSystemHandle]>> {
    const entries = handle as unknown as AsyncIterable<[string, FileSystemHandle]>;
    const children: Array<[string, FileSystemHandle]> = [];
    for await (const entry of entries) {
      if (signal.aborted) break;
      if (data.directories.size + data.files.size + children.length >= data.limits.maxEntries) {
        throw new MountIndexAbortError(
          `mount indexing aborted: exceeded ${data.limits.maxEntries} entries`,
          'entries-exceeded'
        );
      }
      children.push(entry);
    }
    return children;
  }

  private async confirmNoCycle(
    basePath: string,
    handle: FileSystemDirectoryHandle,
    children: Array<[string, FileSystemHandle]>,
    signatureBuckets: Map<string, AncestorEntry[]>
  ): Promise<string> {
    const signature = computeDirSignature(children);
    const candidates = signatureBuckets.get(signature);
    if (candidates) {
      for (const ancestor of candidates) {
        if (await isSameEntrySafe(ancestor.handle, handle)) {
          throw new MountIndexAbortError(
            `mount indexing aborted: self-referential mount cycle detected at ${basePath} (re-exposes ${ancestor.path})`,
            'cycle-detected'
          );
        }
      }
    }
    return signature;
  }

  private pushAncestor(
    signatureBuckets: Map<string, AncestorEntry[]>,
    signature: string,
    basePath: string,
    handle: FileSystemDirectoryHandle
  ): AncestorEntry[] {
    let bucket = signatureBuckets.get(signature);
    if (!bucket) {
      bucket = [];
      signatureBuckets.set(signature, bucket);
    }
    bucket.push({ path: basePath, handle, signature });
    return bucket;
  }

  private popAncestor(
    signatureBuckets: Map<string, AncestorEntry[]>,
    signature: string,
    bucket: AncestorEntry[]
  ): void {
    bucket.pop();
    if (bucket.length === 0) signatureBuckets.delete(signature);
  }

  private async walkChildren(
    basePath: string,
    children: Array<[string, FileSystemHandle]>,
    data: MountData,
    signal: AbortSignal,
    depth: number,
    signatureBuckets: Map<string, AncestorEntry[]>
  ): Promise<void> {
    for (const [name, childHandle] of children) {
      if (signal.aborted) return;

      const childPath = basePath === '/' ? `/${name}` : `${basePath}/${name}`;

      if (childHandle.kind === 'file') {
        data.files.add(childPath);
        this.addPathToChildIndex(data, childPath, 'file');
        data.state.indexed++;
      } else if (childHandle.kind === 'directory') {
        if (data.limits.skipNoiseDirs && shouldSkipNoiseDir(name)) {
          continue;
        }
        this.addPathToChildIndex(data, childPath, 'directory');
        await this.walkHandle(
          childPath,
          childHandle as FileSystemDirectoryHandle,
          data,
          signal,
          depth + 1,
          signatureBuckets
        );
      }

      if (data.state.indexed % 500 === 0) {
        this.notifyListeners();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }
}
