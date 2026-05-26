import type {
  SandboxSubstrate,
  SandboxHandle,
  CreateOpts,
  SandboxInfo,
  SandboxSummary,
  RunResult,
} from '@slicc/cloud-core';

interface FakeSandboxData {
  id: string;
  state: 'running' | 'paused' | 'dead';
  metadata: Record<string, string>;
  files: Map<string, string>;
  name?: string;
  createdAt: string;
  runResponses: Array<RunResult | ((cmd: string) => RunResult)>;
}

export class FakeSubstrate implements SandboxSubstrate {
  readonly id = 'e2b' as const;
  readonly sandboxes = new Map<string, FakeSandboxData>();
  private nextId = 0;

  async create(opts: CreateOpts): Promise<SandboxHandle> {
    const id = `fake-${++this.nextId}`;
    const data: FakeSandboxData = {
      id,
      state: 'running',
      metadata: { ...opts.metadata },
      files: new Map(),
      name: opts.name,
      createdAt: new Date().toISOString(),
      runResponses: [],
    };
    this.sandboxes.set(id, data);
    return this.handle(data);
  }

  async connect(sandboxId: string): Promise<SandboxHandle> {
    const data = this.sandboxes.get(sandboxId);
    if (!data) throw new Error(`unknown sandbox ${sandboxId}`);
    if (data.state === 'paused') data.state = 'running';
    return this.handle(data);
  }

  async list(): Promise<SandboxSummary[]> {
    return Array.from(this.sandboxes.values()).map((d) => ({
      sandboxId: d.id,
      name: d.name,
      state: d.state,
      metadata: d.metadata,
    }));
  }

  /** Seed a file that will be readable via handle.readFile. */
  seedFile(sandboxId: string, path: string, contents: string): void {
    this.sandboxes.get(sandboxId)!.files.set(path, contents);
  }

  /** Queue a response for the next handle.run() call. */
  queueRun(sandboxId: string, response: RunResult | ((cmd: string) => RunResult)): void {
    this.sandboxes.get(sandboxId)!.runResponses.push(response);
  }

  private handle(data: FakeSandboxData): SandboxHandle {
    return {
      sandboxId: data.id,
      substrate: 'e2b',
      pause: async () => {
        data.state = 'paused';
      },
      kill: async () => {
        data.state = 'dead';
        this.sandboxes.delete(data.id);
      },
      getInfo: async (): Promise<SandboxInfo> => ({
        sandboxId: data.id,
        state: data.state,
        metadata: data.metadata,
        createdAt: data.createdAt,
      }),
      writeFile: async (path, contents) => {
        data.files.set(
          path,
          typeof contents === 'string' ? contents : new TextDecoder().decode(contents)
        );
      },
      readFile: async (path) => {
        const v = data.files.get(path);
        if (v === undefined) throw new Error(`ENOENT ${path}`);
        return v;
      },
      run: async (cmd) => {
        const next = data.runResponses.shift();
        if (!next) return { stdout: '', stderr: '', exitCode: 0 };
        return typeof next === 'function' ? next(cmd) : next;
      },
    };
  }
}
