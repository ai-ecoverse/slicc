/**
 * Leader-origin health gate for the E2E suite (#2372).
 *
 * `wrangler dev` (workerd) dies mid-suite often enough to matter. Playwright
 * never revives a `webServer`, so the first crash turns every remaining spec
 * into a ~200 ms `ERR_CONNECTION_REFUSED` failure: a wall of red that names
 * eighteen innocent tests instead of the one thing that broke.
 *
 * This module is the containment layer. Around every test the fixture in
 * `fixtures.ts` asks whether the leader origin still answers; when it does not,
 * it asks the supervisor (`wrangler-server.ts`) to restart workerd and fails
 * only the current spec with a {@link WRANGLER_CRASHED}-named error. The suite
 * carries on against a fresh origin, and the job's failure names the cause.
 *
 * Kept free of `@playwright/test` imports (and of any ambient state beyond the
 * caller-owned {@link LeaderHealthState}) so the logic is unit-testable under
 * Vitest — see `packages/webapp/tests/e2e-harness/leader-health.test.ts`.
 */

/** `Error.name` every crash-containment failure carries, so a CI log search
 *  for one string finds the real cause of a mass e2e failure. */
export const WRANGLER_CRASHED = 'WRANGLER_CRASHED';

/** Failure raised when the leader origin is dead around a spec. */
export class WranglerCrashedError extends Error {
  override readonly name = WRANGLER_CRASHED;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<{ ok: boolean }>;

export interface LeaderHealthDeps {
  /** Worker-backed readiness URL (`<leader origin>/status`). */
  readonly statusUrl: string;
  /** Supervisor control-plane restart endpoint. */
  readonly restartUrl: string;
  readonly fetch: FetchLike;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (message: string) => void;
}

export interface LeaderHealthState {
  /** Set once a restart has failed: every later spec then fails immediately
   *  with the named error instead of burning its full timeout. */
  aborted: string | null;
  /** Restarts this worker process has driven — reported in the failure text. */
  restarts: number;
}

export function createLeaderHealthState(): LeaderHealthState {
  return { aborted: null, restarts: 0 };
}

/** How long a single probe may hang before the origin counts as unreachable.
 *  A live workerd answers `/status` in single-digit ms; a dead one refuses the
 *  connection instantly. The budget only covers a wedged-but-listening socket. */
const PROBE_TIMEOUT_MS = 5_000;
/** Probes to run before declaring death. A crashed origin refuses instantly, so
 *  the confirmation round costs nothing on the failure path and protects
 *  against a single blip on the (far more common) healthy path. */
const PROBE_ATTEMPTS = 2;
/** Bound on the supervisor's restart round-trip: workerd's cold start is ~10 s
 *  locally and can exceed a minute on a loaded runner. */
const RESTART_TIMEOUT_MS = 150_000;

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

/**
 * Is the leader origin serving? A cheap `HEAD /status` first (the worker's own
 * `fetch` handler runs, so this proves workerd is warm, not merely bound); a
 * `GET` confirmation only on failure, so one dropped response never fails a
 * spec that would otherwise have passed.
 */
export async function probeLeader(deps: LeaderHealthDeps): Promise<boolean> {
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
    if (await probeOnce(deps, attempt === 0 ? 'HEAD' : 'GET')) return true;
    if (attempt + 1 < PROBE_ATTEMPTS) await deps.sleep(250);
  }
  return false;
}

/** Ask the supervisor to respawn workerd. Resolves true once the origin
 *  answers again. A supervisor that is itself gone (connection refused) means
 *  no restart is possible — the suite then aborts with the named error. */
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

/** GitHub Actions surfaces `::warning::` lines in the job summary, so a
 *  contained crash stays visible even when the retry turns the job green. */
function warn(deps: LeaderHealthDeps, message: string): void {
  deps.log(process.env['CI'] ? `::warning title=${WRANGLER_CRASHED}::${message}` : message);
}

/**
 * Assert the leader origin is alive around `context` (a spec title), restarting
 * workerd if it is not.
 *
 * Throws {@link WranglerCrashedError} whenever the origin was found dead —
 * whether or not the restart succeeded. Failing the current spec is the point:
 * it attributes the crash to a named cause at a known moment, and the following
 * specs run against a healthy origin instead of inheriting the corpse.
 */
export async function assertLeaderAlive(
  deps: LeaderHealthDeps,
  state: LeaderHealthState,
  context: string,
  phase: 'before' | 'after'
): Promise<void> {
  if (state.aborted) {
    throw new WranglerCrashedError(
      `Leader origin (wrangler dev) is down and could not be restarted; skipping "${context}". ` +
        `First failure: ${state.aborted}`
    );
  }
  if (await probeLeader(deps)) return;

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
