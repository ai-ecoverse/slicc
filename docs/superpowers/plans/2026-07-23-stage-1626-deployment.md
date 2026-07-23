# Stage PR #1626 End-to-End Deployment Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the staging Worker to `slicc-staging`, deploy the resulting PR #1626 SHA through the serialized staging workflow, and verify removal of running/paused cone limits against real E2B sandboxes.

**Architecture:** Reuse `SLICC_E2B_TEMPLATE_NAME` as an optional Worker configuration value. Production leaves it unset and continues to boot `slicc`; Wrangler staging sets `slicc-staging`, which the Durable Object forwards to `startCone`. Push the newer PR SHA to trigger the existing forward-only staging workflow, then validate provenance and lifecycle behavior during a coordinated staging lease.

**Tech Stack:** TypeScript, Cloudflare Workers and Durable Objects, Wrangler, GitHub Actions/CLI, E2B CLI/SDK, Vitest, browser-based Adobe authentication.

## Global Constraints

- Staging is shared and forward-only; never replay an older deployment as rollback.
- Production must continue to default to E2B template alias `slicc`.
- Staging must use E2B template alias `slicc-staging` for portal-created cones.
- Use E2B team `Adobe Experience Manager` (`c5b04852-7176-48d8-8d37-cd103a7c7545`).
- Do not change E2B quota, timeout, CPU, memory, or production template settings.
- Keep all cloud request-rate limits unchanged.
- Do not expose IMS, E2B, GitHub, TURN, or Cloudflare credentials in commands, logs, screenshots, artifacts, or PR comments.
- Acquire a 30–45 minute staging lease before pushing the deployment-triggering SHA.
- Abort attribution if another staging deployment supersedes the tested SHA.
- Prefix every test cone name with `stage-1626-$STAMP-` and remove every matching cone on success or failure.
- Use GitHub environment secrets and the existing `Worker Staging Deploy` workflow; do not deploy components manually.
- Recovery is fix-forward: retry the current SHA for transient failures or push a newer fix SHA for code/configuration failures.

---

## File Map

### Template selection prerequisite

- Modify `packages/cloudflare-worker/src/cloud/cloud-sessions-do.ts`: accept the optional template alias and forward a trimmed value into `startCone`.
- Modify `packages/cloudflare-worker/src/index.ts`: add the optional value to `WorkerEnv`.
- Modify `packages/cloudflare-worker/wrangler.jsonc`: set `slicc-staging` only in staging vars.
- Modify `packages/cloudflare-worker/tests/cloud-sessions-do.test.ts`: record the template passed to the fake substrate and cover production/staging/blank behavior.
- Modify `packages/cloudflare-worker/CLAUDE.md`: document the production/staging alias contract.

### Local deployment evidence

- Create `.superpowers/stage-1626/$TEST_PREFIX/e2b-template-before.json`.
- Create `.superpowers/stage-1626/$TEST_PREFIX/deployments-before.json`.
- Create `.superpowers/stage-1626/$TEST_PREFIX/pr-before.json`.
- Create `.superpowers/stage-1626/$TEST_PREFIX/run-final.json`.
- Create `.superpowers/stage-1626/$TEST_PREFIX/deployment-statuses.json`.
- Create `.superpowers/stage-1626/$TEST_PREFIX/e2b-template-after.json`.
- Create `.superpowers/stage-1626/$TEST_PREFIX/results.md`.
- Create screenshots under the same ignored directory.
- Post the final evidence summary to PR #1626.

---

### Task 1: Wire the Staging Worker to `slicc-staging`

**Files:**

- Modify: `packages/cloudflare-worker/tests/cloud-sessions-do.test.ts:1-240`
- Modify: `packages/cloudflare-worker/src/cloud/cloud-sessions-do.ts:14-25,145-175`
- Modify: `packages/cloudflare-worker/src/index.ts:49-72`
- Modify: `packages/cloudflare-worker/wrangler.jsonc:75-100`
- Modify: `packages/cloudflare-worker/CLAUDE.md:209-230`

**Interfaces:**

