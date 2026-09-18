import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const workerStagingWorkflow = readFileSync('.github/workflows/worker-staging.yml', 'utf8');

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

function workerStagingFilterPaths(name, nextMarker) {
  const filters = workerStagingWorkflow.indexOf('          filters: |');
  const start = workerStagingWorkflow.indexOf(`            ${name}:`, filters);
  const end = workerStagingWorkflow.indexOf(nextMarker, start);
  expect(start, `worker staging ${name} filter should exist`).toBeGreaterThan(filters);
  expect(end, `worker staging marker should follow its ${name} filter`).toBeGreaterThan(start);
  return [...workerStagingWorkflow.slice(start, end).matchAll(/- '([^']+)'/g)].map(
    (match) => match[1]
  );
}

describe('CI critical-path routing', () => {
  const e2e = jobBody('e2e', 'node-server');
  const worker = jobBody('cloudflare-worker', 'cloud-core');

  it('runs the medium E2E suite on pull requests and the full suite after', async () => {
    const { MQ_ONLY_SPEC_BASENAMES } = await import('../../webapp/tests/e2e/mq-only-specs.ts');
    expect(MQ_ONLY_SPEC_BASENAMES.length).toBeGreaterThan(0);
    expect(MQ_ONLY_SPEC_BASENAMES).toEqual(
      expect.arrayContaining([
        'multiple-cones.test.ts',
        'multiple-cones-follower.test.ts',
        'multiple-cones-licks.test.ts',
        'compaction-robustness.test.ts',
        'roving-tray-webhook.test.ts',
        'sprinkle-details.test.ts',
        'speech-roundtrip.test.ts',
      ])
    );

    const prSuite = stepBody(e2e, 'PR E2E suite');
    expect(prSuite).toContain("if: github.event_name == 'pull_request'");
    expect(prSuite).toMatch(/run: npm run test:e2e\s/);
    expect(prSuite).toContain("SLICC_E2E_PR: '1'");
    expect(prSuite).not.toContain('reference-scenario.test.ts');

    const full = stepBody(e2e, 'Full E2E suite');
    expect(full).toContain("if: github.event_name != 'pull_request'");
    expect(full).toMatch(/run: npm run test:e2e\s/);
    expect(full).not.toContain('SLICC_E2E_PR');

    const playwrightConfig = readFileSync('packages/webapp/tests/e2e/playwright.config.ts', 'utf8');
    expect(playwrightConfig).toContain("from './mq-only-specs'");
    expect(playwrightConfig).toContain("process.env['SLICC_E2E_PR'] === '1'");
    expect(playwrightConfig).toContain('MQ_ONLY_SPEC_BASENAMES');
  });

  it('tracks the costly checks with dedicated, reviewable path filters', () => {
    const r2BuildInputs = [
      'packages/webapp/**',
      'packages/vfs-root/**',
      'packages/assets/**',
      'packages/shared-ts/**',
      'packages/webcomponents/**',
      'packages/spoon/**',
      'packages/cloud-core/**',
      'packages/dev-tools/providers.build.json',
      'packages/cloudflare-worker/scripts/upload-assets-to-r2.mjs',
      'packages/cloudflare-worker/scripts/upload-lib.mjs',
      'packages/cloudflare-worker/scripts/verify-preview-lifecycle.mjs',
      'packages/cloudflare-worker/src/asset-archive.mjs',
      'packages/cloudflare-worker/tests/deployed.test.ts',
      'packages/cloudflare-worker/wrangler.jsonc',
      'package.json',
      'package-lock.json',
      'patches/**',
    ];
    expect(filterPaths('cloudflare-r2', 'cloudflare-archive-smoke')).toEqual([
      ...r2BuildInputs,
      '.github/workflows/ci.yml',
    ]);
    expect(workerStagingFilterPaths('r2', '            archive-smoke:')).toEqual([
      ...r2BuildInputs,
      '.github/workflows/worker-staging.yml',
    ]);
    expect(filterPaths('cloudflare-archive-smoke', 'e2e')).toEqual([
      'packages/cloudflare-worker/src/index.ts',
    ]);
    expect(workerStagingFilterPaths('archive-smoke', '\n\n      - uses:')).toEqual([
      'packages/cloudflare-worker/src/index.ts',
    ]);

    const e2ePaths = filterPaths('e2e', 'cherry');
    expect(e2ePaths).toContain('packages/webapp/**');
    expect(e2ePaths).not.toContain('coverage-thresholds.json');
  });

  it('keeps staging deploy and smoke on every trusted PR while path-gating only R2', () => {
    const header = worker.slice(0, worker.indexOf('    steps:'));
    expect(workerStagingWorkflow).toContain(
      "run-name: 'staging-mutation-queue · Worker staging · PR #${{ github.event.pull_request.number }}'"
    );
    expect(header).not.toContain('\n    if:');

    expect(header).toContain(
      "RUN_CLOUDFLARE_STAGING: ${{ (github.event_name != 'pull_request' || (github.event.pull_request.head.repo.fork == false && github.actor != 'dependabot[bot]')) && (github.event_name != 'merge_group' || needs.changes.outputs.is-queue-leader == 'true') }}"
    );
    expect(header).not.toContain('worker-staging-e2b-slicc-staging');
    expect(workerStagingWorkflow).not.toContain('worker-staging-e2b-slicc-staging');

    for (const source of [worker, workerStagingWorkflow]) {
      expect(source).toContain(
        'uses: softprops/turnstyle@3805450be63b8c80577dc253e8c17e9132036df4 # v3.3.3'
      );
      expect(source).toContain('queue-name: staging-mutation-queue');
      expect(source).toContain('same-branch-only: false');
      expect(source).toContain('job-to-wait-for: Cloudflare staging deploy');
      expect(source).toContain('step-to-wait-for: Release staging mutation queue');
      expect(source).toContain('- name: Release staging mutation queue');
    }

    const lifecycle = stepBody(worker, 'Verify preview storage lifecycle');
    expect(lifecycle).toContain("if: env.RUN_CLOUDFLARE_STAGING == 'true'");
    expect(lifecycle).not.toContain('needs.changes.outputs.cloudflare-r2');

    const archive = stepBody(worker, 'Archive assets to R2 (staging)');
    expect(archive).toContain("if: env.RUN_CLOUDFLARE_STAGING == 'true'");
    expect(archive).toContain("needs.changes.outputs.cloudflare-r2 == 'true'");

    const stagingSteps = [
      'Deploy staging worker (attempt 1)',
      'Upload staging secrets (attempt 1)',
      'Wait before staging deploy retry 2',
      'Deploy staging worker (attempt 2)',
      'Upload staging secrets (attempt 2)',
      'Wait before staging deploy retry 3',
      'Deploy staging worker (attempt 3)',
      'Upload staging secrets (attempt 3)',
      'Finalize staging deploy',
      'Deploy staging preview worker',
    ];

    for (const name of stagingSteps) {
      const step = stepBody(worker, name);
      expect(step).toContain("env.RUN_CLOUDFLARE_STAGING == 'true'");
      expect(step).not.toContain('needs.changes.outputs.cloudflare-r2');
    }

    const smoke = stepBody(worker, 'Smoke test staging');
    expect(smoke).toContain("if: env.RUN_CLOUDFLARE_STAGING == 'true'");
    expect(smoke).toContain(
      "SLICC_ARCHIVE_SMOKE: ${{ (needs.changes.outputs.cloudflare-r2 == 'true' || needs.changes.outputs.cloudflare-archive-smoke == 'true') && '1' || '' }}"
    );
    expect(workerStagingWorkflow).toContain(
      "SLICC_ARCHIVE_SMOKE: ${{ (steps.changes.outputs.r2 == 'true' || steps.changes.outputs.archive-smoke == 'true') && '1' || '' }}"
    );
  });

  it('publishes phase timing summaries for both Cloudflare staging paths', () => {
    const timing = stepBody(worker, 'Publish Cloudflare timing diagnostics');
    expect(timing).toContain('ci-job-timing.mjs');
    expect(timing).toContain('--job "Cloudflare staging deploy"');
    expect(worker).toContain('name: cloudflare-worker-phase-timing');

    expect(workerStagingWorkflow).toContain('--job "Cloudflare staging deploy"');
    expect(workerStagingWorkflow).toContain('name: worker-staging-phase-timing');
    expect(workerStagingWorkflow).toContain("steps.changes.outputs.r2 == 'true'");
  });
});
