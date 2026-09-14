import type {
  CreateOpts,
  RunResult,
  SandboxHandle,
  SandboxInfo,
  SandboxSubstrate,
  SandboxSummary,
  SubstrateId,
} from '../../src/index.js';

export interface FakeSandboxHandleOpts {
  sandboxId?: string;

  joinJson?: string;

  runStdout?: string;

  runExitCode?: number;

  runStderr?: string;

  killError?: Error;

  writes?: Array<{ path: string; contents: string | Uint8Array }>;
}

export function makeFakeHandle(opts: FakeSandboxHandleOpts = {}): SandboxHandle {
  const writes = opts.writes ?? [];
  return {
    sandboxId: opts.sandboxId ?? 'sbx-fake',
    substrate: 'e2b' as SubstrateId,
    pause: async () => {},
    kill: async () => {
      if (opts.killError) throw opts.killError;
    },
    getInfo: async (): Promise<SandboxInfo> => ({
      sandboxId: opts.sandboxId ?? 'sbx-fake',
      state: 'running',
      metadata: {},
      createdAt: new Date().toISOString(),
    }),
    writeFile: async (path: string, contents: string | Uint8Array) => {
      writes.push({ path, contents });
    },
    readFile: async (path: string): Promise<string> => {
      if (path === '/tmp/slicc-join.json') {
        return (
          opts.joinJson ??
          JSON.stringify({
            joinUrl: 'https://w/join/fake',
            trayId: 't-fake',
            updatedAt: new Date().toISOString(),
          })
        );
      }
      throw new Error(`ENOENT ${path}`);
    },
    run: async (_cmd: string): Promise<RunResult> => ({
      stdout: opts.runStdout ?? '200',
      stderr: opts.runStderr ?? '',
      exitCode: opts.runExitCode ?? 0,
    }),
  };
}

export interface FakeSubstrateOpts {
  handle?: SandboxHandle;

  connectError?: Error;

  onCreate?: (opts: CreateOpts) => Promise<SandboxHandle>;

  creates?: CreateOpts[];

  listResult?: SandboxSummary[];

  timeoutCalls?: Array<{ sandboxId: string; ttlMs: number }>;
}

export function makeFakeSubstrate(opts: FakeSubstrateOpts = {}): SandboxSubstrate {
  const handle = opts.handle ?? makeFakeHandle();
  const creates = opts.creates ?? [];
  const listResult = opts.listResult ?? [];
  const timeoutCalls = opts.timeoutCalls ?? [];

  return {
    id: 'e2b' as SubstrateId,
    async create(createOpts: CreateOpts) {
      creates.push(createOpts);
      if (opts.onCreate) return opts.onCreate(createOpts);
      return handle;
    },
    async connect(_id: string) {
      if (opts.connectError) throw opts.connectError;
      return handle;
    },
    async list(listOpts?: import('../../src/substrate.js').ListOpts) {
      if (!listOpts?.metadata) return listResult;
      const filterMetadata = listOpts.metadata;
      return listResult.filter((s) => {
        if (!s.metadata) return false;
        for (const [k, v] of Object.entries(filterMetadata)) {
          if (s.metadata[k] !== v) return false;
        }
        return true;
      });
    },
    async extendTimeout(sandboxId: string, ttlMs: number): Promise<void> {
      timeoutCalls.push({ sandboxId, ttlMs });
    },
  };
}
