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

import { readFileSync } from 'node:fs';
import { createPrivateKey, randomUUID, sign } from 'node:crypto';

const API = 'https://api.appstoreconnect.apple.com/v1';

const keyId = process.env.APPLE_API_KEY_ID ?? '';
const issuerId = process.env.APPLE_API_KEY_ISSUER_ID ?? '';
const p8Path = process.env.APPLE_API_KEY_P8_PATH ?? '';
const buildNumber = process.env.SLICC_TF_BUILD_NUMBER ?? '';
const bundleId = process.env.SLICC_TF_BUNDLE_ID || 'com.sliccy.follower';
const groupName = process.env.SLICC_TF_EXTERNAL_GROUP ?? '';
// A typo'd value must degrade to the default, not to NaN: a NaN deadline
// never compares true and would turn the processing poll into an infinite
// loop with only the CI job timeout as a backstop.
const parsedTimeout = Number(process.env.SLICC_TF_PROCESSING_TIMEOUT_MINUTES || '30');
const timeoutMinutes = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 30;

if (!groupName) {
  console.log('SLICC_TF_EXTERNAL_GROUP not set — skipping TestFlight distribution.');
  process.exit(0);
}
for (const [name, value] of [
  ['APPLE_API_KEY_ID', keyId],
  ['APPLE_API_KEY_ISSUER_ID', issuerId],
  ['APPLE_API_KEY_P8_PATH', p8Path],
  ['SLICC_TF_BUILD_NUMBER', buildNumber],
]) {
  if (!value) {
    console.error(`error: ${name} is required for TestFlight distribution`);
    process.exit(1);
  }
}

function defaultWhatsNew() {
  const lines = [
    'Chat with a live SLICC agent session from your iPhone or iPad.',
    '',
    'Getting a session to join:',
    '- macOS: download https://www.sliccy.ai/download/slicc.dmg, drag Sliccstart into Applications, and launch it. With the same iCloud account on both devices the session appears under Settings automatically; otherwise paste the join link.',
  ];
  const demoUrl = process.env.SLICC_TF_DEMO_JOIN_URL ?? '';
  if (demoUrl) {
    lines.push(`- No Mac handy? Join the hosted demo session: ${demoUrl}`);
  }
  return lines.join('\n');
}

// --- Minimal ES256 JWT (dependency-free) ----------------------------------
// ASC tokens are short-lived; mint one per run, capped at the API's
// 20-minute maximum. node:crypto signs ES256 natively when told to emit
// the JOSE (ieee-p1363) signature layout instead of DER.
function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

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

async function asc(method, path, body) {
  const response = await fetch(`${API}${path}`, {
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
}

function firstErrorCode(payload) {
  return payload?.errors?.[0]?.code ?? '';
}

async function must(method, path, body, what) {
  const result = await asc(method, path, body);
  if (result.status >= 400) {
    console.error(`error: ${what} failed (HTTP ${result.status}): ${result.text.slice(0, 500)}`);
    process.exit(1);
  }
  return result.json;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- 1. Resolve app and wait for the build --------------------------------
const apps = await must(
  'GET',
  `/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=bundleId`,
  undefined,
  'app lookup'
);
const app = apps?.data?.[0];
if (!app) {
  console.error(`error: no App Store Connect app with bundle id ${bundleId}`);
  process.exit(1);
}

console.log(`Waiting for build ${buildNumber} of ${bundleId} to finish processing...`);
const deadline = Date.now() + timeoutMinutes * 60 * 1000;
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
    console.error(`error: build ${buildNumber} processing ended in ${state}`);
    process.exit(1);
  }
  if (Date.now() > deadline) {
    console.error(
      `error: build ${buildNumber} still ${state} after ${timeoutMinutes} minutes — ` +
        'raise SLICC_TF_PROCESSING_TIMEOUT_MINUTES or distribute manually'
    );
    process.exit(1);
  }
  console.log(`  ${state}; retrying in 60s`);
  await sleep(60 * 1000);
}
console.log(`Build processed: ${build.id}`);

// --- 2. What to Test -------------------------------------------------------
// Code-point-safe truncation: a plain .slice counts UTF-16 units and can
// split a surrogate pair (emoji) at the 4000-char ASC limit.
const whatsNew = [...(process.env.SLICC_TF_WHATS_NEW || defaultWhatsNew())]
  .slice(0, 4000)
  .join('');
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
console.log('What to Test notes set.');

// --- 3. Beta App Review (idempotent) ---------------------------------------
const submission = await asc('POST', '/betaAppReviewSubmissions', {
  data: {
    type: 'betaAppReviewSubmissions',
    relationships: { build: { data: { id: build.id, type: 'builds' } } },
  },
});
if (submission.status < 400) {
  console.log('Submitted for Beta App Review.');
} else if (firstErrorCode(submission.json) === 'STATE_ERROR' || submission.status === 409) {
  // Already submitted, already approved, or review not required for this
  // build — all fine for re-runs and internal-only groups.
  console.log(`Beta App Review submission skipped (${submission.text.slice(0, 200)})`);
} else {
  console.error(
    `error: Beta App Review submission failed (HTTP ${submission.status}): ${submission.text.slice(0, 500)}`
  );
  process.exit(1);
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
  console.error(`error: no tester group named "${groupName}" for ${bundleId}`);
  process.exit(1);
}
const attach = await asc('POST', `/betaGroups/${group.id}/relationships/builds`, {
  data: [{ id: build.id, type: 'builds' }],
});
if (attach.status < 400) {
  console.log(`Build ${buildNumber} attached to tester group "${groupName}".`);
} else if (firstErrorCode(attach.json) === 'STATE_ERROR' || attach.status === 409) {
  // Same idempotency contract as the review submission: a build already in
  // the group is a no-op on re-runs, not a failed release.
  console.log(`Build ${buildNumber} already in "${groupName}" (${attach.text.slice(0, 200)})`);
} else {
  console.error(
    `error: attaching build to "${groupName}" failed (HTTP ${attach.status}): ${attach.text.slice(0, 500)}`
  );
  process.exit(1);
}
