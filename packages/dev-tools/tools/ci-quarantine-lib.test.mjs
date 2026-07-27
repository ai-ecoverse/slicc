import { describe, expect, it } from 'vitest';
import {
  evaluateQuarantines,
  formatUnregisteredHint,
  parseContinueOnErrorSteps,
  quarantineKey,
  validateRegistry,
} from './ci-quarantine-lib.mjs';

const WORKFLOW = `name: CI
on:
  pull_request:
    branches: [main]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: Lint
        run: npm run lint:ci
  worker:
    runs-on: ubuntu-latest
    steps:
      - name: Emit timing report
        if: always()
        # a comment mentioning continue-on-error: true must not count
        continue-on-error: true
        run: npx vitest run --reporter=junit
      - name: Deploy
        continue-on-error: true
        uses: cloudflare/wrangler-action@v4
      - name: Inline script
        run: |
          echo "continue-on-error: true"
          echo done
`;

const registryFor = (quarantines) => ({
  workflows: ['.github/workflows/ci.yml'],
  quarantines,
});

const entry = (job, step, overrides = {}) => ({
  workflow: '.github/workflows/ci.yml',
  job,
  step,
  reason: 'a genuinely explanatory reason, long enough to be meaningful',
  owner: 'cloudflare-worker',
  reviewBy: '2099-01-01',
  ...overrides,
});

describe('parseContinueOnErrorSteps', () => {
  const found = parseContinueOnErrorSteps(WORKFLOW, '.github/workflows/ci.yml');

  it('attributes each quarantine to its job and step name', () => {
    expect(found.map((f) => [f.job, f.step])).toEqual([
      ['worker', 'Emit timing report'],
      ['worker', 'Deploy'],
    ]);
  });

  it('reports the workflow path and 1-based line number', () => {
    expect(found[0].workflow).toBe('.github/workflows/ci.yml');
    expect(WORKFLOW.split('\n')[found[0].line - 1].trim()).toBe('continue-on-error: true');
  });

  it('ignores commented-out and block-scalar occurrences', () => {
    expect(found).toHaveLength(2);
  });

  it('does not confuse `on:` sub-keys with job names', () => {
    expect(found.every((f) => f.job !== 'pull_request')).toBe(true);
  });

  it('tolerates empty input', () => {
    expect(parseContinueOnErrorSteps('')).toEqual([]);
    expect(parseContinueOnErrorSteps(null)).toEqual([]);
  });

  it('falls back to a placeholder for an unnamed step', () => {
    const text =
      'jobs:\n  a:\n    steps:\n      - uses: foo/bar@v1\n        continue-on-error: true\n';
    expect(parseContinueOnErrorSteps(text)[0].step).toBe('<uses: foo/bar@v1>');
  });
});

describe('validateRegistry', () => {
  it('accepts a well-formed registry', () => {
    expect(validateRegistry(registryFor([entry('worker', 'Deploy')]))).toEqual([]);
  });

  it('rejects a placeholder reason, a missing owner and a bad date', () => {
    const problems = validateRegistry(
      registryFor([entry('worker', 'Deploy', { reason: 'flaky', owner: '', reviewBy: 'soon' })])
    );
    expect(problems.join('\n')).toContain('`reason` must be a real sentence');
    expect(problems.join('\n')).toContain('missing `owner`');
    expect(problems.join('\n')).toContain('`reviewBy` must be a YYYY-MM-DD date');
  });

  it('rejects an entry for a workflow that is not gated', () => {
    const problems = validateRegistry(
      registryFor([entry('worker', 'Deploy', { workflow: '.github/workflows/other.yml' })])
    );
    expect(problems.join('\n')).toContain('not listed in `workflows`');
  });

  it('rejects a registry that gates no workflow', () => {
    expect(validateRegistry({ quarantines: [] }).join('\n')).toContain('`workflows` must list');
  });
});

describe('evaluateQuarantines', () => {
  const found = parseContinueOnErrorSteps(WORKFLOW, '.github/workflows/ci.yml');

  it('flags an undeclared quarantine', () => {
    const result = evaluateQuarantines({
      registry: registryFor([entry('worker', 'Emit timing report')]),
      found,
      today: '2026-07-27',
    });
    expect(result.unregistered.map((u) => u.step)).toEqual(['Deploy']);
    expect(result.ok).toBe(1);
  });

  it('passes when every quarantine is declared', () => {
    const result = evaluateQuarantines({
      registry: registryFor([entry('worker', 'Emit timing report'), entry('worker', 'Deploy')]),
      found,
      today: '2026-07-27',
    });
    expect(result.unregistered).toEqual([]);
    expect(result.invalid).toEqual([]);
    expect(result.ok).toBe(2);
  });

  it('warns about an expired review date without making it a failure', () => {
    const result = evaluateQuarantines({
      registry: registryFor([
        entry('worker', 'Emit timing report', { reviewBy: '2026-01-01' }),
        entry('worker', 'Deploy'),
      ]),
      found,
      today: '2026-07-27',
    });
    expect(result.expired.map((e) => e.step)).toEqual(['Emit timing report']);
    expect(result.unregistered).toEqual([]);
    expect(result.invalid).toEqual([]);
  });

  it('warns about a registry entry whose step no longer exists', () => {
    const result = evaluateQuarantines({
      registry: registryFor([
        entry('worker', 'Emit timing report'),
        entry('worker', 'Deploy'),
        entry('worker', 'Step that was fixed'),
      ]),
      found,
      today: '2026-07-27',
    });
    expect(result.stale.map((e) => e.step)).toEqual(['Step that was fixed']);
    expect(result.unregistered).toEqual([]);
  });

  it('treats a same-named step in another job as undeclared', () => {
    const result = evaluateQuarantines({
      registry: registryFor([entry('lint', 'Deploy'), entry('worker', 'Emit timing report')]),
      found,
      today: '2026-07-27',
    });
    expect(result.unregistered.map((u) => `${u.job}/${u.step}`)).toEqual(['worker/Deploy']);
  });

  it('tolerates a registry with no quarantines array', () => {
    const result = evaluateQuarantines({ registry: { workflows: ['x'] }, found: [], today: 'x' });
    expect(result.unregistered).toEqual([]);
    expect(result.stale).toEqual([]);
  });
});

describe('quarantineKey', () => {
  it('distinguishes identical step names in different jobs', () => {
    expect(quarantineKey({ workflow: 'w', job: 'a', step: 's' })).not.toBe(
      quarantineKey({ workflow: 'w', job: 'b', step: 's' })
    );
  });
});

describe('formatUnregisteredHint', () => {
  it('emits a paste-ready registry stub', () => {
    const hint = JSON.parse(
      formatUnregisteredHint({ workflow: 'w.yml', job: 'worker', step: 'Deploy' })
    );
    expect(hint).toMatchObject({ workflow: 'w.yml', job: 'worker', step: 'Deploy' });
    expect(hint.reviewBy).toBe('YYYY-MM-DD');
  });
});
