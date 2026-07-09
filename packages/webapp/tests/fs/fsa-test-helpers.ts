interface MockTree {
  [name: string]: string | MockTree;
}

interface MockDirectoryNode {
  kind: 'directory';
  entries: Map<string, MockNode>;
}

interface MockFileNode {
  kind: 'file';
  content: Uint8Array;
  mtime: number;
}

type MockNode = MockDirectoryNode | MockFileNode;

function setFileContent(node: MockFileNode, content: string): void {
  node.content = new TextEncoder().encode(content);
  node.mtime = Date.now();
}

// Real `DOMException` (not a plain Error) so `@zenfs/dom`'s `convertException`
// maps `.name` to the right POSIX errno. It only does that mapping for
// `ex instanceof DOMException`; any other thrown error falls through to `EIO`
// (`@zenfs/dom/dist/utils.js`). The real File System Access API throws
// `DOMException`s, so mirroring that keeps missing-path lookups (`NotFoundError`
// → `ENOENT`) faithful instead of surfacing spurious `EIO`.
class MockFsError extends DOMException {
  constructor(name: string, message: string) {
    super(message, name);
  }
}

class MockFileHandle {
  readonly kind = 'file' as const;

  constructor(
    public readonly name: string,
    private readonly node: MockFileNode
  ) {}

  async getFile(): Promise<File> {
    const bytes = new Uint8Array(this.node.content);
    return {
      size: bytes.byteLength,
      lastModified: this.node.mtime,
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.slice().buffer,
    } as File;
  }

  // Faithful `FileSystemWritableFileStream`: honors `keepExistingData`, a
  // position cursor, `seek`/`truncate`, and the `{ type, position, size, data }`
  // params-object form — the shapes `@zenfs/dom`'s `WebAccessFS.write` actually
  // emits (it seeks before offset writes and falls back to a params-object seek
  // when `stream.seek` is absent). The prior append-only stub rejected those and
  // could not run real content writes (only mount-coexistence tests used it).
  async createWritable(options?: {
    keepExistingData?: boolean;
  }): Promise<FileSystemWritableFileStream> {
    const node = this.node;
    const buffer: number[] = options?.keepExistingData ? Array.from(node.content) : [];
    let cursor = 0;
    const toBytes = (data: unknown): Uint8Array => {
      if (typeof data === 'string') return new TextEncoder().encode(data);
      if (data instanceof Uint8Array) return data;
      if (ArrayBuffer.isView(data)) {
        const v = data as ArrayBufferView;
        return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      }
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      throw new Error('Unsupported chunk data type');
    };
    const writeAt = (pos: number, bytes: Uint8Array): void => {
      for (let i = 0; i < bytes.byteLength; i++) buffer[pos + i] = bytes[i];
      cursor = pos + bytes.byteLength;
    };
    return {
      async write(chunk: unknown): Promise<void> {
        const isParams =
          chunk !== null &&
          typeof chunk === 'object' &&
          !(chunk instanceof Uint8Array) &&
          !(chunk instanceof ArrayBuffer) &&
          !ArrayBuffer.isView(chunk) &&
          ('type' in chunk || 'data' in chunk);
        if (isParams) {
          const p = chunk as { type?: string; position?: number; size?: number; data?: unknown };
          if (p.type === 'seek') {
            cursor = p.position ?? cursor;
            return;
          }
          if (p.type === 'truncate') {
            buffer.length = p.size ?? 0;
            return;
          }
          writeAt(p.position ?? cursor, toBytes(p.data));
          return;
        }
        writeAt(cursor, toBytes(chunk));
      },
      async seek(position: number): Promise<void> {
        cursor = position;
      },
      async truncate(size: number): Promise<void> {
        buffer.length = size;
      },
      async close(): Promise<void> {
        const out = new Uint8Array(buffer.length);
        for (let i = 0; i < buffer.length; i++) out[i] = buffer[i] ?? 0;
        node.content = out;
        node.mtime = Date.now();
      },
    } as unknown as FileSystemWritableFileStream;
  }
}

class MockDirectoryHandle {
  readonly kind = 'directory' as const;

