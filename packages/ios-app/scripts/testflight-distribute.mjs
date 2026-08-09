#!/usr/bin/env node
// Post-upload TestFlight distribution via the App Store Connect API.
//
// altool only uploads; it cannot attach a build to a tester group, set
// "What to Test" notes, or submit for Beta App Review. This script closes
// that gap so a release reaches external testers without portal clicking:
//
//   1. wait until App Store Connect finishes processing the uploaded build
//   2. set the build's "What to Test" notes (en-US)
//   3. submit the build for Beta App Review (idempotent: an already
//      submitted/approved build is not an error)
//   4. attach the build to the named tester group
//
// Steps 3 and 4 are INDEPENDENT. Beta App Review runs against a version
// string; group membership is a property of the build. A build can sit in a
// group waiting for its review to clear, which is exactly the state we want
// when review is deferred — so step 4 always runs, even when step 3 could
// not submit. Aborting between them (the pre-2026-08-06 behavior) stranded
// the build in no group at all, so it could never flow to testers even
// after review capacity returned. See `classifySubmitOutcome`.
//
// Inputs (env):
//   APPLE_API_KEY_ID            App Store Connect API key id (required)
//   APPLE_API_KEY_ISSUER_ID     API key issuer id (required)
//   APPLE_API_KEY_P8_PATH       path to the .p8 private key (required)
//   SLICC_TF_BUILD_NUMBER       CFBundleVersion of the uploaded build (required)
//   SLICC_TF_BUNDLE_ID          defaults to com.sliccy.follower
//   SLICC_TF_EXTERNAL_GROUP     tester group name; empty/unset -> soft-skip exit 0
//   SLICC_TF_WHATS_NEW          What to Test text; defaults to tester onboarding
//                               instructions (macOS companion + join link)
//   SLICC_TF_DEMO_JOIN_URL      optional hosted demo session join link,
//                               appended to the default What to Test text
//   SLICC_TF_PROCESSING_TIMEOUT_MINUTES  default 30
//
// The soft-skip mirrors package-and-upload-testflight.sh: distribution is
// opt-in per repo, and a missing group name must not fail the release.

import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API = 'https://api.appstoreconnect.apple.com/v1';

/**
 * A step that failed in a way that should fail the release. Thrown instead of
 * calling process.exit inline so the orchestration is testable and so a
 * failure can never bypass the steps that are still worth attempting.
 */
export class DistributionError extends Error {}

// --- Outcome classification (pure) ----------------------------------------

/**
 * Error codes that mean "this build is already past this step". Benign on
 * re-runs and for internal-only groups: the desired end state already holds.
 */
export const IDEMPOTENT_ERROR_CODES = new Set(['STATE_ERROR']);

/**
 * Apple caps how many Beta App Review submissions an app may make in a
 * rolling window. Because semantic-release stamps a NEW marketing version on
 * every merge, and Apple requires a fresh review per version string, this
 * pipeline spends one submission per merge and periodically exhausts the
 * quota. That is a capacity condition, not a broken release: the build is
 * uploaded, valid, and already live for internal testers. Treat it as
 * deferred so the release stays green, the group attach still happens, and a
 * later run (or the backfill job) can submit once capacity returns.
 */
export function isSubmissionCapacityError({ status, code }) {
  if (status === 429) return true;
  // Match on the distinctive suffix rather than the full dotted code so an
  // Apple-side prefix change (ENTITY_UNPROCESSABLE.*) does not silently
  // reclassify a capacity condition as a fatal release failure.
  return typeof code === 'string' && code.includes('SUBMISSION_LIMIT_REACHED');
}

/**
 * Classify the POST /betaAppReviewSubmissions response.
 *
 *   'submitted' - accepted; review is now pending
 *   'skipped'   - already submitted/approved, or review not required
 *   'deferred'  - Apple has no review capacity right now; retry later
 *   'fatal'     - anything else; the release should surface this
 */
