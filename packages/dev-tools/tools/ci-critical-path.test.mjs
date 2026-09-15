import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

function jobBody(name, nextName) {
  const start = workflow.indexOf(`\n  ${name}:`);
  const end = workflow.indexOf(`\n  ${nextName}:`, start + 1);
  expect(start, `job ${name} should exist`).toBeGreaterThanOrEqual(0);
  expect(end, `job ${nextName} should follow ${name}`).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

function stepBody(job, name) {
  const marker = `      - name: ${name}`;
  const start = job.indexOf(marker);
  const end = job.indexOf('\n      - name:', start + marker.length);
  expect(start, `step ${name} should exist`).toBeGreaterThanOrEqual(0);
  return job.slice(start, end === -1 ? job.length : end);
}

function filterPaths(name, nextName) {
  const filters = workflow.indexOf('          filters: |');
  const start = workflow.indexOf(`            ${name}:`, filters);
  const end = workflow.indexOf(`            ${nextName}:`, start + 1);
  expect(start, `filter ${name} should exist`).toBeGreaterThan(filters);
  expect(end, `filter ${nextName} should follow ${name}`).toBeGreaterThan(start);
  return [...workflow.slice(start, end).matchAll(/- '([^']+)'/g)].map((match) => match[1]);
}

describe('CI critical-path routing', () => {
  const e2e = jobBody('e2e', 'node-server');
  const worker = jobBody('cloudflare-worker', 'cloud-core');

  it('runs one representative E2E scenario on pull requests and the full suite after', () => {
    const smoke = stepBody(e2e, 'PR E2E smoke test');
    expect(smoke).toContain("if: github.event_name == 'pull_request'");
    expect(smoke).toContain(
      'npm run test:e2e -- packages/webapp/tests/e2e/reference-scenario.test.ts'
    );

    const full = stepBody(e2e, 'Full E2E suite');
    expect(full).toContain("if: github.event_name != 'pull_request'");
    expect(full).toMatch(/run: npm run test:e2e\s/);
    expect(full).not.toContain('reference-scenario.test.ts');
  });

  it('tracks the costly checks with dedicated, reviewable path filters', () => {
    expect(filterPaths('cloudflare-staging', 'e2e')).toEqual([
      'packages/cloudflare-worker/**',
      'packages/cloud-core/**',
      'packages/shared-ts/**',
      'packages/webapp/src/providers/**',
      'packages/webapp/providers/**',
      'package.json',
      'package-lock.json',
      'patches/**',
      '.github/workflows/ci.yml',
    ]);

    const e2ePaths = filterPaths('e2e', 'cherry');
    expect(e2ePaths).toContain('packages/webapp/**');
    expect(e2ePaths).not.toContain('coverage-thresholds.json');
  });

  it('keeps every live staging mutation on the merge-queue side of the gate', () => {
    const stagingSteps = [
      'Archive assets to R2 (staging)',
      'Deploy staging worker (attempt 1)',
      'Upload staging secrets (attempt 1)',
      'Wait before staging deploy retry 2',
      'Deploy staging worker (attempt 2)',
      'Upload staging secrets (attempt 2)',
      'Wait before staging deploy retry 3',
      'Deploy staging worker (attempt 3)',
      'Upload staging secrets (attempt 3)',
      'Finalize staging deploy',
      'Smoke test staging',
      'Deploy staging preview worker',
    ];

    for (const name of stagingSteps) {
      const step = stepBody(worker, name);
      expect(step).toContain("github.event_name == 'merge_group'");
      expect(step).toContain("needs.changes.outputs.cloudflare-staging == 'true'");
    }

    expect(worker).not.toContain('github.event.pull_request.head.repo.fork');
  });
});
