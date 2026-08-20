/** Browser-native upgrade of bundled VFS files across SLICC release refs. */
import type { Command, SecureFetch } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getLastSeenVersionReader, readSliccVersion } from '../../base/slicc-version.js';
import type { VirtualFS } from '../../fs/index.js';
import { threeWayMerge } from '../../git/merge-file-core.js';
import { getFetchBodyBytes, parseFetchJson } from '../fetch-body.js';

const REPO = 'ai-ecoverse/slicc';
const USAGE = 'usage: upgrade status | upgrade apply --from=<version> --to=<version>';
const BUNDLED_PREFIX = 'packages/vfs-root';
const FETCH_TIMEOUT_MS = 30_000;
// Directory prefixes plus one single-file scope. `MEMORY.md` and everything
// under `/etc/` are seeded only when absent, so a change to the curator
// contract or to a policy file (`sudoers`, `models`, `llmstxtignore`) would
// otherwise never reach an existing profile; the three-way merge is what makes
// that safe to ship, since those files are all meant to be user-edited.
//
// `/etc/sudoers` is self-protected, and the shell runs on the FS-gated handle,
// so applying a change there still raises a human approval — the upgrade card
// authorizes the merge, not the policy edit.
const SCOPES = [
  `${BUNDLED_PREFIX}/workspace/skills/`,
  `${BUNDLED_PREFIX}/shared/sprinkles/`,
  `${BUNDLED_PREFIX}/shared/sounds/`,
  `${BUNDLED_PREFIX}/shared/MEMORY.md`,
  `${BUNDLED_PREFIX}/etc/`,
] as const;
const CLASSIFICATIONS = [
  'auto-applied',
  'merged-clean',
  'kept-local',
  'needs-review',
  'unchanged',
  'added-new',
] as const;

export type UpgradeClassification = (typeof CLASSIFICATIONS)[number];

interface GitTreeResponse {
  truncated?: boolean;
  tree?: Array<{ path?: string; type?: string }>;
}

interface UpgradePlan {
  path: string;
  classification: UpgradeClassification;
  content?: Uint8Array;
  sidecar?: string;
}

export interface UpgradeCommandDeps {
  fs: VirtualFS;
  fetch: SecureFetch;
  /** Override the "last seen version" reader (tests). Defaults to the kernel-host-registered one. */
  getLastSeen?: () => Promise<string | null>;
}

function emptySummary(): Record<UpgradeClassification, number> {
  return Object.fromEntries(CLASSIFICATIONS.map((name) => [name, 0])) as Record<
    UpgradeClassification,
    number
  >;
}

function output(from: string, to: string, plans: UpgradePlan[], errors: string[]): string {
  const summary = emptySummary();
  for (const plan of plans) summary[plan.classification] += 1;
  return `${JSON.stringify({
    ok: errors.length === 0 && summary['needs-review'] === 0,
    from,
    to,
    results: plans.map(({ path, classification: status, sidecar }) => ({
      path,
      status,
      ...(sidecar ? { sidecar } : {}),
    })),
    summary,
    errors,
  })}\n`;
}

function parseArgs(args: string[]): { from: string; to: string } {
  if (args[0] !== 'apply') {
    throw new Error(USAGE);
  }
  const flags = new Map<string, string>();
  for (const arg of args.slice(1)) {
    const match = arg.match(/^--(from|to)=(.+)$/);
    if (!match) throw new Error(`unsupported argument: ${arg}`);
    flags.set(match[1], match[2]);
  }
  const from = flags.get('from') ?? '';
  const to = flags.get('to') ?? '';
  const safeVersion = /^v?[0-9][0-9A-Za-z.+_-]*$/;
  if (!safeVersion.test(from) || !safeVersion.test(to)) {
    throw new Error('both --from and --to must be release versions');
  }
  return { from, to };
}

function releaseRef(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

function runtimePath(repoPath: string): string | null {
  if (!SCOPES.some((prefix) => repoPath.startsWith(prefix))) return null;
  const relative = repoPath.slice(BUNDLED_PREFIX.length);
  if (!relative || relative.split('/').some((part) => part === '.' || part === '..')) {
    return null;
  }
  return relative;
}

async function checkedFetch(fetchFn: SecureFetch, url: string): ReturnType<SecureFetch> {
  let response: Awaited<ReturnType<SecureFetch>>;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    response = await Promise.race([
      fetchFn(url, { method: 'GET', headers: { Accept: 'application/json' } }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`request timed out after ${FETCH_TIMEOUT_MS}ms`)),
          FETCH_TIMEOUT_MS
        );
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`fetch failed for ${url}: ${message}`);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`fetch failed for ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  return response;
}

async function discover(ref: string, fetchFn: SecureFetch): Promise<Map<string, string>> {
  const url = `https://api.github.com/repos/${REPO}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const response = await checkedFetch(fetchFn, url);
  const tree = parseFetchJson<GitTreeResponse>(response.body);
  if (tree.truncated) throw new Error(`bundled file discovery was truncated for ${ref}`);
  if (!Array.isArray(tree.tree)) {
    throw new Error(`invalid bundled file discovery response for ${ref}`);
  }
  const files = new Map<string, string>();
  for (const item of tree.tree) {
    if (item.type !== 'blob' || typeof item.path !== 'string') continue;
    const path = runtimePath(item.path);
    if (path) files.set(path, item.path);
  }
  return files;
}