- Consumes: optional Worker binding `SLICC_E2B_TEMPLATE_NAME?: string`.
- Produces: `startCone(..., { template })`, where staging supplies `slicc-staging` and missing/blank configuration supplies `undefined` so cloud-core retains its `slicc` default.
- Preserves: production template selection, all request-rate limits, reservation semantics, lifecycle cleanup, and user input boundaries.

- [ ] **Step 1: Add failing tests for configured, default, and blank template selection**

In `packages/cloudflare-worker/tests/cloud-sessions-do.test.ts`, make the fake substrate record template inputs:

```ts
class FakeSubstrate implements SandboxSubstrate {
  readonly id = 'e2b' as const;
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly createdTemplates: string[] = [];
  private nextId = 1;
  connectError?: Error;

  async create(opts: CreateOpts): Promise<SandboxHandle> {
    this.createdTemplates.push(opts.template);
    const id = `sbx-${this.nextId++}`;
    this.seedSandbox(id, {
      state: 'running',
      metadata: opts.metadata ?? {},
      name: opts.name,
    });
    return this.handle(id);
  }
}
```

Keep the existing methods between the shown class fields and `create`; do not duplicate or remove them.

Replace `makeDoEnv` with:

```ts
function makeDoEnv(substrate: FakeSubstrate, templateName?: string) {
  return {
    E2B_API_KEY: 'test',
    ...(templateName === undefined ? {} : { SLICC_E2B_TEMPLATE_NAME: templateName }),
    __SUBSTRATE_FACTORY__: () => substrate as SandboxSubstrate,
  };
}
```

Add this behavior test inside the lifecycle `describe` block:

```ts
it.each([
  { label: 'production default', configured: undefined, expected: 'slicc' },
  { label: 'staging override', configured: 'slicc-staging', expected: 'slicc-staging' },
  { label: 'blank override', configured: '   ', expected: 'slicc' },
])('uses the $label template alias', async ({ configured, expected }) => {
  const substrate = new FakeSubstrate();
  const { state } = makeFakeState();
  const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate, configured));

  const response = await call(do_, '/start-cone', {
    bearer: 'b',
    userId: 'u1',
    workerOrigin: 'https://w',
    name: `template-${expected}`,
  });

  expect(response.status).toBe(200);
  expect(substrate.createdTemplates).toEqual([expected]);
});
```

- [ ] **Step 2: Run the test and confirm the staging case is red**

Run from the repository root:

```bash
npm run build -w @slicc/cloud-core
npx vitest run --project cloudflare-worker \
  packages/cloudflare-worker/tests/cloud-sessions-do.test.ts \
  -t 'uses the .* template alias'
```

Expected: the staging-override row FAILS because the fake substrate receives `slicc`; production-default and blank rows pass.

- [ ] **Step 3: Forward the optional template through the Worker start path**

In `packages/cloudflare-worker/src/cloud/cloud-sessions-do.ts`, extend `DoEnv`:

```ts
interface DoEnv {
  E2B_API_KEY: string;
  SLICC_E2B_TEMPLATE_NAME?: string;
  /** Test-only hatch: inject a substrate factory in place of e2b. */
  __SUBSTRATE_FACTORY__?: () => SandboxSubstrate;
}
```

Add the template option to the existing `startCone` call:

```ts
const result = await startCone(
  { substrate, registry },
  {
    reservationId: reservation.reservationId,
    template: this.env.SLICC_E2B_TEMPLATE_NAME?.trim() || undefined,
    envContents,
    coneConfigJson,
    envs: {
      ADOBE_IMS_TOKEN: body.bearer,
      ADOBE_IMS_TOKEN_DOMAINS: ADOBE_TOKEN_DOMAINS,
    },
    workerBaseUrl: body.workerOrigin,
    sliccVersion: 'web-' + new Date().toISOString().slice(0, 10),
    name: body.name?.trim(),
    metadata: { userId: body.userId },
  }
);
```

In `packages/cloudflare-worker/src/index.ts`, add:

```ts
SLICC_E2B_TEMPLATE_NAME?: string;
```

immediately after `E2B_API_KEY?: string;`.

- [ ] **Step 4: Configure only Wrangler staging to use `slicc-staging`**

