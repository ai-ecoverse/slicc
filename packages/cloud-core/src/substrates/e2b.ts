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

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Does an e2b template alias belong to SLICC? `Sandbox.list` returns every
 * sandbox on the team, so we filter by template alias (`info.name`) to ignore
 * unrelated sandboxes. We match the `slicc` PREFIX, not exact `slicc`, so cones
 * booted from an isolated test alias (e.g. `slicc-test`, built via
 * SLICC_E2B_TEMPLATE_NAME) still appear in `--cloud list` instead of showing as
 * `dead`. The undefined guard keeps a nameless sandbox from throwing.
 */
export function isSliccTemplate(name: string | undefined): boolean {
  return name?.startsWith('slicc') ?? false;
}

export function createE2bSubstrate(cfg: SubstrateConfig): SandboxSubstrate {
  // Capture apiKey locally to pass explicitly to every SDK call (worker-safe).
  const apiKey = cfg.apiKey;

  // CF Workers' default subrequest timeout aborts fetches around 30s. e2b's
  // Sandbox.create resolves once the VM is restored from the paused template
  // snapshot, which can take 20-40s on a cold edge. Bump requestTimeoutMs so
  // CF doesn't abort the fetch under our feet. Same for connect (resume path).
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
      // The e2b SDK accepts query.metadata for server-side filtering.
      // Pass it through if provided.
      const paginator = Sandbox.list({
        apiKey,
        ...(opts?.metadata ? { query: { metadata: opts.metadata } } : {}),
      });
      const items: SandboxSummary[] = [];
      while (paginator.hasNext) {
        const page = await paginator.nextItems();
        for (const info of page) {
          // The SDK's `templateId` is the immutable hash (e.g. cjd0k6foq…);
          // the alias (`slicc`, `slicc-test`, …) is on `info.name`. Filter on
          // the alias prefix so isolated test-template cones list too.
          if (isSliccTemplate(info.name)) {
            items.push({
              sandboxId: info.sandboxId,
              // Sandbox name (user-supplied `--name`) lives in metadata.
              // info.name is the *template* name.
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
      // The e2b SDK accepts string | ArrayBuffer | Blob | ReadableStream.
      // If contents is Uint8Array, convert to Blob to avoid ArrayBufferLike issues.
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
  // The e2b SDK only returns 'running' or 'paused'. Map appropriately.
  if (s === 'running' || s === 'paused') return s;
  // Unreachable in practice, but TypeScript needs this to satisfy the return type.
  return 'dead';
}