function rawUrl(ref: string, repoPath: string): string {
  const path = repoPath.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(ref)}/${path}`;
}

function equal(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  return a.every((byte, index) => byte === b[index]);
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function readLocal(fs: VirtualFS, path: string): Promise<Uint8Array | undefined> {
  if (!(await fs.exists(path))) return undefined;
  const value = await fs.readFile(path, { encoding: 'binary' });
  return value instanceof Uint8Array ? value : new TextEncoder().encode(value);
}

async function collisionSafeSidecar(
  fs: VirtualFS,
  path: string,
  from: string,
  to: string,
  blocked: Set<string>
): Promise<string> {
  const stem = `${path}.upgrade-${releaseRef(from)}-to-${releaseRef(to)}.conflict`;
  if (!blocked.has(stem) && !(await fs.exists(stem))) {
    blocked.add(stem);
    return stem;
  }
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${stem}.${suffix}`;
    if (!blocked.has(candidate) && !(await fs.exists(candidate))) {
      blocked.add(candidate);
      return candidate;
    }
  }
}

async function buildPlan(
  deps: UpgradeCommandDeps,
  path: string,
  from: string,
  to: string,
  base: Uint8Array | undefined,
  theirs: Uint8Array | undefined,
  blocked: Set<string>
): Promise<UpgradePlan> {
  const ours = await readLocal(deps.fs, path);
  if (!theirs) return { path, classification: ours ? 'kept-local' : 'unchanged' };
  if (!base) {
    if (!ours) return { path, classification: 'added-new', content: theirs };
    return { path, classification: equal(ours, theirs) ? 'unchanged' : 'kept-local' };
  }
  if (equal(base, theirs) || equal(ours, theirs)) return { path, classification: 'unchanged' };
  if (!ours) return { path, classification: 'kept-local' };
  if (equal(ours, base)) return { path, classification: 'auto-applied', content: theirs };

  const [oursText, baseText, theirsText] = [ours, base, theirs].map(decodeText);
  if (oursText !== null && baseText !== null && theirsText !== null) {
    const merged = threeWayMerge(oursText, baseText, theirsText, {
      diff3: true,
      labels: {
        current: `local:${path}`,
        base: `${releaseRef(from)}:${path}`,
        other: `${releaseRef(to)}:${path}`,
      },
    });
    const content = new TextEncoder().encode(merged.content);
    if (merged.conflicts === 0) return { path, classification: 'merged-clean', content };
    return {
      path,
      classification: 'needs-review',
      content,
      sidecar: await collisionSafeSidecar(deps.fs, path, from, to, blocked),
    };
  }
  return {
    path,
    classification: 'needs-review',
    content: theirs,
    sidecar: await collisionSafeSidecar(deps.fs, path, from, to, blocked),
  };
}

interface WriteSnapshot {
  path: string;
  content: Uint8Array | undefined;
}

async function restoreSnapshot(fs: VirtualFS, snapshot: WriteSnapshot): Promise<void> {
  if (snapshot.content) {
    await fs.writeFile(snapshot.path, snapshot.content);
  } else if (await fs.exists(snapshot.path)) {
    await fs.rm(snapshot.path);
  }
}