In `packages/cloudflare-worker/wrangler.jsonc`, add this value only inside `env.staging.vars`, next to the cloud-cone environment values:

```jsonc
"SLICC_E2B_TEMPLATE_NAME": "slicc-staging",
```

Do not add it to top-level production vars. Production's missing value is the tested fallback to `slicc`.

- [ ] **Step 5: Document the runtime alias contract**

Under `### Wrangler Config (cloud)` in `packages/cloudflare-worker/CLAUDE.md`, add:

```md
- `SLICC_E2B_TEMPLATE_NAME` — optional sandbox template alias. Production leaves it unset and defaults to `slicc`; Wrangler staging sets `slicc-staging`, matching the alias built by `worker-staging.yml`.
```

- [ ] **Step 6: Run focused and package verification**

Run:

```bash
npm run build -w @slicc/cloud-core
npx vitest run --project cloudflare-worker \
  packages/cloudflare-worker/tests/cloud-sessions-do.test.ts
npm run test -w @slicc/cloudflare-worker
npm run typecheck
npx biome check packages/cloudflare-worker/src/cloud/cloud-sessions-do.ts \
  packages/cloudflare-worker/src/index.ts \
  packages/cloudflare-worker/tests/cloud-sessions-do.test.ts \
  packages/cloudflare-worker/wrangler.jsonc
npm run lint:docs
node packages/dev-tools/tools/check-touched-exemptions.mjs
git diff --check
```

Expected: all commands PASS. The Worker suite includes the new three-row alias test; the complexity gate reports zero touched files remaining on debt lists.

- [ ] **Step 7: Commit the prerequisite**

```bash
git add packages/cloudflare-worker/src/cloud/cloud-sessions-do.ts \
  packages/cloudflare-worker/src/index.ts \
  packages/cloudflare-worker/tests/cloud-sessions-do.test.ts \
  packages/cloudflare-worker/wrangler.jsonc \
  packages/cloudflare-worker/CLAUDE.md
git commit -m "fix(cloud): use staging e2b template in staging"
```

---

### Task 2: Acquire the Staging Lease and Push the New SHA

**Files/artifacts:**

- Create: `.superpowers/stage-1626/$TEST_PREFIX/e2b-template-before.json`
- Create: `.superpowers/stage-1626/$TEST_PREFIX/deployments-before.json`
- Create: `.superpowers/stage-1626/$TEST_PREFIX/pr-before.json`
- Create: `.superpowers/stage-1626/$TEST_PREFIX/results.md`
- External write: push `feat-relax-e2b-limits` and trigger GitHub staging deployment.

**Interfaces:**

- Consumes: clean, verified local branch containing Task 1 and the approved planning artifacts.
- Produces: a new PR #1626 head SHA and one serialized `Worker Staging Deploy` run for that SHA.

- [ ] **Step 1: Initialize a local evidence directory**

Run:

```bash
export PR_NUMBER=1626
export BRANCH=feat-relax-e2b-limits
export STAGE_URL=https://slicc-tray-hub-staging.minivelos.workers.dev
export STAGE_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
export TEST_PREFIX="stage-1626-$STAMP"
export EVIDENCE_DIR="$PWD/.superpowers/stage-1626/$TEST_PREFIX"
mkdir -p "$EVIDENCE_DIR/screenshots"
printf '# PR #1626 staging results\n\n- Started: %s\n- Prefix: `%s`\n' \
  "$STAGE_STARTED_AT" "$TEST_PREFIX" > "$EVIDENCE_DIR/results.md"
```

- [ ] **Step 2: Confirm the E2B team and snapshot the current shared state**

Run:

```bash
e2b auth info | tee "$EVIDENCE_DIR/e2b-auth.txt"
grep -F 'Selected team: Adobe Experience Manager' "$EVIDENCE_DIR/e2b-auth.txt"

e2b template list --format json | jq \
  '[.[] | select(.aliases | index("slicc-staging"))][0] |
   {aliases, buildID, buildStatus, templateID, updatedAt}' \
  > "$EVIDENCE_DIR/e2b-template-before.json"

gh api 'repos/ai-ecoverse/slicc/deployments?environment=staging&per_page=5' \
  > "$EVIDENCE_DIR/deployments-before.json"

gh pr view "$PR_NUMBER" --json headRefOid,url,state > "$EVIDENCE_DIR/pr-before.json"
```

