export const MERGE_QUEUE_COUNT_QUERY = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    mergeQueue(branch: $branch) {
      entries(first: 1) {
        totalCount
      }
    }
  }
}`;

export function shouldMutateCloudflareStaging({
  eventName,
  isForkPr = false,
  isDependabot = false,
  isQueueLeader = true,
}) {
  const trusted = eventName !== 'pull_request' || (!isForkPr && !isDependabot);
  if (!trusted) return false;
  if (eventName === 'merge_group') return isQueueLeader === true;
  return true;
}

export function parseMergeQueueEntryCount(payload) {
  const count = payload?.data?.repository?.mergeQueue?.entries?.totalCount;
  if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
    return count;
  }

  if (payload?.data?.repository && payload.data.repository.mergeQueue === null) {
    return 0;
  }
  throw new Error(`Unexpected mergeQueue payload: ${JSON.stringify(payload)}`);
}

export function isGithubRateLimitError(err) {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /rate limit|secondary rate limit|403.*403|API rate limit exceeded/i.test(message);
}

export function rateLimitBackoffMs(attempt) {
  return 5000 * 3 ** (attempt - 1);
}

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