  constructor(
    public readonly name: string,
    private readonly node: MockDirectoryNode
  ) {}

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<MockDirectoryHandle> {
    const entry = this.node.entries.get(name);
    if (!entry) {
      if (!options?.create) {
        throw new MockFsError('NotFoundError', `No such directory: ${name}`);
      }
      const created: MockDirectoryNode = { kind: 'directory', entries: new Map() };
      this.node.entries.set(name, created);
      return new MockDirectoryHandle(name, created);
    }
    if (entry.kind !== 'directory') {
      throw new MockFsError('TypeMismatchError', `${name} is not a directory`);
    }
    return new MockDirectoryHandle(name, entry);
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MockFileHandle> {
    const entry = this.node.entries.get(name);
    if (!entry) {
      if (!options?.create) {
        throw new MockFsError('NotFoundError', `No such file: ${name}`);
      }
      const created: MockFileNode = {
        kind: 'file',
        content: new Uint8Array(),
        mtime: Date.now(),
      };
      this.node.entries.set(name, created);
      return new MockFileHandle(name, created);
    }
    if (entry.kind !== 'file') {
      throw new MockFsError('TypeMismatchError', `${name} is not a file`);
    }
    return new MockFileHandle(name, entry);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<[string, MockDirectoryHandle | MockFileHandle]> {
    yield* this.entries();
  }

  // FileSystemDirectoryHandle exposes `entries()` / `keys()` / `values()`
  // as async iterables; `@zenfs/dom`'s `WebAccessFS._loadHandles` calls
  // `handle.entries()`. The legacy `Symbol.asyncIterator` route doesn't
  // satisfy that call site, so duplicate the yield as a named method.
  async *entries(): AsyncGenerator<[string, MockDirectoryHandle | MockFileHandle]> {
    for (const [name, entry] of this.node.entries) {
      if (entry.kind === 'directory') {
        yield [name, new MockDirectoryHandle(name, entry)];
      } else {
        yield [name, new MockFileHandle(name, entry)];
      }
    }
  }

  async *keys(): AsyncGenerator<string> {
    for (const name of this.node.entries.keys()) yield name;
  }

  async *values(): AsyncGenerator<MockDirectoryHandle | MockFileHandle> {
    for (const [, entry] of this.node.entries) {
      yield entry.kind === 'directory'
        ? new MockDirectoryHandle('', entry)
        : new MockFileHandle('', entry);
    }
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const entry = this.node.entries.get(name);
    if (!entry) {
      throw new MockFsError('NotFoundError', `No such entry: ${name}`);
    }
    if (entry.kind === 'directory' && entry.entries.size > 0 && !options?.recursive) {
      throw new MockFsError('InvalidModificationError', `Directory not empty: ${name}`);
    }
    this.node.entries.delete(name);
  }
}

function buildTree(tree: MockTree): MockDirectoryNode {
  const entries = new Map<string, MockNode>();

  for (const [name, value] of Object.entries(tree)) {
    if (typeof value === 'string') {
      entries.set(name, {
        kind: 'file',
        content: new TextEncoder().encode(value),
        mtime: Date.now(),
      });
      continue;
    }

    entries.set(name, buildTree(value));
  }

  return { kind: 'directory', entries };
}

export function createDirectoryHandle(tree: MockTree, name = 'mounted'): FileSystemDirectoryHandle {
  return new MockDirectoryHandle(name, buildTree(tree)) as unknown as FileSystemDirectoryHandle;
}

/**
 * A directory handle with a self-referential `loop` subdirectory — `loop` IS
 * the same node — so navigating `loop/loop/loop/…` never terminates. Models a
 * self-nesting local mount (a tree that re-exposes one of its own ancestors),
 * the kind of cyclic VFS that hangs an unbounded `walk()`.
 */
export function createCyclicDirectoryHandle(name = 'cyclic'): FileSystemDirectoryHandle {
  const node: MockDirectoryNode = { kind: 'directory', entries: new Map() };
  node.entries.set('a.txt', {
    kind: 'file',
    content: new TextEncoder().encode('x'),
    mtime: Date.now(),
  });
  node.entries.set('loop', node); // self-reference → cycle
  return new MockDirectoryHandle(name, node) as unknown as FileSystemDirectoryHandle;
}

export interface MutableDirectoryHandle {
  handle: FileSystemDirectoryHandle;
  setFile(path: string, content: string): void;
  removeEntry(path: string): void;
}

function getParentNode(
  root: MockDirectoryNode,
  path: string
): { parent: MockDirectoryNode; name: string } {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) {
    throw new Error('Path must not be empty');
  }

  let current = root;
  for (const part of parts.slice(0, -1)) {
    const existing = current.entries.get(part);
    if (!existing) {
      const created: MockDirectoryNode = { kind: 'directory', entries: new Map() };
      current.entries.set(part, created);
      current = created;
      continue;
    }
    if (existing.kind !== 'directory') {
      throw new Error(`Cannot create child under file: ${part}`);
    }
    current = existing;
  }

  return { parent: current, name: parts[parts.length - 1] };
}

export function createMutableDirectoryHandle(
  tree: MockTree,
  name = 'mounted'
): MutableDirectoryHandle {
  const root = buildTree(tree);

  return {
    handle: new MockDirectoryHandle(name, root) as unknown as FileSystemDirectoryHandle,
    setFile(path: string, content: string): void {
      const { parent, name: fileName } = getParentNode(root, path);
      const existing = parent.entries.get(fileName);
      if (existing && existing.kind === 'directory') {
        throw new Error(`Cannot overwrite directory with file: ${path}`);
      }
      if (existing && existing.kind === 'file') {
        setFileContent(existing, content);
        return;
      }
      parent.entries.set(fileName, {
        kind: 'file',
        content: new TextEncoder().encode(content),
        mtime: Date.now(),
      });
    },
    removeEntry(path: string): void {
      const { parent, name: entryName } = getParentNode(root, path);
      parent.entries.delete(entryName);
    },
  };
}
