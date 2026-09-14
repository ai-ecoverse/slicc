import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BASELINE_PATH as FLOAT_PROBE_BASELINE_PATH } from './check-no-float-probes.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/check-touched-exemptions.mjs');
const FLOAT_PROBE_BASELINE_REL = 'packages/dev-tools/tools/float-probe-baseline.json';

function run(env, baseRef = 'origin/main') {
  try {
    return {
      code: 0,
      out: execFileSync('node', [scriptPath, baseRef], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_ACTIONS: 'true',
          GITHUB_EVENT_NAME: 'merge_group',
          GITHUB_BASE_REF: '',
          ...env,
        },
      }),
    };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const SCRATCH_GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'check-touched-exemptions test',
  GIT_AUTHOR_EMAIL: 'noreply@slicc.test',
  GIT_COMMITTER_NAME: 'check-touched-exemptions test',
  GIT_COMMITTER_EMAIL: 'noreply@slicc.test',
};

function makeScratchBaseRef(fileRelPath, content) {
  const repoDir = mkdtempSync(resolve(tmpdir(), 'touched-exemptions-scratch-'));
  const env = { ...process.env, ...SCRATCH_GIT_ENV };
  const git = (...args) =>
    execFileSync('git', args, { cwd: repoDir, env, encoding: 'utf8' }).trim();
  git('init', '-q');
  const filePath = resolve(repoDir, fileRelPath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  git('add', fileRelPath);
  git('commit', '-q', '-m', 'scratch: check-touched-exemptions test fixture');
  return {
    sha: git('rev-parse', 'HEAD'),
    objectsDir: resolve(repoDir, '.git', 'objects'),
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

const FAKE_PATH = 'packages/webapp/src/scoops/__fake_float_probe_test_file__.ts';

describe('check-touched-exemptions: float-probe debt list wiring', () => {
  const originalBaseline = readFileSync(FLOAT_PROBE_BASELINE_PATH, 'utf8');

  afterEach(() => {
    writeFileSync(FLOAT_PROBE_BASELINE_PATH, originalBaseline);
  });

  it('fails when a changed file is still on the float-probe debt list', () => {
    writeFileSync(FLOAT_PROBE_BASELINE_PATH, `${JSON.stringify({ [FAKE_PATH]: 1 }, null, 2)}\n`);
    const { code, out } = run({ CHANGED_FILES: FAKE_PATH });
    expect(code).toBe(1);
    expect(out).toContain('float-probe debt list');
    expect(out).toContain(FAKE_PATH);
  });

  it('passes when the changed file is NOT on the float-probe debt list', () => {
    const fakeContent = `${JSON.stringify({ [FAKE_PATH]: 1 }, null, 2)}\n`;
    const scratch = makeScratchBaseRef(FLOAT_PROBE_BASELINE_REL, fakeContent);
    writeFileSync(FLOAT_PROBE_BASELINE_PATH, fakeContent);
    try {
      const { code, out } = run(
        {
          CHANGED_FILES: 'packages/webapp/src/scoops/unrelated-file.ts',
          GIT_ALTERNATE_OBJECT_DIRECTORIES: scratch.objectsDir,
        },
        scratch.sha
      );
      expect(code).toBe(0);
      expect(out).toContain('OK');

      expect(out).not.toContain('could not read the float-probe debt list');
    } finally {
      scratch.cleanup();
    }
  });

  it('FAILS — does not silently skip — when an untouched file made the debt list grow', () => {
    const scratch = makeScratchBaseRef(FLOAT_PROBE_BASELINE_REL, '{}\n');
    writeFileSync(FLOAT_PROBE_BASELINE_PATH, `${JSON.stringify({ [FAKE_PATH]: 1 }, null, 2)}\n`);
    try {
      const { code, out } = run(
        {
          CHANGED_FILES: 'packages/webapp/src/scoops/unrelated-file.ts',
          GIT_ALTERNATE_OBJECT_DIRECTORIES: scratch.objectsDir,
        },
        scratch.sha
      );
      expect(code).toBe(1);
      expect(out).toContain('must not grow');
      expect(out).not.toContain('could not read the float-probe debt list');
    } finally {
      scratch.cleanup();
    }
  });

  it('passes with the real, empty baseline untouched (sanity: no debt lists at all today)', () => {
    const { code, out } = run({ CHANGED_FILES: FAKE_PATH });
    expect(code).toBe(0);
    expect(out).toContain('no debt lists found');
  });
});

describe('check-touched-exemptions: unresolvable base ref (shallow-checkout parity)', () => {
  const originalBaseline = readFileSync(FLOAT_PROBE_BASELINE_PATH, 'utf8');

  afterEach(() => {
    writeFileSync(FLOAT_PROBE_BASELINE_PATH, originalBaseline);
  });

  it('skips the added-entry check (not just "no entries added") when the base ref cannot be read', () => {
    writeFileSync(FLOAT_PROBE_BASELINE_PATH, `${JSON.stringify({ [FAKE_PATH]: 1 }, null, 2)}\n`);
    const { code, out } = run(
      { CHANGED_FILES: 'packages/webapp/src/scoops/unrelated-file.ts' },
      'this-ref-does-not-exist-anywhere'
    );
    expect(code).toBe(0);
    expect(out).toContain('notice — could not read the float-probe debt list');
    expect(out).toContain('OK');
  });

  it('still runs the touched-file check when the base ref cannot be read', () => {
    writeFileSync(FLOAT_PROBE_BASELINE_PATH, `${JSON.stringify({ [FAKE_PATH]: 1 }, null, 2)}\n`);
    const { code, out } = run({ CHANGED_FILES: FAKE_PATH }, 'this-ref-does-not-exist-anywhere');
    expect(code).toBe(1);
    expect(out).toContain('float-probe debt list');
    expect(out).toContain(FAKE_PATH);
  });
});

describe('check-touched-exemptions: merge_group skip branch (round-1 review #2843 CI failure)', () => {
  it('still skips under merge_group when CHANGED_FILES is NOT given (the legitimate case)', () => {
    const { code, out } = run({ CHANGED_FILES: '' });
    expect(code).toBe(0);
    expect(out).toContain('skipped (not a pull_request event)');
  });

  it('does NOT skip under merge_group when CHANGED_FILES IS given — the fix', () => {
    const { code, out } = run({ CHANGED_FILES: FAKE_PATH });
    expect(code).toBe(0);
    expect(out).not.toContain('skipped');
  });
});