export function classifySubmitOutcome({ status, code }) {
  if (status < 400) return 'submitted';
  if (isSubmissionCapacityError({ status, code })) return 'deferred';
  if (IDEMPOTENT_ERROR_CODES.has(code) || status === 409) return 'skipped';
  return 'fatal';
}

/**
 * Classify the POST /betaGroups/{id}/relationships/builds response. Same
 * idempotency contract as the review submission: a build already in the
 * group is a no-op on re-runs, not a failed release.
 */
export function classifyAttachOutcome({ status, code }) {
  if (status < 400) return 'attached';
  if (IDEMPOTENT_ERROR_CODES.has(code) || status === 409) return 'already-present';
  return 'fatal';
}

export function firstErrorCode(payload) {
  return payload?.errors?.[0]?.code ?? '';
}

export function defaultWhatsNew(env = process.env) {
  const lines = [
    'Chat with a live SLICC agent session from your iPhone or iPad.',
    '',
    'Getting a session to join:',
    '- macOS: download https://www.sliccy.ai/download/slicc.dmg, drag Sliccstart into Applications, and launch it. With the same iCloud account on both devices the session appears under Settings automatically; otherwise paste the join link.',
  ];
  const demoUrl = env.SLICC_TF_DEMO_JOIN_URL ?? '';
  if (demoUrl) {
    lines.push(`- No Mac handy? Join the hosted demo session: ${demoUrl}`);
  }
  return lines.join('\n');
}

// Generated highlights may not crowd the onboarding footer out of the ASC
// 4000-char field — a first-launch tester needs the join instructions more
// than the tail of the changelog.
const HIGHLIGHTS_MAX_CHARS = 3000;

/**
 * Full "What to Test" copy for the build. The release pipeline may provide
 * SLICC_TF_WHATS_NEW — end-user highlights drafted from the week's iOS
 * commits; they lead, and the static onboarding copy always follows so new
 * testers keep the session-join instructions. Blank or absent highlights
 * mean the static copy stands alone (the generation step is best-effort by
 * design and must never gate a release).
 */
export function composeWhatsNew(env = process.env) {
  const highlights = (env.SLICC_TF_WHATS_NEW ?? '').trim();
  if (!highlights) return defaultWhatsNew(env);
  // Code-point-safe cap, same rationale as the 4000-char slice in main().
  const capped = [...highlights].slice(0, HIGHLIGHTS_MAX_CHARS).join('');
  return `${capped}\n\n${defaultWhatsNew(env)}`;
}

// --- Minimal ES256 JWT (dependency-free) ----------------------------------
// ASC tokens are short-lived; mint one per run, capped at the API's
// 20-minute maximum. node:crypto signs ES256 natively when told to emit
// the JOSE (ieee-p1363) signature layout instead of DER.
function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

export function createAscClient({ keyId, issuerId, p8Path, fetchImpl = fetch }) {
  function makeToken() {
    const key = createPrivateKey(readFileSync(p8Path, 'utf8'));
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
    const payload = base64url(
      JSON.stringify({
        iss: issuerId,
        iat: now,
        exp: now + 19 * 60,
        aud: 'appstoreconnect-v1',
        jti: randomUUID(),
      })
    );
    const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
      key,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    return `${header}.${payload}.${signature}`;
  }

  // Token minting is cheap; re-mint when within a minute of expiry so long
  // processing waits never present a stale token.
  let token = makeToken();
  let tokenBornAt = Date.now();
  function freshToken() {
    if (Date.now() - tokenBornAt > 18 * 60 * 1000) {
      token = makeToken();
      tokenBornAt = Date.now();
    }
    return token;
  }

  return async function asc(method, path, body) {
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${freshToken()}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // non-JSON error body; keep raw text for the error message
      }
    }
    return { status: response.status, json, text };
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Steps 1-4. Returns { submit, attach } outcome labels so the caller owns
 * the exit-code policy. Throws DistributionError for conditions that should
 * fail the release.
 */
