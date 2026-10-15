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

function cloudflareWorkerSteps(job) {
  const start = job.indexOf('\n    steps:\n');
  expect(start, 'cloudflare-worker should have steps').toBeGreaterThanOrEqual(0);
  return job
    .slice(start + '\n    steps:\n'.length)
    .split(/\n(?= {6}- )/)
    .filter((chunk) => chunk.startsWith('      - '))
    .map((step) => {
      const name = step.match(/^ {6}- name: (.+)$/m)?.[1] ?? '';
      const runInline = step.match(/^ {8}run: ([^\n|].*)$/m)?.[1] ?? '';
      const runBlock = step.match(/^ {8}run: [|>]-?\n((?: {10}.*\n?)*)/m)?.[1] ?? '';
      const run = `${runInline}\n${runBlock}`;
      const ifInline = step.match(/^ {8}if: ([^\n|>].*)$/m)?.[1] ?? '';
      const ifBlock = step.match(/^ {8}if: [|>]-?\n((?: {10}.*\n?)*)/m)?.[1] ?? '';
      const secrets = [...step.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)].map(
        (match) => match[1]
      );
      return { name, run, if: `${ifInline}\n${ifBlock}`, secrets };
    });
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
    // Forks and Dependabot-triggered runs get no repository secrets, so both
    // skip every Cloudflare step instead of failing its credential check.
    expect(header).toContain(
      "RUN_CLOUDFLARE_STAGING: ${{ (github.event_name != 'pull_request' || (github.event.pull_request.head.repo.fork == false && github.actor != 'dependabot[bot]')) && (github.event_name != 'merge_group' || needs.changes.outputs.is-queue-leader == 'true') && needs.changes.outputs.is-stacked == 'false' }}"
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

  it('runs stacked PRs without minting a required ci check or the simulator matrix', () => {
    expect(workflow).toContain('branches-ignore: [no-comment]');
    expect(workflow).not.toMatch(/pull_request:\n {4}branches: \[main\]/);
    expect(workflow).toContain('is-stacked: ${{ steps.stacked.outputs.stacked }}');
    expect(workflow).toContain('id: stacked');
    const stacked = stepBody(jobBody('changes', 'lint'), 'Detect stacked pull request');
    expect(stacked).toContain('EVENT_NAME: ${{ github.event_name }}');
    expect(stacked).toContain('BASE_REF: ${{ github.base_ref }}');
    expect(stacked).toContain(
      'if [ "$EVENT_NAME" = "pull_request" ] && [ "$BASE_REF" != "main" ]; then'
    );
    expect(stacked).not.toContain('${{ github.event_name }}"');
    expect(stacked).not.toContain('${{ github.base_ref }}"');

    expect(stacked).toContain('set -euo pipefail');
    const stackedValidate = stepBody(jobBody('changes', 'lint'), 'Validate stacked output');
    expect(stackedValidate).toContain('if: always()');
    expect(stackedValidate).toContain('true|false');

    expect(worker.slice(0, worker.indexOf('    steps:'))).toContain(
      "needs.changes.outputs.is-stacked == 'false'"
    );

    const iosTests = jobBody('ios-app-tests', 'global-install');
    expect(iosTests).toContain("needs.changes.outputs.is-stacked == 'false'");
    expect(iosTests).toContain("needs.changes.outputs.is-queue-leader == 'true'");

    const swiftFollower = jobBody('swift-trayfollower', 'swift-widgetkit');
    expect(swiftFollower).toContain("needs.changes.outputs.is-queue-leader == 'true'");
    expect(swiftFollower).not.toContain('is-stacked');

    const iosLint = jobBody('ios-app', 'ios-app-tests');
    expect(iosLint).toContain("needs.changes.outputs.is-queue-leader == 'true'");
    expect(iosLint).not.toContain('is-stacked');

    const aggregate = workflow.slice(workflow.lastIndexOf('\n  ci:'));
    expect(aggregate).toContain(
      "name: ${{ (github.event_name == 'pull_request' && github.base_ref != 'main') && 'ci-stack' || 'ci' }}"
    );
    expect(aggregate).toContain('if: always()');
    expect(aggregate).toContain("contains(needs.*.result, 'failure')");
    expect(aggregate).toContain("contains(needs.*.result, 'cancelled')");
    expect(workflow).not.toMatch(/pull_request:\n {4}types:/);
  });

  it('gates every mutating cloudflare-worker step on RUN_CLOUDFLARE_STAGING', () => {
    const mutating = cloudflareWorkerSteps(worker).filter((step) => {
      const hasForeignSecret = step.secrets.some((name) => name !== 'GITHUB_TOKEN');
      const runForMatch = step.run.replace(/--job\s+"[^"]*"/g, '');
      const looksMutating = /deploy|wrangler|R2|secrets|smoke|preview/i.test(
        `${step.name}\n${runForMatch}`
      );
      return hasForeignSecret || looksMutating;
    });
    expect(mutating.length, 'expected at least one mutating step').toBeGreaterThan(0);
    for (const step of mutating) {
      expect(step.if, step.name || '(unnamed)').toContain("env.RUN_CLOUDFLARE_STAGING == 'true'");
    }
  });

  it('skips, rather than fails, staging mutation after a long turnstyle wait', () => {
    const header = worker.slice(0, worker.indexOf('    steps:'));
    const timeoutMinutes = Number(header.match(/\n {4}timeout-minutes: (\d+)\n/)[1]);
    const wait = stepBody(worker, 'Wait for staging mutation turn');
    expect(wait).toContain('id: turn');
    expect(wait).toContain('continue-after-seconds: ${{ steps.deadline.outputs.seconds }}');
    // The deadline counts the whole job, not only the wait, and keeps at least
    // 15 minutes for the deploy retries and both smoke tests.
    expect(worker.indexOf('- name: Record job start')).toBeLessThan(
      worker.indexOf('- uses: actions/checkout')
    );
    const deadline = stepBody(worker, 'Compute staging wait deadline');
    expect(Number(deadline.match(/JOB_TIMEOUT_SECONDS: '(\d+)'/)[1])).toBe(timeoutMinutes * 60);
    expect(Number(deadline.match(/STAGING_RESERVE_SECONDS: '(\d+)'/)[1])).toBeGreaterThanOrEqual(
      15 * 60
    );
    expect(deadline).toContain('JOB_START: ${{ steps.job-start.outputs.epoch }}');

    const report = stepBody(worker, 'Report skipped staging mutation');
    expect(report).toContain("steps.turn.outputs.force_continued == 'true'");

    const gated = cloudflareWorkerSteps(worker).filter(
      (step) =>
        step.if.includes("env.RUN_CLOUDFLARE_STAGING == 'true'") &&
        ![
          'Compute staging wait deadline',
          'Wait for staging mutation turn',
          'Report skipped staging mutation',
        ].includes(step.name)
    );
    expect(gated.length).toBeGreaterThan(10);
    for (const step of gated) {
      expect(step.if, step.name).toContain("steps.turn.outputs.force_continued != 'true'");
    }
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

const TRUSTED_RUN =
  "((github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) || (github.event_name == 'merge_group' && needs.runner.outputs.merge-group == 'same-repo') || (github.ref == 'refs/heads/main' && contains(fromJSON('[\"push\",\"schedule\",\"workflow_dispatch\"]'), github.event_name)))";

function poolRoute(variable) {
  return `\${{ ${TRUSTED_RUN} && vars.${variable} && fromJSON(startsWith(vars.${variable}, '[') && vars.${variable} || toJSON(vars.${variable})) || 'ubuntu-latest' }}`;
}

function jobBlocks() {
  const jobsStart = workflow.indexOf('\njobs:\n');
  const names = [...workflow.slice(jobsStart).matchAll(/\n {2}([a-z0-9-]+):\n/g)].map((m) => m[1]);
  return names.map((name, index) => {
    const start = workflow.indexOf(`\n  ${name}:\n`, jobsStart);
    const next = names[index + 1];
    const end = next ? workflow.indexOf(`\n  ${next}:\n`, start + 1) : workflow.length;
    return { name, body: workflow.slice(start, end) };
  });
}

// Folds a `runs-on: >-` block the way YAML does: one space per line break.
function runsOn(body) {
  const match = body.match(/\n {4}runs-on: (.*)\n((?: {6}.*\n)*)/);
  expect(match, 'job should declare runs-on').toBeTruthy();
  const head = match[1].trim();
  const folded = match[2]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\$\{\{ /, '${{ ')
    .replace(/\( /g, '(');
  return { head, folded };
}

describe('CI runner routing', () => {
  const LIGHT = ['changes', 'lint', 'linear-history', 'dependency-review', 'ci'];
  const HEAVY = [
    'typecheck',
    'node-matrix-tests',
    'webapp',
    'e2e',
    'node-server',
    'chrome-extension',
    'cloud-core',
    'github-workflow',
    'bench',
    'go-optel',
    'shared',
    'spoon',
    'cherry',
    'global-install',
    'bundle-size',
  ];
  const HOSTED = {
    'cloudflare-worker': 'ubuntu-latest',
    webcomponents: 'ubuntu-latest',
    'swift-server': 'macos-latest',
    'swift-optel': 'macos-latest',
    'swift-traysession': 'macos-latest',
    'swift-trayfollower': 'macos-latest',
    'swift-widgetkit': 'macos-latest',
    'swift-traykit': 'macos-latest',
    'swift-launcher': 'macos-latest',
    'ios-app': 'macos-26',
    'ios-app-tests': "${{ matrix.ios == '27' && 'xcode-27' || 'macos-latest' }}",
  };
  const jobs = jobBlocks();

  it('accounts for every job', () => {
    const known = [...LIGHT, ...HEAVY, ...Object.keys(HOSTED), 'slicc-cli', 'runner'].sort();
    expect(jobs.map((job) => job.name).sort()).toEqual(known);
  });

  it('defines each pool route once, behind the fork-safe trust check', () => {
    const anchors = jobs.map((job) => runsOn(job.body)).filter((r) => r.head.startsWith('&'));
    expect(anchors).toEqual([
      { head: '&ci-runner >-', folded: poolRoute('CI_RUNNER') },
      { head: '&ci-heavy-runner >-', folded: poolRoute('CI_HEAVY_RUNNER') },
    ]);
  });

  it('puts the short jobs on the light pool and the rest on the bench pool', () => {
    for (const job of jobs) {
      const { head } = runsOn(job.body);
      if (LIGHT.includes(job.name)) expect(head, job.name).toMatch(/^[&*]ci-runner\b/);
      if (HEAVY.includes(job.name)) expect(head, job.name).toMatch(/^[&*]ci-heavy-runner\b/);
      if (job.name in HOSTED) expect(head, job.name).toBe(HOSTED[job.name]);
    }
  });

  it('routes only the Linux slicc-cli leg, through the same trust check', () => {
    const { head, folded } = runsOn(jobs.find((job) => job.name === 'slicc-cli').body);
    expect(head).toBe('>-');
    expect(folded).toBe(
      poolRoute('CI_HEAVY_RUNNER').replace(
        '${{ ',
        "${{ matrix.os != 'ubuntu-latest' && matrix.os || "
      )
    );
  });

  it('sends a merge group with any fork PR in the queue to hosted runners', () => {
    const runner = jobs.find((job) => job.name === 'runner').body;
    // The decider checks out nothing, so any merge group may run it on a pool;
    // every other event gets the usual trust check.
    expect(runsOn(runner).folded).toBe(
      "${{ ((github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) || github.event_name == 'merge_group' || (github.ref == 'refs/heads/main' && contains(fromJSON('[\"push\",\"schedule\",\"workflow_dispatch\"]'), github.event_name))) && (vars.CI_RUNNER || vars.CI_HEAVY_RUNNER) && fromJSON(startsWith(vars.CI_RUNNER || vars.CI_HEAVY_RUNNER, '[') && (vars.CI_RUNNER || vars.CI_HEAVY_RUNNER) || toJSON(vars.CI_RUNNER || vars.CI_HEAVY_RUNNER)) || 'ubuntu-latest' }}"
    );
    expect(runner).not.toContain('actions/checkout');
    expect(runner).toContain('merge-group: ${{ steps.pick.outputs.merge-group }}');
    expect(runner).toContain('isCrossRepository !== false');
    expect(runner).toContain('entries.totalCount !== nodes.length');
    expect(runner).toContain("await pick('hosted', 'merge queue lookup failed')");
    expect(runner.match(/pick\('same-repo'/g)).toHaveLength(1);
    for (const job of jobs.filter((j) => !(j.name in HOSTED) && j.name !== 'runner')) {
      expect(job.body, job.name).toMatch(
        /\n {4}needs:\s*(runner\n|\[runner,|\n(?: {6}.*\n)*? {8}runner,)/
      );
    }
  });

  it('decides hosted for a merge group with a fork, unknown, or truncated queue', async () => {
    const runner = jobs.find((job) => job.name === 'runner').body;
    const block = runner.match(/\n {8}with:\n {10}script: \|\n((?: {12}.*\n|\n)+)/)[1];
    const script = block.replace(/^ {12}/gm, '');
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const entry = (number, isCrossRepository) => ({ pullRequest: { number, isCrossRepository } });
    async function decide(eventName, queue) {
      let decision;
      const core = {
        setOutput: (_name, value) => {
          decision = value;
        },
        warning: () => {},
        summary: { addRaw: () => ({ write: async () => {} }) },
      };
      const github = {
        graphql: async () => {
          if (queue instanceof Error) throw queue;
          return { repository: { mergeQueue: queue } };
        },
      };
      const context = {
        eventName,
        repo: { owner: 'ai-ecoverse', repo: 'slicc' },
        payload: { merge_group: { base_ref: 'refs/heads/main' } },
      };
      await new AsyncFunction('github', 'context', 'core', script)(github, context, core);
      return decision;
    }
    const queue = (nodes, totalCount = nodes.length) => ({ entries: { totalCount, nodes } });

    expect(await decide('pull_request')).toBe('n/a');
    expect(await decide('merge_group', queue([entry(1, false), entry(2, false)]))).toBe(
      'same-repo'
    );
    expect(await decide('merge_group', queue([entry(1, false), entry(7, true)]))).toBe('hosted');
    expect(await decide('merge_group', queue([entry(1, false), { pullRequest: null }]))).toBe(
      'hosted'
    );
    expect(await decide('merge_group', queue([entry(1, false)], 101))).toBe('hosted');
    expect(await decide('merge_group', null)).toBe('hosted');
    expect(await decide('merge_group', new Error('graphql down'))).toBe('hosted');
  });

  it('keeps secrets and write tokens off every pool job', () => {
    expect(workflow).toMatch(/\npermissions:\n {2}contents: read\n/);
    for (const job of jobs.filter((j) => !(j.name in HOSTED))) {
      expect(job.body, job.name).not.toMatch(/secrets\./);
      expect(job.body, job.name).not.toMatch(/:\s*write\b/);
    }
  });

  it('guards every root-only step, since the pools have no sudo', () => {
    for (const job of jobs.filter((j) => !(j.name in HOSTED))) {
      for (const line of job.body.split('\n')) {
        if (!/\bsudo |install-deps|--with-deps/.test(line) || line.trim().startsWith('#')) continue;
        expect(job.body, `${job.name}: ${line.trim()}`).toMatch(
          /if \[ "\$\(id -u\)" = 0 \]( \|\| sudo -n true 2>\/dev\/null)?; then/
        );
      }
    }
    expect(workflow).not.toContain('install --with-deps');
    // The pool images have no global TypeScript; use the workspace's `npx tsc`.
    expect(workflow).not.toMatch(/run: tsc /);
  });
});
