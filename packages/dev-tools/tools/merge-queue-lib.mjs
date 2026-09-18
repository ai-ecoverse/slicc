/**
 * Merge-queue helpers for CI and Release.
 *
 * The merge queue used to wait on in-flight releases (`release-gate` polling
 * every 30s from every `merge_group` candidate). That burned the GitHub App
 * secondary rate limit and dequeued green batches. The wait is flipped:
 * Release defers while the queue has entries; the merge queue never waits on
 * Release. See `merge-queue-busy.mjs` and `.github/workflows/release.yml`.
 */

/** @typedef {{ ok: boolean, status: number, text: () => Promise<string>, json: () => Promise<unknown> }} FetchResponse */
/** @typedef {(url: string, init?: RequestInit) => Promise<FetchResponse>} FetchLike */

export const MERGE_QUEUE_COUNT_QUERY = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    mergeQueue(branch: $branch) {
      entries(first: 1) {
        totalCount
      }
    }
  }
}`;

/**
 * Trusted PRs and every non-PR event may touch staging. Fork PRs and
 * Dependabot-triggered runs skip mutation: they do not receive repository
 * Cloudflare secrets. Stacked PRs (base != main) also skip: the deploy
 * lives in `ci.yml`'s `cloudflare-worker` job, not only in
 * `worker-staging.yml`; those runs still dry-run + unit-test. On
 * `merge_group` only the queue leader (position 1) mutates the shared
 * staging Worker — followers still run dry-run + unit tests, but skip
 * turnstyle + deploy + smoke so five candidates do not serialize on
 * `staging-mutation-queue`.
 *
 * @param {{ eventName: string, isForkPr?: boolean, isDependabot?: boolean, isQueueLeader?: boolean, isStacked?: boolean }} opts
 */
export function shouldMutateCloudflareStaging({
  eventName,
  isForkPr = false,
  isDependabot = false,
  isQueueLeader = true,
  isStacked = false,
}) {
  const trusted = eventName !== 'pull_request' || (!isForkPr && !isDependabot);
  if (!trusted) return false;
  if (isStacked) return false;
  if (eventName === 'merge_group') return isQueueLeader === true;
  return true;
}

/**
 * @param {unknown} payload
 * @returns {number}
 */
export function parseMergeQueueEntryCount(payload) {
  const count = payload?.data?.repository?.mergeQueue?.entries?.totalCount;
  if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
    return count;
  }
  // No merge queue configured — GraphQL returns null (not a missing field).
  if (payload?.data?.repository && payload.data.repository.mergeQueue === null) {
    return 0;
  }
  throw new Error(`Unexpected mergeQueue payload: ${JSON.stringify(payload)}`);
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isGithubRateLimitError(err) {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /rate limit|secondary rate limit|403.*403|API rate limit exceeded/i.test(message);
}

/**
 * @param {number} attempt 1-based
 * @returns {number} milliseconds
 */
export function rateLimitBackoffMs(attempt) {
  // 5s, 15s, 45s — stay under a typical job step budget while clearing
  // secondary rate-limit windows without hammering the API.
  return 5000 * 3 ** (attempt - 1);
}

/**
 * @param {{
 *   owner: string,
 *   repo: string,
 *   branch?: string,
 *   token: string,
 *   fetchImpl?: FetchLike,
 *   sleep?: (ms: number) => Promise<void>,
 *   maxAttempts?: number,
 * }} opts
 * @returns {Promise<number>}
 */
export async function fetchMergeQueueEntryCount({
  owner,
  repo,
  branch = 'main',
  token,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxAttempts = 4,
}) {
  if (!owner || !repo) throw new Error('owner and repo are required');
  if (!token) throw new Error('token is required');

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchImpl('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'slicc-merge-queue-lib',
        },
        body: JSON.stringify({
          query: MERGE_QUEUE_COUNT_QUERY,
          variables: { owner, name: repo, branch },
        }),
      });
      const text = await response.text();
      if (!response.ok) {
        const err = new Error(`GitHub GraphQL HTTP ${response.status}: ${text}`);
        if (
          (response.status === 403 || response.status === 429) &&
          attempt < maxAttempts &&
          isGithubRateLimitError(err)
        ) {
          lastError = err;
          await sleep(rateLimitBackoffMs(attempt));
          continue;
        }
        throw err;
      }
      const payload = JSON.parse(text);
      if (Array.isArray(payload.errors) && payload.errors.length > 0) {
        const message = payload.errors.map((e) => e.message).join('; ');
        const err = new Error(`GitHub GraphQL errors: ${message}`);
        if (isGithubRateLimitError(err) && attempt < maxAttempts) {
          lastError = err;
          await sleep(rateLimitBackoffMs(attempt));
          continue;
        }
        throw err;
      }
      return parseMergeQueueEntryCount(payload);
    } catch (err) {
      lastError = err;
      if (isGithubRateLimitError(err) && attempt < maxAttempts) {
        await sleep(rateLimitBackoffMs(attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