export async function distribute({
  asc,
  bundleId,
  buildNumber,
  groupName,
  whatsNew,
  timeoutMinutes = 30,
  sleep = defaultSleep,
  log = console,
  now = () => Date.now(),
}) {
  async function must(method, path, body, what) {
    const result = await asc(method, path, body);
    if (result.status >= 400) {
      throw new DistributionError(
        `${what} failed (HTTP ${result.status}): ${result.text.slice(0, 500)}`
      );
    }
    return result.json;
  }

  // --- 1. Resolve app and wait for the build --------------------------------
  const apps = await must(
    'GET',
    `/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=bundleId`,
    undefined,
    'app lookup'
  );
  const app = apps?.data?.[0];
  if (!app) {
    throw new DistributionError(`no App Store Connect app with bundle id ${bundleId}`);
  }

  log.log(`Waiting for build ${buildNumber} of ${bundleId} to finish processing...`);
  const deadline = now() + timeoutMinutes * 60 * 1000;
  let build = null;
  for (;;) {
    const builds = await must(
      'GET',
      `/builds?filter[app]=${app.id}&filter[version]=${encodeURIComponent(buildNumber)}` +
        '&fields[builds]=processingState,version&limit=5',
      undefined,
      'build lookup'
    );
    build = builds?.data?.[0] ?? null;
    const state = build?.attributes?.processingState ?? 'NOT_VISIBLE_YET';
    if (state === 'VALID') {
      break;
    }
    if (state === 'FAILED' || state === 'INVALID') {
      throw new DistributionError(`build ${buildNumber} processing ended in ${state}`);
    }
    if (now() > deadline) {
      throw new DistributionError(
        `build ${buildNumber} still ${state} after ${timeoutMinutes} minutes — ` +
          'raise SLICC_TF_PROCESSING_TIMEOUT_MINUTES or distribute manually'
      );
    }
    log.log(`  ${state}; retrying in 60s`);
    await sleep(60 * 1000);
  }
  log.log(`Build processed: ${build.id}`);

  // --- 2. What to Test -------------------------------------------------------
  const localizations = await must(
    'GET',
    `/builds/${build.id}/betaBuildLocalizations?fields[betaBuildLocalizations]=locale`,
    undefined,
    'localization lookup'
  );
  const enUS = localizations?.data?.find((l) => l.attributes?.locale === 'en-US');
  if (enUS) {
    await must(
      'PATCH',
      `/betaBuildLocalizations/${enUS.id}`,
      {
        data: {
          id: enUS.id,
          type: 'betaBuildLocalizations',
          attributes: { whatsNew },
        },
      },
      'What to Test update'
    );
  } else {
    await must(
      'POST',
      '/betaBuildLocalizations',
      {
        data: {
          type: 'betaBuildLocalizations',
          attributes: { locale: 'en-US', whatsNew },
          relationships: { build: { data: { id: build.id, type: 'builds' } } },
        },
      },
      'What to Test creation'
    );
  }
  log.log('What to Test notes set.');

  // --- 3. Beta App Review (idempotent, never aborts) -------------------------
  // A failure here must not skip step 4: see the header note on why the two
  // steps are independent.
  const submission = await asc('POST', '/betaAppReviewSubmissions', {
    data: {
      type: 'betaAppReviewSubmissions',
      relationships: { build: { data: { id: build.id, type: 'builds' } } },
    },
  });
  const submitOutcome = classifySubmitOutcome({
    status: submission.status,
    code: firstErrorCode(submission.json),
  });
  if (submitOutcome === 'submitted') {
    log.log('Submitted for Beta App Review.');
  } else if (submitOutcome === 'skipped') {
    log.log(`Beta App Review submission skipped (${submission.text.slice(0, 200)})`);
  } else if (submitOutcome === 'deferred') {
    log.log(
      `::warning title=TestFlight beta review deferred::Build ${buildNumber} could not be ` +
        'submitted for Beta App Review — Apple reports no review capacity right now ' +
        `(HTTP ${submission.status}). The build is uploaded and live for internal testers; ` +
        'it will reach external testers once a later run resubmits it.'
    );
  } else {
    throw new DistributionError(
      `Beta App Review submission failed (HTTP ${submission.status}): ${submission.text.slice(0, 500)}`
    );
  }

  // --- 4. Attach to the tester group -----------------------------------------
  const groups = await must(
    'GET',
    `/betaGroups?filter[app]=${app.id}&filter[name]=${encodeURIComponent(groupName)}` +
      '&fields[betaGroups]=name,isInternalGroup',
    undefined,
    'tester group lookup'
  );
  const group = groups?.data?.find((g) => g.attributes?.name === groupName);
  if (!group) {
    throw new DistributionError(`no tester group named "${groupName}" for ${bundleId}`);
  }
  const attach = await asc('POST', `/betaGroups/${group.id}/relationships/builds`, {
    data: [{ id: build.id, type: 'builds' }],
  });
  const attachOutcome = classifyAttachOutcome({
    status: attach.status,
    code: firstErrorCode(attach.json),
  });
  if (attachOutcome === 'attached') {
    log.log(`Build ${buildNumber} attached to tester group "${groupName}".`);
  } else if (attachOutcome === 'already-present') {
    log.log(`Build ${buildNumber} already in "${groupName}" (${attach.text.slice(0, 200)})`);
  } else {
    throw new DistributionError(
      `attaching build to "${groupName}" failed (HTTP ${attach.status}): ${attach.text.slice(0, 500)}`
    );
  }

  return { submit: submitOutcome, attach: attachOutcome };
}

