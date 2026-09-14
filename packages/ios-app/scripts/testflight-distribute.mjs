#!/usr/bin/env node




































import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API = 'https://api.appstoreconnect.apple.com/v1';






export class DistributionError extends Error {}







export const IDEMPOTENT_ERROR_CODES = new Set(['STATE_ERROR']);











export function isSubmissionCapacityError({ status, code }) {
  if (status === 429) return true;
  
  
  
  return typeof code === 'string' && code.includes('SUBMISSION_LIMIT_REACHED');
}









export function classifySubmitOutcome({ status, code }) {
  if (status < 400) return 'submitted';
  if (isSubmissionCapacityError({ status, code })) return 'deferred';
  if (IDEMPOTENT_ERROR_CODES.has(code) || status === 409) return 'skipped';
  
  
  
  
  
  
  
  if (typeof code === 'string' && code.includes('INVALID_QC_STATE')) return 'verify';
  return 'fatal';
}







const SETTLED_REVIEW_STATES = new Set(['WAITING_FOR_REVIEW', 'IN_REVIEW', 'APPROVED']);

export function resolveVerifyOutcome(betaReviewState) {
  return SETTLED_REVIEW_STATES.has(betaReviewState) ? 'skipped' : 'fatal';
}






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




const HIGHLIGHTS_MAX_CHARS = 3000;









export function composeWhatsNew(env = process.env) {
  const highlights = (env.SLICC_TF_WHATS_NEW ?? '').trim();
  if (!highlights) return defaultWhatsNew(env);
  
  const capped = [...highlights].slice(0, HIGHLIGHTS_MAX_CHARS).join('');
  return `${capped}\n\n${defaultWhatsNew(env)}`;
}





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
        
      }
    }
    return { status: response.status, json, text };
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));






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

  
  
  
  const submission = await asc('POST', '/betaAppReviewSubmissions', {
    data: {
      type: 'betaAppReviewSubmissions',
      relationships: { build: { data: { id: build.id, type: 'builds' } } },
    },
  });
  let submitOutcome = classifySubmitOutcome({
    status: submission.status,
    code: firstErrorCode(submission.json),
  });
  if (submitOutcome === 'verify') {
    
    
    const review = await asc(
      'GET',
      `/builds/${build.id}/betaAppReviewSubmission?fields[betaAppReviewSubmissions]=betaReviewState`
    );
    const state = review.json?.data?.attributes?.betaReviewState ?? '';
    if (resolveVerifyOutcome(state) === 'skipped') {
      submitOutcome = 'skipped';
      log.log(`Beta App Review already ${state}; submission skipped.`);
    } else {
      throw new DistributionError(
        `Beta App Review resubmission returned INVALID_QC_STATE and the build's review state ` +
          `is "${state || 'unknown'}" (HTTP ${review.status}) — the build cannot reach external testers.`
      );
    }
  } else if (submitOutcome === 'submitted') {
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
