type MockTree = Record<string, string | MockTree>;

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

class MockFsError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
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

  async createWritable(): Promise<FileSystemWritableFileStream> {
    const node = this.node;
    const chunks: Uint8Array[] = [];
    return {
      async write(chunk: unknown): Promise<void> {
        let bytes: Uint8Array;
        if (typeof chunk === 'string') {
          bytes = new TextEncoder().encode(chunk);
        } else if (chunk instanceof Uint8Array) {
          bytes = chunk;
        } else if (chunk instanceof ArrayBuffer) {
          bytes = new Uint8Array(chunk);
        } else if (chunk && typeof chunk === 'object' && 'data' in chunk) {
          const data = (chunk as { data: unknown }).data;
          if (typeof data === 'string') bytes = new TextEncoder().encode(data);
          else if (data instanceof Uint8Array) bytes = data;
          else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
          else throw new Error('Unsupported chunk data type');
        } else {
          throw new Error('Unsupported chunk type');
        }
        chunks.push(bytes);
      },
      async close(): Promise<void> {
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.byteLength;
        }
        node.content = merged;
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
    for (const [name, entry] of this.node.entries) {
      if (entry.kind === 'directory') {
        yield [name, new MockDirectoryHandle(name, entry)];
      } else {
        yield [name, new MockFileHandle(name, entry)];
      }
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