Expected: E2B auth identifies the Adobe Experience Manager team; `slicc-staging` exists with `buildStatus: ready`.

- [ ] **Step 3: Refuse to deploy while another staging run is active or queued**

Run:

```bash
ACTIVE_RUNS="$(gh run list --workflow worker-staging.yml --limit 30 \
  --json databaseId,status,headBranch,url \
  --jq '[.[] | select(.status == "queued" or .status == "in_progress")]')"
printf '%s\n' "$ACTIVE_RUNS" | tee "$EVIDENCE_DIR/active-runs-before.json"
test "$(printf '%s' "$ACTIVE_RUNS" | jq 'length')" -eq 0
```

Expected: PASS with zero active or queued runs. If nonzero, stop and wait; do not push.

- [ ] **Step 4: Announce the lease and perform a final local gate**

Coordinate the 30–45 minute shared staging window, then run:

```bash
git status --short --branch
npm run typecheck
npx vitest run --project cloudflare-worker \
  packages/cloudflare-worker/tests/cloud-sessions-do.test.ts
node packages/dev-tools/tools/check-touched-exemptions.mjs
git diff --check
```

Expected: clean working tree and all checks PASS.

- [ ] **Step 5: Push the newer SHA**

This is an external write. Confirm the test window is active, then run:

```bash
export DEPLOY_SHA="$(git rev-parse HEAD)"
git push origin "$BRANCH"
test "$(gh pr view "$PR_NUMBER" --json headRefOid --jq .headRefOid)" = "$DEPLOY_SHA"
printf '%s\n' "$DEPLOY_SHA" > "$EVIDENCE_DIR/deploy-sha.txt"
```

Expected: PR #1626 head equals `DEPLOY_SHA`. The push changes cloud-worker paths and automatically creates a new staging run.

- [ ] **Step 6: Discover the run for the exact pushed SHA**

Run:

```bash
export RUN_ID=''
for attempt in $(seq 1 30); do
  RUN_ID="$(gh run list --workflow worker-staging.yml --branch "$BRANCH" --limit 10 \
    --json databaseId,headSha,createdAt \
    --jq ".[] | select(.headSha == \"$DEPLOY_SHA\") | .databaseId" | head -n 1)"
  test -n "$RUN_ID" && break
  sleep 10
done
test -n "$RUN_ID"
printf '%s\n' "$RUN_ID" > "$EVIDENCE_DIR/run-id.txt"
gh run view "$RUN_ID" --json databaseId,headSha,status,url \
  > "$EVIDENCE_DIR/run-start.json"
```

Expected: `run-start.json.headSha` equals `DEPLOY_SHA`.

---

### Task 3: Monitor Deployment and Prove Provenance

**Files/artifacts:**

- Create: `.superpowers/stage-1626/$TEST_PREFIX/run-final.json`
- Create: `.superpowers/stage-1626/$TEST_PREFIX/deployments-after.json`
- Create: `.superpowers/stage-1626/$TEST_PREFIX/deployment-statuses.json`
- Create: `.superpowers/stage-1626/$TEST_PREFIX/e2b-template-after.json`
- Update: `.superpowers/stage-1626/$TEST_PREFIX/results.md`

**Interfaces:**

- Consumes: `RUN_ID`, `DEPLOY_SHA`, `STAGE_STARTED_AT`, and the evidence directory from Task 2.
- Produces: a successful deployment URL and a new ready `slicc-staging` build attributable to the workflow window.

- [ ] **Step 1: Watch the serialized workflow to completion**

Run:

```bash
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --json databaseId,headSha,status,conclusion,url,jobs \
  > "$EVIDENCE_DIR/run-final.json"
test "$(jq -r .headSha "$EVIDENCE_DIR/run-final.json")" = "$DEPLOY_SHA"
test "$(jq -r .conclusion "$EVIDENCE_DIR/run-final.json")" = success
```

If the command fails, capture the failed job log with `gh run view "$RUN_ID" --log-failed`, clean any test resources, and follow the forward-only recovery task. Do not deploy manually.

