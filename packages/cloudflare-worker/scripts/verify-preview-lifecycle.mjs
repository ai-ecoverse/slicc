#!/usr/bin/env node
// Read-only deployment prerequisite. Never provision bucket-wide policy in CI.
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const PREVIEW_PREFIX = 'previews/';
export const DAY_SECONDS = 24 * 60 * 60;
export const MAX_LIVE_OBJECT_DAYS = 60; // 30d pending + 30d after finalize.
export const MAX_EXPIRATION_DAYS = 90;
const BUCKETS = new Set(['sliccy-now-basic-storage']);
const HELP = 'Usage: node verify-preview-lifecycle.mjs <sliccy-now-basic-storage>';
const RUNBOOK = 'See .agents/skills/deploying-tray-worker/SKILL.md: Provision R2 Prerequisites.';

/** Validate the Cloudflare R2 lifecycle API response, not Wrangler's display text. */
export function verifyRules(result) {
  if (!Array.isArray(result?.rules)) throw new Error('Malformed lifecycle rules response');
  let covered = false;
  for (const rule of result.rules) {
    if (!rule || typeof rule.enabled !== 'boolean') {
      throw new Error('Malformed lifecycle rule status');
    }
    if (!rule.enabled) continue;
    // Cloudflare omits prefix for bucket-wide rules (including its default
    // multipart-abort rule). Treat omission as broad scope, not malformed data.
    const prefix = rule.conditions?.prefix === undefined ? '' : rule.conditions.prefix;
    if (typeof prefix !== 'string') throw new Error('Malformed lifecycle rule prefix');
    const overlaps = PREVIEW_PREFIX.startsWith(prefix) || prefix.startsWith(PREVIEW_PREFIX);
    if (!overlaps || !rule.deleteObjectsTransition) continue;
    const condition = rule.deleteObjectsTransition.condition;
    // Absolute dates cannot protect a sliding preview TTL. Descendant rules can
    // destroy only some previews, so they must be checked as well as ancestors.
    if (
      condition?.type !== 'Age' ||
      !Number.isFinite(condition.maxAge) ||
      condition.maxAge <= MAX_LIVE_OBJECT_DAYS * DAY_SECONDS
    ) {
      throw new Error(
        'Conflicting preview expiration: every overlapping expiration must be age-based and >60 days'
      );
    }
    if (prefix === PREVIEW_PREFIX && condition.maxAge <= MAX_EXPIRATION_DAYS * DAY_SECONDS) {
      covered = true;
    }
  }
  if (!covered) {
    throw new Error('Missing enabled previews/ age expiration with 60 < days <= 90');
  }
}

/** Bounded, authenticated GET only; failures must stop deployment. */
export async function verifyPreviewLifecycle(
  bucket,
  { env = process.env, fetchImpl = fetch, sleepImpl = sleep } = {}
) {
  if (!BUCKETS.has(bucket)) throw new Error(HELP);
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!account || !token)
    throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/r2/buckets/${bucket}/lifecycle`;
  const body = await readLifecycle(url, token, fetchImpl, sleepImpl);
  if (body?.success !== true) throw new Error('R2 lifecycle API did not report success');
  verifyRules(body.result);
}

async function readLifecycle(url, token, fetchImpl, sleepImpl) {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await readAttempt(url, token, fetchImpl);
    if (!result.transient) return result.body;
    if (attempt === attempts) {
      throw new Error(
        `R2 lifecycle transient failure exhausted after ${attempts} attempts (${result.transient}); check Cloudflare status/network and rerun. No policy was changed.`
      );
    }
    await sleepImpl(1000 * 2 ** (attempt - 1));
  }
}

async function readAttempt(url, token, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { transient: 'network/timeout' };
  }
  if (!response.ok) {
    // We never inspect error bodies; release the connection before another GET.
    await response.body?.cancel().catch(() => {});
  }
  // Never echo upstream bodies, headers, or exceptions (may contain secrets).
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `R2 lifecycle HTTP ${response.status}: authentication/permission denied; check CLOUDFLARE_API_TOKEN validity, CLOUDFLARE_ACCOUNT_ID, and Account → Workers R2 Storage → Read (or Edit) access to the preview bucket. Object-only credentials are insufficient.`
    );
  }
  if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
    return { transient: `HTTP ${response.status}` };
  }
  if (!response.ok)
    throw new Error(`R2 lifecycle HTTP ${response.status}; check bucket/account configuration`);
  try {
    return { body: await response.json() };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Malformed R2 lifecycle JSON response');
    return { transient: 'network/timeout reading response' };
  }
}

export async function main(args = process.argv.slice(2), options) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }
  if (args.length !== 1) throw new Error(HELP);
  await verifyPreviewLifecycle(args[0], options);
  console.log(`Verified preview lifecycle prerequisite: ${args[0]}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Preview lifecycle prerequisite failed: ${error.message}\n${RUNBOOK}`);
    process.exitCode = 1;
  });
}
