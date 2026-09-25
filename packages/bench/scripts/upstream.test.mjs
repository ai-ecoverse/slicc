import { describe, expect, it } from 'vitest';
import {
  decryptSetFile,
  encryptJson,
  extractOptionalPythonInt,
  extractPythonInt,
  extractPythonString,
  fernetDecrypt,
  fernetEncrypt,
  fernetKey,
  loadFindingsSpec,
  loadUpstreamSet,
  provenance,
  rawUrl,
  UPSTREAM,
} from './upstream.mjs';

// Made with Python's `cryptography` (what browser-use uses):
//   Fernet(urlsafe_b64(sha256(b'Test_Bench')))._encrypt_from_parts(payload, 1790000000, bytes(range(16)))
const PY_TOKEN =
  'gAAAAABqsTuAAAECAwQFBgcICQoLDA0OD3n6Qmk1D1S2OJUmFPZw2en2AAGnbVARoA9DrHWxFBCByAEYt4JysubpmkjISJ_NZhvwFsTWJWXOI83WmETr4TRgE8Yv5TTAvD1MBwp9_hzY';
const PY_PAYLOAD = '[{"task_id":"t1","confirmed_task":"hello"}]';

describe('Fernet', () => {
  it('decrypts a token made by Python cryptography', () => {
    expect(fernetDecrypt(PY_TOKEN, fernetKey('Test_Bench')).toString('utf8')).toBe(PY_PAYLOAD);
  });

  it('encrypts byte-for-byte like Python for the same time and iv', () => {
    const token = fernetEncrypt(Buffer.from(PY_PAYLOAD), fernetKey('Test_Bench'), {
      now: 1790000000 * 1000,
      iv: Buffer.from([...Array(16).keys()]),
    });
    expect(token).toBe(PY_TOKEN);
  });

  it('rejects the wrong key and a non-token', () => {
    expect(() => fernetDecrypt(PY_TOKEN, fernetKey('Other'))).toThrow(/signature/);
    expect(() => fernetDecrypt('abc', fernetKey('Test_Bench'))).toThrow(/not a Fernet token/);
  });

  it('reads a published .enc file (base64 of the token) and writes one back', () => {
    const file = Buffer.from(PY_TOKEN).toString('base64');
    expect(decryptSetFile(file, 'Test_Bench')).toEqual(JSON.parse(PY_PAYLOAD));
    const round = encryptJson({ a: 1, text: 'ünïcode' }, 'Test_Bench');
    expect(decryptSetFile(round, 'Test_Bench')).toEqual({ a: 1, text: 'ünïcode' });
  });
});

const PY_SOURCE = `
FINDINGS_SYSTEM_PROMPT = """
<role>
Judge things.
</role>
"""

TASK_MAX_CHARS = 40_000
WEBSITE_MAX_CHARS = 4_000
RUBRIC_MAX_CHARS = 100_000
FINAL_RESULT_MAX_CHARS = 100_000
TRAJECTORY_MAX_CHARS = 700_000
FILES_MAX_CHARS = 600_000
`;

function fakeFetch(files) {
  return async (url) => {
    const path = url.split(`${UPSTREAM.commit}/`)[1];
    if (!(path in files)) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => files[path] };
  };
}

describe('upstream files', () => {
  it('builds raw URLs at the pinned commit', () => {
    expect(rawUrl('judge.py')).toBe(
      `https://raw.githubusercontent.com/browser-use/benchmark/${UPSTREAM.commit}/judge.py`
    );
  });

  it('extracts the published judge prompt and caps', async () => {
    expect(extractPythonString(PY_SOURCE, 'FINDINGS_SYSTEM_PROMPT')).toBe(
      '<role>\nJudge things.\n</role>'
    );
    expect(extractPythonInt(PY_SOURCE, 'TRAJECTORY_MAX_CHARS')).toBe(700000);
    expect(() => extractPythonString(PY_SOURCE, 'MISSING')).toThrow(/not found/);
    expect(() => extractPythonInt(PY_SOURCE, 'MISSING')).toThrow(/not found/);
    const spec = await loadFindingsSpec({
      fetchImpl: fakeFetch({ 'findings_judge.py': PY_SOURCE }),
    });
    expect(spec.caps).toEqual({
      task: 40000,
      website: 4000,
      rubric: 100000,
      finalResult: 100000,
      trajectory: 700000,
      files: 600000,
    });
    expect(spec.source).toBe(`browser-use/benchmark@${UPSTREAM.commit}`);
  });

  it('loads and decrypts a known set, and refuses unknown names and missing files', async () => {
    const file = encryptJson([{ task_id: 'x' }], 'BU_Bench_V1');
    const fetchImpl = fakeFetch({ 'BU_Bench_V1.enc': file });
    expect(await loadUpstreamSet('BU_Bench_V1', { fetchImpl })).toEqual([{ task_id: 'x' }]);
    await expect(loadUpstreamSet('Nope', { fetchImpl })).rejects.toThrow(/unknown upstream set/);
    await expect(loadUpstreamSet('BU_Bench_V2', { fetchImpl })).rejects.toThrow(/HTTP 404/);
  });

  it('pins the v2.1.1 release and says where a set came from', async () => {
    expect(UPSTREAM).toMatchObject({
      tag: 'v2.1.1',
      commit: 'af6c7f7f6772b6985b7644f660cac87fd4b03583',
    });
    const file = encryptJson([{ task_id: 'x' }], 'BU_Bench_V1');
    const got = await loadUpstreamSet('BU_Bench_V1', {
      fetchImpl: fakeFetch({ 'BU_Bench_V1.enc': file }),
      withProvenance: true,
    });
    expect(got.data).toEqual([{ task_id: 'x' }]);
    expect(got.provenance).toEqual({
      repo: 'browser-use/benchmark',
      tag: 'v2.1.1',
      commit: UPSTREAM.commit,
      file: 'BU_Bench_V1.enc',
      sha256: provenance('BU_Bench_V1', file).sha256,
    });
    expect(got.provenance.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance('X', 'a', { repo: 'r', commit: 'c' })).toMatchObject({
      tag: null,
      commit: 'c',
    });
  });

  it('reads the V2.1 judge, which has no task or rubric cap', async () => {
    const v21 = PY_SOURCE.replace(/^TASK_MAX_CHARS.*\n/m, '').replace(/^RUBRIC_MAX_CHARS.*\n/m, '');
    expect(extractOptionalPythonInt(v21, 'TASK_MAX_CHARS')).toBeNull();
    expect(extractOptionalPythonInt(PY_SOURCE, 'TASK_MAX_CHARS')).toBe(40000);
    const spec = await loadFindingsSpec({ fetchImpl: fakeFetch({ 'findings_judge.py': v21 }) });
    expect(spec.caps).toMatchObject({ task: null, rubric: null, trajectory: 700000 });
  });
});