async function commitPlans(fs: VirtualFS, plans: UpgradePlan[]): Promise<void> {
  const writes = plans.filter(
    (plan): plan is UpgradePlan & { content: Uint8Array } => plan.content !== undefined
  );
  const snapshots = await Promise.all(
    writes.map(async (plan) => {
      const path = plan.sidecar ?? plan.path;
      return { path, content: await readLocal(fs, path) };
    })
  );
  const applied: WriteSnapshot[] = [];

  for (let index = 0; index < writes.length; index += 1) {
    const plan = writes[index];
    const snapshot = snapshots[index];
    try {
      await fs.writeFile(snapshot.path, plan.content);
      applied.push(snapshot);
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const target of [snapshot, ...applied.slice().reverse()]) {
        try {
          await restoreSnapshot(fs, target);
        } catch (rollbackError) {
          rollbackErrors.push(
            `${target.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          );
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      const rollback =
        rollbackErrors.length === 0
          ? 'all writes rolled back'
          : `rollback failed (${rollbackErrors.join('; ')})`;
      throw new Error(`apply failed for ${snapshot.path}: ${message}; ${rollback}`);
    }
  }
}

async function applyUpgrade(
  deps: UpgradeCommandDeps,
  from: string,
  to: string
): Promise<UpgradePlan[]> {
  const fromRef = releaseRef(from);
  const toRef = releaseRef(to);
  const [baseFiles, newFiles] = await Promise.all([
    discover(fromRef, deps.fetch),
    discover(toRef, deps.fetch),
  ]);
  const paths = [...new Set([...baseFiles.keys(), ...newFiles.keys()])].sort();
  const prefetched = await Promise.all(
    paths.map(async (path) => {
      const [base, theirs] = await Promise.all([
        baseFiles.has(path)
          ? checkedFetch(deps.fetch, rawUrl(fromRef, baseFiles.get(path)!)).then((response) =>
              getFetchBodyBytes(response.body)
            )
          : undefined,
        newFiles.has(path)
          ? checkedFetch(deps.fetch, rawUrl(toRef, newFiles.get(path)!)).then((response) =>
              getFetchBodyBytes(response.body)
            )
          : undefined,
      ]);
      return { path, base, theirs };
    })
  );
  const blocked = new Set(paths);
  const plans: UpgradePlan[] = [];
  for (const { path, base, theirs } of prefetched) {
    plans.push(await buildPlan(deps, path, from, to, base, theirs, blocked));
  }

  // All discovery, downloads, local reads, merges, and sidecar selection succeeded.
  await commitPlans(deps.fs, plans);
  return plans;
}

/**
 * `upgrade status` — what version is running, what version this profile last
 * booted, and whether the bundled workspace files still need merging into it.
 *
 * This is the answer to «what do I pass to `--from`?»: when a merge is pending,
 * the exact `upgrade apply` invocation is spelled out in the `apply` field.
 * Read-only — unlike `detectUpgrade()`, it never advances the last-seen marker,
 * so asking for status cannot swallow a pending upgrade lick. The marker is
 * read live through the reader the kernel host registers (see
 * `base/slicc-version.ts`), not from a snapshot, so the answer is current even
 * if boot-time detection is still in flight.
 */
async function status(deps: UpgradeCommandDeps): Promise<string> {
  const { version, releasedAt, buildId } = readSliccVersion();
  const errors: string[] = [];
  let lastSeen: string | null = null;
  const readLastSeen = deps.getLastSeen ?? getLastSeenVersionReader();
  if (!readLastSeen) {
    // No reader wired in this runtime. Report that as unknown rather than
    // letting it read as `null` — "no marker recorded" (a genuine first boot,
    // nothing to merge) and "could not look the marker up" are different
    // answers, and only one of them means `mergePending: false` is trustworthy.
    errors.push('last-seen version unavailable: no reader registered in this runtime');
  } else {
    try {
      lastSeen = await readLastSeen();
    } catch (error) {
      errors.push(
        `last-seen version unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const mergePending = lastSeen !== null && lastSeen !== version;
  return `${JSON.stringify({
    ok: errors.length === 0,
    version,
    releasedAt,
    build: buildId,
    lastSeen,
    mergePending,
    ...(mergePending ? { apply: `upgrade apply --from=${lastSeen} --to=${version}` } : {}),
    errors,
  })}\n`;
}

export function createUpgradeCommand(deps: UpgradeCommandDeps): Command {
  return defineCommand('upgrade', async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return { stdout: `${USAGE}\n`, stderr: '', exitCode: 0 };
    }

    if (args[0] === 'status') {
      if (args.length > 1) {
        return {
          stdout: output('', '', [], [`unsupported argument: ${args[1]}`]),
          stderr: '',
          exitCode: 1,
        };
      }
      return { stdout: await status(deps), stderr: '', exitCode: 0 };
    }

    let from = '';
    let to = '';
    try {
      ({ from, to } = parseArgs(args));
      const plans = await applyUpgrade(deps, from, to);
      const hasConflict = plans.some((plan) => plan.classification === 'needs-review');
      return {
        stdout: output(from, to, plans, []),
        stderr: '',
        exitCode: hasConflict ? 1 : 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { stdout: output(from, to, [], [message]), stderr: '', exitCode: 1 };
    }
  });
}