- [ ] **Step 2: Resolve the successful GitHub deployment and URL**

Run:

```bash
gh api 'repos/ai-ecoverse/slicc/deployments?environment=staging&per_page=20' \
  > "$EVIDENCE_DIR/deployments-after.json"
export DEPLOYMENT_ID="$(jq -r --arg sha "$DEPLOY_SHA" \
  '[.[] | select(.sha == $sha)][0].id // empty' \
  "$EVIDENCE_DIR/deployments-after.json")"
test -n "$DEPLOYMENT_ID"

gh api "repos/ai-ecoverse/slicc/deployments/$DEPLOYMENT_ID/statuses" \
  > "$EVIDENCE_DIR/deployment-statuses.json"
export DEPLOYMENT_URL="$(jq -r '[.[] | select(.state == "success")][0].environment_url // empty' \
  "$EVIDENCE_DIR/deployment-statuses.json")"
test "$DEPLOYMENT_URL" = "$STAGE_URL"
```

- [ ] **Step 3: Prove the E2B staging alias was rebuilt**

Run:

```bash
e2b template list --format json | jq \
  '[.[] | select(.aliases | index("slicc-staging"))][0] |
   {aliases, buildID, buildStatus, templateID, updatedAt}' \
  > "$EVIDENCE_DIR/e2b-template-after.json"

test "$(jq -r .buildStatus "$EVIDENCE_DIR/e2b-template-after.json")" = ready
test "$(jq -r .buildID "$EVIDENCE_DIR/e2b-template-after.json")" != \
  "$(jq -r .buildID "$EVIDENCE_DIR/e2b-template-before.json")"
test "$(jq -r .updatedAt "$EVIDENCE_DIR/e2b-template-after.json")" \> "$STAGE_STARTED_AT"
```

- [ ] **Step 4: Confirm staging has not already been superseded**

Run:

```bash
LATEST_STAGE_SHA="$(gh api \
  'repos/ai-ecoverse/slicc/deployments?environment=staging&per_page=1' --jq '.[0].sha')"
test "$LATEST_STAGE_SHA" = "$DEPLOY_SHA"
```

Expected: PASS. If it fails, the lease is lost; do not begin lifecycle testing.

---

### Task 4: Run Static and Authenticated Lifecycle Validation

**Files/artifacts:**

- Update: `.superpowers/stage-1626/$TEST_PREFIX/results.md`
- Create: screenshots and sanitized diagnostic JSON in the evidence directory.
- External writes: create, pause, resume, and kill six staging E2B sandboxes.

**Interfaces:**

- Consumes: active staging URL/SHA, ready `slicc-staging` alias, Adobe browser authentication, and `TEST_PREFIX`.
- Produces: evidence that portal-created cones use `slicc-staging` and no SLICC cone-count caps remain.

- [ ] **Step 1: Run unauthenticated HTTP checks**

Run:

```bash
curl -fsS -D "$EVIDENCE_DIR/cloud-headers.txt" \
  "$STAGE_URL/cloud" -o "$EVIDENCE_DIR/cloud.html"
grep -i '^content-security-policy:' "$EVIDENCE_DIR/cloud-headers.txt"

curl -fsS "$STAGE_URL/api/cloud/config" \
  | tee "$EVIDENCE_DIR/cloud-config.json" \
  | jq -e '(has("capRunning") | not) and (has("capPaused") | not)'

STATUS="$(curl -sS -o "$EVIDENCE_DIR/unauth-list.json" -w '%{http_code}' \
  "$STAGE_URL/api/cloud/list")"
test "$STATUS" = 401
```

- [ ] **Step 2: Reconfirm provenance immediately before browser testing**

Run:

```bash
test "$(gh api 'repos/ai-ecoverse/slicc/deployments?environment=staging&per_page=1' \
  --jq '.[0].sha')" = "$DEPLOY_SHA"
```

- [ ] **Step 3: Open the dashboard and complete Adobe sign-in**

Open:

```text
https://slicc-tray-hub-staging.minivelos.workers.dev/cloud
```

