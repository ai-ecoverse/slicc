import { Sandbox } from 'e2b';
import type {
  CreateOpts,
  RunResult,
  SandboxHandle,
  SandboxInfo,
  SandboxSubstrate,
  SubstrateConfig,
} from '../substrate.js';
import type { SandboxSummary } from '../types.js';

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export function isSliccTemplate(name: string | undefined): boolean {
  return name?.startsWith('slicc') ?? false;
}

export function createE2bSubstrate(cfg: SubstrateConfig): SandboxSubstrate {
  const apiKey = cfg.apiKey;

  const REQUEST_TIMEOUT_MS = 120_000;

  return {
    id: 'e2b',
    async create(opts: CreateOpts): Promise<SandboxHandle> {
      const sbx = await Sandbox.create(opts.template, {
        apiKey,
        envs: opts.envVars,
        metadata: opts.metadata,
        timeoutMs: DEFAULT_TTL_MS,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        ...(opts.autoPauseOnCap ? { lifecycle: { onTimeout: 'pause' } } : {}),
      });
      return wrap(sbx);
    },
    async connect(sandboxId: string): Promise<SandboxHandle> {
      const sbx = await Sandbox.connect(sandboxId, {
        apiKey,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      });
      return wrap(sbx);
    },
    async list(opts?: import('../substrate.js').ListOpts): Promise<SandboxSummary[]> {
      const paginator = Sandbox.list({
        apiKey,
        ...(opts?.metadata ? { query: { metadata: opts.metadata } } : {}),
      });
      const items: SandboxSummary[] = [];
      while (paginator.hasNext) {
        const page = await paginator.nextItems();
        for (const info of page) {
          if (isSliccTemplate(info.name)) {
            items.push({
              sandboxId: info.sandboxId,

              name: info.metadata?.['name'],
              state: mapState(info.state),
              metadata: info.metadata,
            });
          }
        }
      }
      return items;
    },
    async extendTimeout(sandboxId: string, ttlMs: number): Promise<void> {
      await Sandbox.setTimeout(sandboxId, ttlMs, { apiKey });
    },
  };
}

function wrap(sbx: Sandbox): SandboxHandle {
  return {
    sandboxId: sbx.sandboxId,
    substrate: 'e2b',
    async pause(): Promise<void> {
      await sbx.pause();
    },
    async kill(): Promise<void> {
      await sbx.kill();
    },
    async getInfo(): Promise<SandboxInfo> {
      const info = await sbx.getInfo();
      return {
        sandboxId: sbx.sandboxId,
        state: mapState(info.state),
        metadata: info.metadata,
        createdAt: info.startedAt.toISOString(),
      };
    },
    async writeFile(path, contents): Promise<void> {
      const data = contents instanceof Uint8Array ? new Blob([contents]) : contents;
      await sbx.files.write(path, data);
    },
    async readFile(path): Promise<string> {
      return sbx.files.read(path);
    },
    async run(cmd): Promise<RunResult> {
      const result = await sbx.commands.run(cmd);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
  };
}

function mapState(s: 'running' | 'paused'): 'running' | 'paused' | 'dead' {
  if (s === 'running' || s === 'paused') return s;

  return 'dead';
}
