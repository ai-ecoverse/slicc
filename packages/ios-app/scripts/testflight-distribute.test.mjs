import { describe, expect, it, vi } from 'vitest';

import {
  classifyAttachOutcome,
  classifySubmitOutcome,
  composeWhatsNew,
  defaultWhatsNew,
  distribute,
  DistributionError,
  firstErrorCode,
  isSubmissionCapacityError,
  main,
  resolveVerifyOutcome,
} from './testflight-distribute.mjs';

const SUBMISSION_LIMIT = 'ENTITY_UNPROCESSABLE.SUBMISSION_LIMIT_REACHED';

describe('isSubmissionCapacityError', () => {
  it('recognizes the dotted App Store Connect submission-limit code', () => {
    expect(isSubmissionCapacityError({ status: 422, code: SUBMISSION_LIMIT })).toBe(true);
  });

  it('recognizes a bare or re-prefixed submission-limit code', () => {
    // Apple has moved these codes between prefixes before; matching the
    // suffix keeps a capacity condition from reclassifying as fatal.
    expect(isSubmissionCapacityError({ status: 422, code: 'SUBMISSION_LIMIT_REACHED' })).toBe(true);
    expect(
      isSubmissionCapacityError({ status: 422, code: 'SOMETHING.SUBMISSION_LIMIT_REACHED' })
    ).toBe(true);
  });

  it('treats HTTP 429 as capacity regardless of code', () => {
    expect(isSubmissionCapacityError({ status: 429, code: '' })).toBe(true);
  });

  it('does not treat unrelated errors as capacity', () => {
    expect(isSubmissionCapacityError({ status: 422, code: 'ENTITY_ERROR.ATTRIBUTE_INVALID' })).toBe(
      false
    );
    expect(isSubmissionCapacityError({ status: 403, code: undefined })).toBe(false);
  });
});

describe('classifySubmitOutcome', () => {
  it('reports success as submitted', () => {
    expect(classifySubmitOutcome({ status: 201, code: '' })).toBe('submitted');
  });

  it('reports the submission limit as deferred, not fatal', () => {
    expect(classifySubmitOutcome({ status: 422, code: SUBMISSION_LIMIT })).toBe('deferred');
  });

  it('reports already-submitted states as skipped', () => {
    expect(classifySubmitOutcome({ status: 409, code: '' })).toBe('skipped');
    expect(classifySubmitOutcome({ status: 422, code: 'STATE_ERROR' })).toBe('skipped');
  });

  it('reports anything else as fatal', () => {
    expect(classifySubmitOutcome({ status: 401, code: 'NOT_AUTHORIZED' })).toBe('fatal');
    expect(classifySubmitOutcome({ status: 500, code: '' })).toBe('fatal');
  });

  it('prefers deferred over skipped when a 409 also carries a capacity code', () => {
    expect(classifySubmitOutcome({ status: 409, code: SUBMISSION_LIMIT })).toBe('deferred');
  });

  it('routes INVALID_QC_STATE to verification instead of deciding blind', () => {
    // Observed re-running distribute to re-set What to Test on a build
    // whose Beta App Review was already pending — but the same code fires
    // for a REJECTED build, so the outcome depends on the actual state.
    expect(
      classifySubmitOutcome({ status: 422, code: 'ENTITY_UNPROCESSABLE.INVALID_QC_STATE' })
    ).toBe('verify');
  });
});

describe('resolveVerifyOutcome', () => {
  it('treats pending and passed reviews as the desired end state', () => {
    expect(resolveVerifyOutcome('WAITING_FOR_REVIEW')).toBe('skipped');
    expect(resolveVerifyOutcome('IN_REVIEW')).toBe('skipped');
    expect(resolveVerifyOutcome('APPROVED')).toBe('skipped');
  });

  it('keeps rejected or unreadable states fatal', () => {
    expect(resolveVerifyOutcome('REJECTED')).toBe('fatal');
    expect(resolveVerifyOutcome('')).toBe('fatal');
    expect(resolveVerifyOutcome(undefined)).toBe('fatal');
  });
});

describe('classifyAttachOutcome', () => {
  it('classifies success, idempotent repeats, and real failures', () => {
    expect(classifyAttachOutcome({ status: 204, code: '' })).toBe('attached');
    expect(classifyAttachOutcome({ status: 409, code: '' })).toBe('already-present');
    expect(classifyAttachOutcome({ status: 422, code: 'STATE_ERROR' })).toBe('already-present');
    expect(classifyAttachOutcome({ status: 403, code: 'FORBIDDEN' })).toBe('fatal');
  });

  it('keeps INVALID_QC_STATE fatal on attach, unlike submit', () => {
    // On attach this code can mean an expired or rejected build — masking
    // it as already-present would hide a real failure.
    expect(
      classifyAttachOutcome({ status: 422, code: 'ENTITY_UNPROCESSABLE.INVALID_QC_STATE' })
    ).toBe('fatal');
  });
});

describe('firstErrorCode', () => {
  it('extracts the first error code and tolerates missing shapes', () => {
    expect(firstErrorCode({ errors: [{ code: 'STATE_ERROR' }] })).toBe('STATE_ERROR');
    expect(firstErrorCode({ errors: [] })).toBe('');
    expect(firstErrorCode(null)).toBe('');
  });
});

