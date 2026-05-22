import { Sandbox } from 'e2b';
import type {
  CreateOpts,
  RunResult,
  SandboxHandle,
  SandboxInfo,
  SandboxSubstrate,
  SandboxSummary,
  SubstrateConfig,
} from '../substrate.js';

export function createE2bSubstrate(cfg: SubstrateConfig): SandboxSubstrate {
  // The e2b SDK reads E2B_API_KEY from env by default; set it explicitly so the
  // CLI can run from a process with no other env mutation.
  process.env['E2B_API_KEY'] = cfg.apiKey;

  return {
    id: 'e2b',
    async create(opts: CreateOpts): Promise<SandboxHandle> {
      const sbx = await Sandbox.create(opts.template, {
        envs: opts.envVars,
        metadata: opts.metadata,
        ...(opts.autoPauseOnCap ? { lifecycle: { onTimeout: 'pause' } } : {}),
      });
      return wrap(sbx);
    },
    async connect(sandboxId: string): Promise<SandboxHandle> {
      const sbx = await Sandbox.connect(sandboxId);
      return wrap(sbx);
    },
    async list(): Promise<SandboxSummary[]> {
      // The e2b SDK paginator throws on nextItems() past the end — guard
      // with hasNext (the documented pattern in the SDK examples).
      const paginator = Sandbox.list();
      const items: SandboxSummary[] = [];
      while (paginator.hasNext) {
        const page = await paginator.nextItems();
        for (const info of page) {
          // The SDK's `templateId` is the immutable hash (e.g. cjd0k6foq…);
          // the alias 'slicc' is on `info.name`. Filter on the alias.
          if (info.name === 'slicc') {
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
