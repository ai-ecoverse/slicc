/**
 * Specs reserved for the merge-queue / non-PR E2E job.
 *
 * Pull requests run every other `*.test.ts` under this directory. The long
 * tail here is what made the pre-split suite a ~16-minute critical path; PRs
 * fill the spare capacity under `webapp` / `node-matrix` (~6 minutes of
 * Playwright after setup) without owning the required `ci` signal.
 *
 * Add a basename here when a new spec is too slow or too flaky for PR, not
 * when it is merely new — new medium specs should land on PRs by default.
 *
 * Keep in sync with the `SLICC_E2E_PR` `testIgnore` wiring in
 * `playwright.config.ts` and the assertions in
 * `packages/dev-tools/tools/ci-critical-path.test.mjs`.
 */
export const MQ_ONLY_SPEC_BASENAMES = Object.freeze([
  // Leader/follower cone lifecycle — ~3.4 minutes combined in CI.
  'multiple-cones.test.ts',
  'multiple-cones-follower.test.ts',
  'multiple-cones-licks.test.ts',
  // Compaction failure + reload matrix — ~2.1 minutes.
  'compaction-robustness.test.ts',
  // Host-reset webhook / preview URL — ~1+ minute and retry-prone.
  'roving-tray-webhook.test.ts',
  // Four disclosure variants — ~2.2 minutes.
  'sprinkle-details.test.ts',
  // Real Kokoro weights; already gated by RUN_REAL_SPEECH_E2E, but skip the
  // file load on PRs so the speech filter never pulls it onto the PR budget.
  'speech-roundtrip.test.ts',
]);