describe('defaultWhatsNew', () => {
  it('omits the demo line when no join url is configured', () => {
    expect(defaultWhatsNew({})).not.toContain('hosted demo session');
  });

  it('appends the demo join url when set', () => {
    expect(defaultWhatsNew({ SLICC_TF_DEMO_JOIN_URL: 'https://example.test/join' })).toContain(
      'https://example.test/join'
    );
  });
});

describe('composeWhatsNew', () => {
  it('falls back to the static copy when no highlights are provided', () => {
    expect(composeWhatsNew({})).toBe(defaultWhatsNew({}));
  });

  it('falls back when highlights are whitespace-only', () => {
    // A failed generation step can leave a blank env var; that must read as
    // "no highlights", not as an empty leading section.
    expect(composeWhatsNew({ SLICC_TF_WHATS_NEW: '  \n ' })).toBe(defaultWhatsNew({}));
  });

  it('leads with the highlights and keeps the onboarding footer', () => {
    const env = {
      SLICC_TF_WHATS_NEW: 'New this week:\n- You can now do a thing.',
      SLICC_TF_DEMO_JOIN_URL: 'https://example.test/join',
    };
    const copy = composeWhatsNew(env);
    expect(copy.startsWith('New this week:')).toBe(true);
    expect(copy).toContain('Getting a session to join:');
    expect(copy).toContain('https://example.test/join');
  });

  it('caps runaway highlights so the footer survives the 4000-char ASC limit', () => {
    const copy = composeWhatsNew({ SLICC_TF_WHATS_NEW: 'x'.repeat(5000) });
    expect(copy).toContain('Getting a session to join:');
    expect([...copy].length).toBeLessThanOrEqual(4000);
  });

  it('caps highlights by code point, not UTF-16 units', () => {
    const copy = composeWhatsNew({ SLICC_TF_WHATS_NEW: '🚀'.repeat(3500) });
    // No split surrogate pair at the cap boundary.
    expect(copy).not.toContain('�');
    expect(copy).toContain('Getting a session to join:');
  });
});

// --- distribute() orchestration -------------------------------------------

const silentLog = { log: () => {}, error: () => {} };

/**
 * Minimal ASC stub. `overrides` maps "METHOD /path-prefix" to a response.
 */
function makeAsc(overrides = {}) {
  const calls = [];
  const asc = async (method, path, body) => {
    calls.push({ method, path, body });
    for (const [key, response] of Object.entries(overrides)) {
      const [m, prefix] = key.split(' ');
      if (m === method && path.startsWith(prefix)) {
        return { status: 200, json: null, text: '', ...response };
      }
    }
    if (method === 'GET' && path.startsWith('/apps')) {
      return { status: 200, json: { data: [{ id: 'app-1' }] }, text: '{}' };
    }
    if (method === 'GET' && path.startsWith('/builds?')) {
      return {
        status: 200,
        json: { data: [{ id: 'build-1', attributes: { processingState: 'VALID' } }] },
        text: '{}',
      };
    }
    if (method === 'GET' && path.includes('/betaBuildLocalizations')) {
      return {
        status: 200,
        json: { data: [{ id: 'loc-1', attributes: { locale: 'en-US' } }] },
        text: '{}',
      };
    }
    if (method === 'PATCH' && path.startsWith('/betaBuildLocalizations')) {
      return { status: 200, json: {}, text: '{}' };
    }
    if (method === 'POST' && path === '/betaAppReviewSubmissions') {
      return { status: 201, json: {}, text: '{}' };
    }
    if (method === 'GET' && path.startsWith('/betaGroups')) {
      return {
        status: 200,
        json: { data: [{ id: 'group-1', attributes: { name: 'External Testers' } }] },
        text: '{}',
      };
    }
    if (method === 'POST' && path.includes('/relationships/builds')) {
      return { status: 204, json: null, text: '' };
    }
    throw new Error(`unstubbed ASC call: ${method} ${path}`);
  };
  return { asc, calls };
}

const baseArgs = {
  bundleId: 'com.sliccy.follower',
  buildNumber: '1314',
  groupName: 'External Testers',
  whatsNew: 'notes',
  sleep: async () => {},
  log: silentLog,
};

