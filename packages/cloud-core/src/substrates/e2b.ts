import { GuestUnresponsiveError, Sandbox, SandboxNotFoundError } from 'e2b';
import { CloudError } from '../errors.js';
import type {
  ConnectOpts,
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
    async connect(sandboxId: string, opts?: ConnectOpts): Promise<SandboxHandle> {
      const connectOpts = { apiKey, requestTimeoutMs: REQUEST_TIMEOUT_MS };
      try {
        // Always a plain memory restore first: a reboot drops running
        // processes and unflushed writes, so it is never the default.
        return wrap(await Sandbox.connect(sandboxId, connectOpts));
      } catch (err) {
        if (!isGuestUnresponsive(err)) throw err;
        if (!opts?.rebootIfUnresponsive) throw unresponsiveError(sandboxId);
      }
      return rebootConnect(sandboxId, connectOpts);
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
    async killById(sandboxId: string): Promise<boolean> {
      // `DELETE /sandboxes/{id}`: kills a running or paused sandbox without
      // resuming it, so one whose memory snapshot cannot be restored (and
      // whose cold boot may fail too) is still removable. `false` = not found.
      return Sandbox.kill(sandboxId, { apiKey, requestTimeoutMs: REQUEST_TIMEOUT_MS });
    },
  };
}

/**
 * e2b refuses a memory restore with `GuestUnresponsiveError` (HTTP 409,
 * `sandbox_snapshot_guest_agent_unresponsive`) when the paused sandbox's
 * snapshot was taken while its guest agent (envd) was not responding. The
 * SDK sets `name = 'GuestUnresponsiveError'`; matching on it as well covers a
 * second copy of the SDK in a bundle, where `instanceof` would miss.
 */
function isGuestUnresponsive(err: unknown): boolean {
  if (err instanceof GuestUnresponsiveError) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'GuestUnresponsiveError'
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The distinct "sandbox unresponsive" state callers can tell apart from a
 * generic failure. `reboot` carries the cold-boot retry's error when that
 * retry was attempted and failed too.
 */
function unresponsiveError(sandboxId: string, reboot?: { error: unknown }): CloudError {
  const head =
    `Sandbox ${sandboxId} is unresponsive: e2b cannot restore its memory snapshot because ` +
    'the snapshot was taken while the sandbox guest agent was not responding.';
  const tail = reboot
    ? ` Cold-booting it from its disk failed too (${errText(reboot.error)}). The sandbox stays paused ` +
      'with its disk and snapshot intact, so the resume can be retried; if it keeps failing, ' +
      'kill the sandbox and start a new cone (this discards its disk).'
    : ' Its disk is intact: resuming it cold-boots it from disk (running processes restart and ' +
      'writes not flushed before the pause are lost), or kill it and start a new cone.';
  return new CloudError('SANDBOX_UNRESPONSIVE', head + tail, { sandboxId });
}

/**
 * The one retry after a `GuestUnresponsiveError`. Per e2b, `onResume: 'reboot'`
 * "ignores any memory in the snapshot and cold-boots from disk state alone":
 * the persisted filesystem survives, running processes do not, and "writes not
 * flushed before the pause may be lost". A reboot that fails "leaves the
 * sandbox paused with its snapshot intact", so a failure here is reported as
 * SANDBOX_UNRESPONSIVE rather than a generic error. A sandbox that vanished in
 * between keeps its not-found error so `killCone` can still clean up.
 */
async function rebootConnect(
  sandboxId: string,
  connectOpts: { apiKey: string; requestTimeoutMs: number }
): Promise<SandboxHandle> {
  let sbx: Sandbox;
  try {
    sbx = await Sandbox.connect(sandboxId, { ...connectOpts, onResume: 'reboot' });
  } catch (err) {
    if (err instanceof SandboxNotFoundError) throw err;
    throw unresponsiveError(sandboxId, { error: err });
  }
  return wrap(sbx, true);
}

function wrap(sbx: Sandbox, coldBooted = false): SandboxHandle {
  return {
    sandboxId: sbx.sandboxId,
    substrate: 'e2b',
    ...(coldBooted ? { coldBooted: true } : {}),
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
    async spawn(cmd): Promise<void> {
      // `background: true` returns once the process starts; `timeoutMs: 0`
      // lifts the 60s default command timeout so a server can keep running.
      // Disconnecting only stops the event stream; e2b keeps the process alive.
      const proc = await sbx.commands.run(cmd, { background: true, timeoutMs: 0 });
      await proc.disconnect();
    },
  };
}

function mapState(s: 'running' | 'paused'): 'running' | 'paused' | 'dead' {
  // The e2b SDK only returns 'running' or 'paused'. Map appropriately.
  if (s === 'running' || s === 'paused') return s;
  // Unreachable in practice, but TypeScript needs this to satisfy the return type.
  return 'dead';
}
