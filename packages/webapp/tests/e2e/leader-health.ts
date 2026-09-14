export const WRANGLER_CRASHED = 'WRANGLER_CRASHED';

export class WranglerCrashedError extends Error {
  override readonly name = WRANGLER_CRASHED;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<{ ok: boolean }>;

export interface LeaderHealthDeps {
  readonly statusUrl: string;

  readonly restartUrl: string;
  readonly fetch: FetchLike;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (message: string) => void;
}

export interface LeaderHealthState {
  aborted: string | null;

  restarts: number;
}

export function createLeaderHealthState(): LeaderHealthState {
  return { aborted: null, restarts: 0 };
}

const PROBE_TIMEOUT_MS = 5_000;

const PROBE_ATTEMPTS = 2;

export const RESTART_TIMEOUT_MS = 150_000;

async function probeOnce(deps: LeaderHealthDeps, method: 'HEAD' | 'GET'): Promise<boolean> {
  try {
    const response = await deps.fetch(deps.statusUrl, {
      method,
      headers: { 'cache-control': 'no-store' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function probeLeader(deps: LeaderHealthDeps): Promise<boolean> {
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
    if (await probeOnce(deps, attempt === 0 ? 'HEAD' : 'GET')) return true;
    if (attempt + 1 < PROBE_ATTEMPTS) await deps.sleep(250);
  }
  return false;
}

async function requestRestart(deps: LeaderHealthDeps): Promise<boolean> {
  try {
    const response = await deps.fetch(deps.restartUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(RESTART_TIMEOUT_MS),
    });
    if (!response.ok) return false;
  } catch {
    return false;
  }
  return probeLeader(deps);
}

function warn(deps: LeaderHealthDeps, message: string): void {
  deps.log(process.env['CI'] ? `::warning title=${WRANGLER_CRASHED}::${message}` : message);
}

export async function assertLeaderAlive(
  deps: LeaderHealthDeps,
  state: LeaderHealthState,
  context: string,
  phase: 'before' | 'after',

  onSlowPath?: () => void
): Promise<void> {
  if (state.aborted) {
    throw new WranglerCrashedError(
      `Leader origin (wrangler dev) is down and could not be restarted; skipping "${context}". ` +
        `First failure: ${state.aborted}`
    );
  }
  if (await probeLeader(deps)) return;
  onSlowPath?.();

  const when = phase === 'before' ? `before "${context}"` : `during "${context}"`;
  warn(deps, `Leader origin ${deps.statusUrl} stopped answering ${when} — restarting wrangler.`);

  const recovered = await requestRestart(deps);
  if (!recovered) {
    const message =
      `Leader origin (wrangler dev / workerd) died ${when} and the supervisor could not ` +
      `bring it back. Remaining specs are aborted; see the wrangler crash log artifact.`;
    state.aborted = message;
    throw new WranglerCrashedError(message);
  }

  state.restarts += 1;
  throw new WranglerCrashedError(
    `Leader origin (wrangler dev / workerd) died ${when}. wrangler was restarted ` +
      `(#${state.restarts} this worker) and the suite continues; only this spec is failed, ` +
      `so a workerd crash no longer reads as a wall of unrelated test failures. ` +
      `See the wrangler crash log artifact (crash-report.md) for workerd's own output.`
  );
}