describe('distribute', () => {
  it('submits and attaches on the happy path', async () => {
    const { asc, calls } = makeAsc();
    const result = await distribute({ ...baseArgs, asc });

    expect(result).toEqual({ submit: 'submitted', attach: 'attached' });
    expect(calls.some((c) => c.path === '/betaAppReviewSubmissions')).toBe(true);
    expect(calls.some((c) => c.path.includes('/relationships/builds'))).toBe(true);
  });

  // The regression this whole change exists for: build 1314 (2026-08-06) hit
  // the submission limit, the script exited, and the build was left in no
  // tester group at all — so it could not flow to testers even after review
  // capacity returned.
  it('still attaches the build to the group when review submission is deferred', async () => {
    const { asc, calls } = makeAsc({
      'POST /betaAppReviewSubmissions': {
        status: 422,
        json: { errors: [{ code: SUBMISSION_LIMIT }] },
        text: '{"errors":[{"code":"ENTITY_UNPROCESSABLE.SUBMISSION_LIMIT_REACHED"}]}',
      },
    });

    const result = await distribute({ ...baseArgs, asc });

    expect(result).toEqual({ submit: 'deferred', attach: 'attached' });
    expect(calls.some((c) => c.path.includes('/relationships/builds'))).toBe(true);
  });

  it('emits a warning annotation when review is deferred', async () => {
    const log = { log: vi.fn(), error: vi.fn() };
    const { asc } = makeAsc({
      'POST /betaAppReviewSubmissions': {
        status: 422,
        json: { errors: [{ code: SUBMISSION_LIMIT }] },
        text: 'limit',
      },
    });

    await distribute({ ...baseArgs, asc, log });

    const warning = log.log.mock.calls.flat().find((line) => String(line).includes('::warning'));
    expect(warning).toBeDefined();
    expect(warning).toContain('1314');
  });

  it('still attaches when the build was already submitted for review', async () => {
    const { asc } = makeAsc({
      'POST /betaAppReviewSubmissions': {
        status: 409,
        json: { errors: [{ code: 'STATE_ERROR' }] },
        text: 'already',
      },
    });

    const result = await distribute({ ...baseArgs, asc });
    expect(result).toEqual({ submit: 'skipped', attach: 'attached' });
  });

  // The re-run regression observed live re-setting build 1376's What to
  // Test: INVALID_QC_STATE on an already-pending review aborted the script
  // as fatal. The pending state must read as skipped and attach must run.
  it('skips and still attaches on INVALID_QC_STATE when the review is pending', async () => {
    const { asc, calls } = makeAsc({
      'POST /betaAppReviewSubmissions': {
        status: 422,
        json: { errors: [{ code: 'ENTITY_UNPROCESSABLE.INVALID_QC_STATE' }] },
        text: 'invalid qc state',
      },
      'GET /builds/build-1/betaAppReviewSubmission': {
        status: 200,
        json: { data: { attributes: { betaReviewState: 'WAITING_FOR_REVIEW' } } },
        text: '{}',
      },
    });

    const result = await distribute({ ...baseArgs, asc });
    expect(result).toEqual({ submit: 'skipped', attach: 'attached' });
    expect(calls.some((c) => c.path.includes('/relationships/builds'))).toBe(true);
  });

  it('stays fatal on INVALID_QC_STATE when the review was rejected', async () => {
    // A rejected build can never reach external testers — masking this as
    // skipped would report success for a failed distribution.
    const { asc } = makeAsc({
      'POST /betaAppReviewSubmissions': {
        status: 422,
        json: { errors: [{ code: 'ENTITY_UNPROCESSABLE.INVALID_QC_STATE' }] },
        text: 'invalid qc state',
      },
      'GET /builds/build-1/betaAppReviewSubmission': {
        status: 200,
        json: { data: { attributes: { betaReviewState: 'REJECTED' } } },
        text: '{}',
      },
    });

    await expect(distribute({ ...baseArgs, asc })).rejects.toThrow(DistributionError);
  });

  it('throws on a genuinely failed review submission', async () => {
    const { asc } = makeAsc({
      'POST /betaAppReviewSubmissions': {
        status: 401,
        json: { errors: [{ code: 'NOT_AUTHORIZED' }] },
        text: 'nope',
      },
    });

    await expect(distribute({ ...baseArgs, asc })).rejects.toThrow(DistributionError);
  });

  it('throws when the named tester group does not exist', async () => {
    const { asc } = makeAsc({
      'GET /betaGroups': { status: 200, json: { data: [] }, text: '{}' },
    });

    await expect(distribute({ ...baseArgs, asc })).rejects.toThrow(/no tester group named/);
  });

  it('throws when the build fails processing', async () => {
    const { asc } = makeAsc({
      'GET /builds?': {
        status: 200,
        json: { data: [{ id: 'b', attributes: { processingState: 'INVALID' } }] },
        text: '{}',
      },
    });

    await expect(distribute({ ...baseArgs, asc })).rejects.toThrow(/ended in INVALID/);
  });

  it('gives up once the processing deadline passes', async () => {
    const { asc } = makeAsc({
      'GET /builds?': {
        status: 200,
        json: { data: [{ id: 'b', attributes: { processingState: 'PROCESSING' } }] },
        text: '{}',
      },
    });
    let clock = 0;
    const now = () => {
      clock += 60_000;
      return clock;
    };

    await expect(
      distribute({ ...baseArgs, asc, timeoutMinutes: 1, now })
    ).rejects.toThrow(/still PROCESSING/);
  });
});

describe('main', () => {
  it('soft-skips with exit 0 when no tester group is configured', async () => {
    expect(await main({}, silentLog)).toBe(0);
  });

  it('fails when a required credential is missing', async () => {
    const code = await main({ SLICC_TF_EXTERNAL_GROUP: 'External Testers' }, silentLog);
    expect(code).toBe(1);
  });
});