export async function main(env = process.env, log = console) {
  const keyId = env.APPLE_API_KEY_ID ?? '';
  const issuerId = env.APPLE_API_KEY_ISSUER_ID ?? '';
  const p8Path = env.APPLE_API_KEY_P8_PATH ?? '';
  const buildNumber = env.SLICC_TF_BUILD_NUMBER ?? '';
  const bundleId = env.SLICC_TF_BUNDLE_ID || 'com.sliccy.follower';
  const groupName = env.SLICC_TF_EXTERNAL_GROUP ?? '';
  // A typo'd value must degrade to the default, not to NaN: a NaN deadline
  // never compares true and would turn the processing poll into an infinite
  // loop with only the CI job timeout as a backstop.
  const parsedTimeout = Number(env.SLICC_TF_PROCESSING_TIMEOUT_MINUTES || '30');
  const timeoutMinutes = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 30;

  if (!groupName) {
    log.log('SLICC_TF_EXTERNAL_GROUP not set — skipping TestFlight distribution.');
    return 0;
  }
  for (const [name, value] of [
    ['APPLE_API_KEY_ID', keyId],
    ['APPLE_API_KEY_ISSUER_ID', issuerId],
    ['APPLE_API_KEY_P8_PATH', p8Path],
    ['SLICC_TF_BUILD_NUMBER', buildNumber],
  ]) {
    if (!value) {
      log.error(`error: ${name} is required for TestFlight distribution`);
      return 1;
    }
  }

  // Code-point-safe truncation: a plain .slice counts UTF-16 units and can
  // split a surrogate pair (emoji) at the 4000-char ASC limit.
  const whatsNew = [...composeWhatsNew(env)].slice(0, 4000).join('');

  try {
    const result = await distribute({
      asc: createAscClient({ keyId, issuerId, p8Path }),
      bundleId,
      buildNumber,
      groupName,
      whatsNew,
      timeoutMinutes,
      log,
    });
    // A deferred review is a degraded outcome, not a failed release: the ipa
    // shipped and internal testers have it. Exit 0 so a capacity condition
    // does not read as a broken pipeline, and rely on the ::warning:: above
    // for visibility.
    if (result.submit === 'deferred') {
      log.log(
        `TestFlight distribution degraded: build ${buildNumber} is in "${groupName}" but is ` +
          'not yet approved for external testing.'
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof DistributionError) {
      log.error(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(await main());
}