Use the browser's Adobe sign-in flow. Do not extract or copy the bearer token. After sign-in:

- Select the default Adobe account/model.
- Confirm the summary contains only `N running · M paused`.
- Confirm no `(cap: ...)` text is present.
- Save a screenshot as `$EVIDENCE_DIR/screenshots/01-signed-in-counts.png`.

This is a human-authentication checkpoint. Pause execution until sign-in succeeds.

- [ ] **Step 4: Validate two near-concurrent starts**

Open a second dashboard tab in the same browser session. Configure names:

```text
${TEST_PREFIX}-a
${TEST_PREFIX}-b
```

Select the same valid model in each tab, then click Create in both tabs within a few seconds. Require:

- both rows reach `running`
- both have usable Open links
- summary reports at least `2 running`
- reload preserves both states

Save `$EVIDENCE_DIR/screenshots/02-two-running.png` and record observed start latencies in `results.md`.

- [ ] **Step 5: Prove both portal cones use `slicc-staging`**

Run:

```bash
for state in running paused; do
  e2b sandbox list --state "$state" --format json
done | jq -s --arg prefix "$TEST_PREFIX" \
  '[.[][] | select((.metadata.name // "") | startswith($prefix))] |
   map({sandboxId, templateName: .name, coneName: .metadata.name, state, startedAt})' \
  > "$EVIDENCE_DIR/test-cones.json"

jq -e 'length == 2 and all(.templateName == "slicc-staging")' \
  "$EVIDENCE_DIR/test-cones.json"
```

If either template name is not `slicc-staging`, stop: the integration wiring is not live or staging was superseded.

- [ ] **Step 6: Reach the former five-paused boundary**

Through the dashboard:

1. Pause `${TEST_PREFIX}-a` and `${TEST_PREFIX}-b`.
2. Create `${TEST_PREFIX}-c`, wait for running, then pause it.
3. Repeat for `-d` and `-e`.
4. Require the summary to show `0 running · 5 paused`.
5. Save `$EVIDENCE_DIR/screenshots/03-five-paused.png`.
6. Create `${TEST_PREFIX}-f` and require it to reach `running`.

Record each start/pause latency and save `$EVIDENCE_DIR/screenshots/04-start-with-five-paused.png`.

- [ ] **Step 7: Resume above the former running limit**

With `-f` running, resume `-a` and `-b` within a few seconds. Require:

- `-a`, `-b`, and `-f` all reach `running`
- no cap error or count-based disabled control appears
- reload preserves reconciled states

Save `$EVIDENCE_DIR/screenshots/05-three-running-after-resume.png` and record resume latencies.

- [ ] **Step 8: Verify duplicate-name protection remains**

Attempt to create another cone named `${TEST_PREFIX}-a`. Require a visible failure corresponding to `NAME_TAKEN`; no additional E2B sandbox should appear with that metadata name.

Record the result without capturing credentials.

- [ ] **Step 9: Capture sanitized final state and diagnostics**

Run:

```bash
for state in running paused; do
  e2b sandbox list --state "$state" --format json
done | jq -s --arg prefix "$TEST_PREFIX" \
  '[.[][] | select((.metadata.name // "") | startswith($prefix))] |
   map({sandboxId, templateName: .name, coneName: .metadata.name, state, startedAt, endAt})' \
  > "$EVIDENCE_DIR/test-cones-final.json"

jq -e 'length == 6 and all(.templateName == "slicc-staging")' \
  "$EVIDENCE_DIR/test-cones-final.json"
```

For any failed cone, run `e2b sandbox info`, `e2b sandbox logs`, and `e2b sandbox metrics` for its recorded ID and save sanitized output under the evidence directory.

---

### Task 5: Clean Up and Publish Evidence

**Files/artifacts:**

- Update: `.superpowers/stage-1626/$TEST_PREFIX/results.md`
- External writes: kill test cones and post a PR comment.

**Interfaces:**

- Consumes: `TEST_PREFIX`, recorded sandbox IDs, deployment provenance, screenshots, and test outcomes.
- Produces: zero remaining test resources and a sanitized PR #1626 validation record.

- [ ] **Step 1: Kill every test cone through the dashboard**

