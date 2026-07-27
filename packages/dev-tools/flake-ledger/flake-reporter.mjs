/*
 * Vitest reporter that records retried-but-passed tests exactly.
 *
 * vitest's built-in `json` reporter has no retry field; the ledger can only
 * infer a retry from residual `failureMessages` on a passed test (see
 * `lib.mjs`). The reporter API does expose the real number:
 * `TestCase.diagnostic()` returns `{ retryCount, flaky }`. This reporter writes
 * that into `test-timing/flakes.json`, which CI already uploads as part of the
 * `test-timing-*` artifacts.
 *
 * Optional — the ledger works without it. Wire it up by adding it to
 * `reporters` in `vitest.config.ts`:
 *
 *   reporters: isCI
 *     ? ['default', 'json', './packages/dev-tools/flake-ledger/flake-reporter.mjs']
 *     : ['default'],
 *
 * Env:
 *   FLAKE_LEDGER_OUTPUT  output path (default test-timing/flakes.json)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { LEDGER_KIND, toRepoRelativePath } from './lib.mjs';

const DEFAULT_OUTPUT = 'test-timing/flakes.json';

export default class FlakeReporter {
  onInit(ctx) {
    this.ctx = ctx;
  }

  onTestRunEnd(testModules) {
    const flakes = [];
    for (const module of testModules ?? []) {
      for (const test of module.children?.allTests?.() ?? []) {
        const diagnostic = test.diagnostic?.();
        if (!diagnostic?.flaky) continue;
        // vitest retries an `it.fails` test (its body throws by design) and
        // then flips the final state to pass, so `diagnostic.flaky` is true for
        // every expected failure. Those are not flakes.
        if (test.options?.fails) continue;
        const errors = test.result?.().errors ?? [];
        flakes.push({
          project: module.project?.name ?? 'unknown',
          file: toRepoRelativePath(module.moduleId),
          testName: test.fullName,
          line: test.task?.location?.line,
          retryCount: diagnostic.retryCount,
          failureMessage: errors[0]?.message ?? errors[0]?.stack ?? '',
        });
      }
    }

    const payload = {
      kind: LEDGER_KIND,
      version: 1,
      generatedAt: new Date().toISOString(),
      flakes,
    };
    const root = this.ctx?.config?.root ?? process.cwd();
    const output = resolve(root, process.env.FLAKE_LEDGER_OUTPUT || DEFAULT_OUTPUT);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    if (flakes.length > 0) {
      console.log(`\n⚠️  ${flakes.length} test(s) passed only on retry — flake ledger: ${output}`);
    }
  }
}