Use the Kill action for all six `${TEST_PREFIX}-*` rows. Refresh until no matching row remains.

- [ ] **Step 2: Verify cleanup in E2B and use CLI fallback only for owned test IDs**

Run:

```bash
for state in running paused; do
  e2b sandbox list --state "$state" --format json
done | jq -rs --arg prefix "$TEST_PREFIX" \
  '[.[][] | select((.metadata.name // "") | startswith($prefix)) | .sandboxId] | unique[]' \
  > "$EVIDENCE_DIR/remaining-sandbox-ids.txt"

while IFS= read -r sandbox_id; do
  test -z "$sandbox_id" || e2b sandbox kill "$sandbox_id"
done < "$EVIDENCE_DIR/remaining-sandbox-ids.txt"

for state in running paused; do
  e2b sandbox list --state "$state" --format json
done | jq -se --arg prefix "$TEST_PREFIX" \
  '[.[][] | select((.metadata.name // "") | startswith($prefix))] | length == 0'
```

Never use `e2b sandbox kill --all`; other users share the team.

- [ ] **Step 3: Recheck deployment provenance**

Run:

```bash
FINAL_STAGE_SHA="$(gh api \
  'repos/ai-ecoverse/slicc/deployments?environment=staging&per_page=1' --jq '.[0].sha')"
printf '\n- Final active staging SHA: `%s`\n' "$FINAL_STAGE_SHA" \
  >> "$EVIDENCE_DIR/results.md"
```

If `FINAL_STAGE_SHA` differs from `DEPLOY_SHA`, mark the test window superseded. Preserve observations but do not claim #1626 passed end-to-end.

- [ ] **Step 4: Complete the sanitized result matrix**

Append to `results.md`:

```md
## Provenance

- PR SHA:
- Workflow run:
- Deployment URL:
- E2B staging build ID:
- E2B staging template ID:

## Results

- Worker/R2 deployed smoke:
- Cloud config has no cap fields:
- Two near-concurrent starts:
- Portal-created template alias is slicc-staging:
- Start with five paused cones:
- Resume above former running limit:
- Duplicate-name protection:
- Cleanup confirmed:
- Staging remained on tested SHA:

## Timings

| Operation | Cone | Duration | Result |
| --------- | ---- | -------: | ------ |
```

Fill every field from captured artifacts. Do not include tokens, emails, user IDs, secret values, or full environment dumps.

- [ ] **Step 5: Post the result to PR #1626**

Review `results.md` for secrets and personally identifying information, then run:

```bash
gh pr comment 1626 --body-file "$EVIDENCE_DIR/results.md"
```

Expected: the comment links the workflow/deployment, states the tested SHA/build, reports each acceptance criterion, and confirms all test cones were removed.

---

### Task 6: Apply Forward-Only Failure Handling When Needed

**Files/artifacts:**

- Update: the evidence directory and PR comment with the failed or superseded outcome.
- External writes only when authorized: rerun current workflow or push a newer fix SHA.

**Interfaces:**

- Consumes: failure classification and captured provenance.
- Produces: a clean staging test footprint and one of four explicit outcomes: passed, retryable, code issue, or superseded.

- [ ] **Step 1: Classify the outcome**

Use exactly one classification:

- `passed`: all success criteria met on the tested SHA
- `failed-retryable`: transient workflow/platform failure on current SHA
- `failed-code`: deterministic code/configuration failure requiring a newer SHA
- `superseded`: another deployment replaced the tested SHA

- [ ] **Step 2: Clean test resources before recovery**

Run Task 5 cleanup regardless of classification. Do not leave running or paused `${TEST_PREFIX}-*` cones.

- [ ] **Step 3: Fix forward**

For `failed-retryable`, rerun only the current run ID:

```bash
gh run rerun "$RUN_ID"
gh run watch "$RUN_ID" --exit-status
```

For `failed-code`, implement and verify a fix, push the newer SHA, and acquire a new lease around its automatically triggered staging run.

For `superseded`, do not redeploy immediately. Record the superseding SHA, release the lease, and schedule a new window.

Never rerun `29973254053` or another older run as rollback, and never manually deploy only the template or Worker.
