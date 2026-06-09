# SP2 — Background Workflow Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `workflow run` non-blocking by default — launch the SP1 executor in the background, report live progress, and deliver the final result asynchronously to the cone as a new turn (path + preview) — while `--wait` preserves SP1's blocking behavior.

**Architecture:** A new `WorkflowRunManager` lives in the durable realm (kernel worker / offscreen), published on `globalThis.__slicc_workflows` (mirroring `AgentBridge`'s `__slicc_agent`) and constructed in `kernel/host.ts`. It `start`s the SP1-built code via `executeJsCode` **without awaiting**, captures the realm pid via `ProcessManager.on('spawn')`, wraps the run's `ctx.exec` to tap `agent`/`__wf_progress` calls for live progress, and on completion writes `/shared/workflow-runs/<id>.json` + (for cone-origin runs) fires a new `'workflow'` lick. SP1's executor/realm/prelude logic is reused wholesale. Two existing SP1 files are edited: the prelude gets an **additive** fire-and-forget progress emit (Task 3, no behavior change), and the `workflow` command (`workflow-command.ts`, Task 7) is **refactored** so `run` is non-blocking by default — `--wait` preserves SP1's blocking full-result path, and `status`/`list`/`stop` are added.

**Tech Stack:** TypeScript, Vitest (`environment: node`, `fake-indexeddb/auto` for VFS), the existing `kernel/realm` runner (`executeJsCode`/`runInRealm`), `ProcessManager`, `Orchestrator`, `LickManager`, just-bash `defineCommand`.

---

## Reading / context for the implementer

You have **zero assumed context**. Read these before starting:

- **The spec:** `docs/superpowers/specs/2026-06-08-workflow-background-runs-design.md` (the authority; this plan implements it).
- **SP1 (already on `main`):** `packages/webapp/src/shell/supplemental-commands/workflow-{script,prelude,command}.ts` — the executor, the injected prelude (`agent`/`parallel`/`pipeline`/`phase`/`log`), and the current `workflow run` command. `buildWorkflowCode`, `splitSentinel`, `parseMetaBanner`, `makeSentinel` live in `workflow-script.ts`.
- **Mirror target:** `packages/webapp/src/scoops/agent-bridge.ts` — `createAgentBridge(...)` + `publishAgentBridge(...)` + `AGENT_BRIDGE_GLOBAL_KEY = '__slicc_agent'` (lines ~399–500). You will write the analogous `createWorkflowRunManager`/`publishWorkflowRunManager` + `WORKFLOW_MANAGER_GLOBAL_KEY = '__slicc_workflows'`.
- **Host wiring:** `packages/webapp/src/kernel/host.ts` — `createKernelHost` (line ~296); `publishAgentBridge(...)` is called at ~330 once `sharedFs = orchestrator.getSharedFS()` is available; `processManager` (line ~313), `lickManager` (~445), and the lick→cone router `defaultLickEventHandler` (line ~216).
- **Realm exec lowering:** `packages/webapp/src/kernel/realm/realm-host.ts` `dispatchExec` (lines ~295–318) — `exec.spawn(argv)` in the realm becomes `ctx.exec(cmd, { cwd, args: rest })`. **The tap wraps `ctx.exec`, not `ctx.exec.spawn`.**
- **Process manager:** `packages/webapp/src/kernel/process-manager.ts` — `spawn` fires `'spawn'`; subscribe via `on('spawn', (proc) => …): () => void`. `list()`, `get(pid)`, `signal(pid, sig)`, `exit(pid, code)`.
- **Test harnesses to copy:** `packages/webapp/tests/scoops/agent-bridge.test.ts` (`makeMockOrchestrator`, `makeMockSharedFs`) and `packages/webapp/tests/shell/supplemental-commands/workflow-command.test.ts` (`ctxWith`).

**Conventions (CLAUDE.md):** `createLogger('namespace')` for logging; tests mirror `src/` under `packages/*/tests/`; run a single test file with `npm test -w @slicc/webapp -- --run <relative/path.test.ts>`; **`npm run lint` before every commit** (CI rejects unformatted code); use pi-ai model aliases not snapshots; features must work in **both** standalone and extension (this feature is float-agnostic — it runs in the durable realm and the panel terminal is already offscreen-backed, so no proxy is needed). Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**Boy-scout complexity gate — `host.ts` is on the debt list and SP2 MUST touch it (concrete, not conditional).** The `check-touched-exemptions` CI step fails if a PR modifies any file on biome.json's `overrides` debt lists without (a) bringing **every** function in that file under the caps (cognitive ≤ 25, lines ≤ 150, `skipIifes`) AND (b) removing that file's debt-list entry in the same PR. Verified against `biome.json` for this feature:

- **`packages/webapp/src/kernel/host.ts` IS on the list** (`biome.json:267`). SP2 edits it in **Task 1** (`defaultLickEventHandler` workflow name/id branch) and **Task 6** (publish the run manager). Any edit triggers the gate, so this PR must fully de-debt `host.ts` and delete its `biome.json:267` entry. **Treat this as required work, not a final check** — see Task 10 Step 3 for the concrete actions. To keep the de-debt small, push the workflow additions into helpers in their own files (a `formatWorkflowLick`-style branch already lives in `lick-formatting.ts`; keep the host touch to the minimal name/id routing + one `publishWorkflowRunManager(...)` call) and extract any host.ts function that exceeds the caps into named helpers within host.ts.
- **NOT on the list (verified — no de-debt needed):** `lick-manager.ts`, `lick-formatting.ts`, `workflow-command.ts`, `workflow-prelude.ts`, and all new files (`workflow-run-manager.ts`, `__wf_progress` command). (A codex pass claimed `lick-formatting.ts` is listed — it is NOT: `grep -n lick-formatting biome.json` is empty. The list contains the similarly-named `lick-ws-bridge.ts` at `biome.json:271`, which SP2 does **not** touch. Don't conflate the two.)
- Re-verify after edits: `node packages/dev-tools/tools/check-touched-exemptions.mjs origin/main` must print OK.

---

## File structure (decomposition)

| File                                                                                                                        | New/Modify | Responsibility                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/webapp/src/scoops/workflow-run-manager.ts`                                                                        | **New**    | `WorkflowRunManager` interface + `WorkflowRunState`, `createWorkflowRunManager(deps)`, `publishWorkflowRunManager(...)`, `WORKFLOW_MANAGER_GLOBAL_KEY`. Lifecycle, run registry, exec-tap, pid capture, completion → file + lick. |
| `packages/webapp/src/scoops/lick-manager.ts`                                                                                | Modify     | Add `'workflow'` to `LickEvent['type']`; add `workflowRunId?`, `workflowName?`, `resultPath?`, `preview?` fields.                                                                                                                 |
| `packages/webapp/src/scoops/lick-formatting.ts`                                                                             | Modify     | Add `'workflow'` to `EXTERNAL_LICK_CHANNELS`; add a `'workflow'` case to `formatLickEventForCone`.                                                                                                                                |
| `packages/webapp/src/kernel/host.ts`                                                                                        | Modify     | `defaultLickEventHandler`: add `isWorkflow` branch to `eventName`/`eventId`. Construct + `publishWorkflowRunManager` next to `publishAgentBridge`.                                                                                |
| `packages/webapp/src/shell/supplemental-commands/wf-progress-command.ts`                                                    | **New**    | `createWfProgressCommand()` — a no-op `__wf_progress` command (exit 0) so the prelude's progress emit is safe in untapped contexts.                                                                                               |
| `packages/webapp/src/shell/supplemental-commands/workflow-prelude.ts`                                                       | Modify     | `phase`/`log` additionally fire-and-forget `__execSpawn(['__wf_progress', kind, text])`.                                                                                                                                          |
| `packages/webapp/src/shell/supplemental-commands/workflow-command.ts`                                                       | Modify     | Delegate to `__slicc_workflows` (non-blocking default + `--wait`); add `status`/`list`/`stop` subcommands; classify origin via `getParentJid`.                                                                                    |
| `packages/webapp/src/shell/supplemental-commands/index.ts`                                                                  | Modify     | Register `createWfProgressCommand()`; thread `getParentJid` into `createWorkflowCommand`.                                                                                                                                         |
| `docs/shell-reference.md`, `docs/architecture.md`, root + `packages/webapp/CLAUDE.md`, `packages/vfs-root/shared/CLAUDE.md` | Modify     | Document non-blocking default, `status`/`list`/`stop`, the run manager + `workflow` lick.                                                                                                                                         |

Build order: lick registration → progress command → prelude emit → run manager (state/start → exec-tap → pid → completion) → publish/host → command refactor → docs → verify. Each task is independently committable.

---

## Task 1: Register the `workflow` lick type + formatting

**Files:**

- Modify: `packages/webapp/src/scoops/lick-manager.ts` (the `LickEvent` interface, ~lines 36–77)
- Modify: `packages/webapp/src/scoops/lick-formatting.ts` (`EXTERNAL_LICK_CHANNELS` ~29–38; `formatLickEventForCone` ~51–143)
- Modify: `packages/webapp/src/kernel/host.ts` (`defaultLickEventHandler` eventName/eventId, ~216–258)
- Test: `packages/webapp/tests/scoops/lick-formatting.test.ts` (existing — add cases)

Why: SP2 delivers cone-origin completions as a new turn via the existing lick→cone path. `'workflow'` is not a lick channel today; force-routing it falls back to the cron formatter and `workflow:undefined` naming. Register it explicitly with its own name/id fields.

- [ ] **Step 1: Add the type + fields to `LickEvent`.** In `lick-manager.ts`, extend the `type` union and add the workflow fields:

```ts
export interface LickEvent {
  type:
    | 'webhook'
    | 'cron'
    | 'sprinkle'
    | 'fswatch'
    | 'session-reload'
    | 'navigate'
    | 'upgrade'
    | 'cherry'
    | 'workflow';
  // … existing fields …
  // Workflow completion (SP2): set by WorkflowRunManager on cone-origin runs.
  workflowRunId?: string;
  workflowName?: string;
  resultPath?: string;
  preview?: string;
}
```

- [ ] **Step 2: Write the failing formatter test.** Append to `packages/webapp/tests/scoops/lick-formatting.test.ts`. **Note:** `lick-formatting.test.ts:2` already imports `formatLickEventForCone` — do NOT add a second import. Instead, widen the existing import to also pull in `EXTERNAL_LICK_CHANNELS` (the import block below shows the desired final shape), then append only the `it(...)` block:

```ts
// EXISTING import at top of file — widen it, do not duplicate:
import {
  EXTERNAL_LICK_CHANNELS,
  formatLickEventForCone,
} from '../../src/scoops/lick-formatting.js';

it("formats a 'workflow' completion lick", () => {
  expect(EXTERNAL_LICK_CHANNELS.has('workflow')).toBe(true);
  const formatted = formatLickEventForCone({
    type: 'workflow',
    workflowRunId: 'abc123',
    workflowName: 'repo-audit',
    resultPath: '/shared/workflow-runs/abc123.json',
    preview: '{"confirmed":3}',
    timestamp: '2026-06-08T00:00:00.000Z',
    body: { runId: 'abc123' },
  });
  expect(formatted).not.toBeNull();
  expect(formatted!.content).toContain('repo-audit');
  expect(formatted!.content).toContain('/shared/workflow-runs/abc123.json');
  expect(formatted!.content).toContain('{"confirmed":3}');
});
```

- [ ] **Step 3: Run it to confirm it fails.**

Run: `npm test -w @slicc/webapp -- --run tests/scoops/lick-formatting.test.ts`
Expected: FAIL — `EXTERNAL_LICK_CHANNELS.has('workflow')` is `false` and the formatter renders the generic fallback (no name/path).

- [ ] **Step 4: Add `'workflow'` to `EXTERNAL_LICK_CHANNELS`** in `lick-formatting.ts`:

```ts
export const EXTERNAL_LICK_CHANNELS: ReadonlySet<LickEvent['type']> = new Set<LickEvent['type']>([
  'webhook',
  'cron',
  'sprinkle',
  'fswatch',
  'session-reload',
  'navigate',
  'upgrade',
  'cherry',
  'workflow',
]);
```

- [ ] **Step 5: Add the `'workflow'` case to `formatLickEventForCone`.** Place it alongside the other `is*` branches (before the generic fallback), mirroring the `isCherry` block:

```ts
const isWorkflow = event.type === 'workflow';
// … after computing `label` …
if (isWorkflow) {
  const name = event.workflowName ?? 'workflow';
  const path = event.resultPath ?? '(no result file)';
  const preview = event.preview ?? '';
  const status = (event.body as { status?: string } | undefined)?.status ?? 'complete';
  return {
    label,
    content:
      `[${label}: ${name}] ${status} — ${preview}\n` +
      `Full result: ${path} (read it only if you need the whole thing).`,
  };
}
```

(`label` for an unknown channel is derived in this file; if it produces an empty/odd label for `'workflow'`, add `workflow: 'Workflow'` to whatever channel→label map this function uses — grep `label` in `lick-formatting.ts` and follow the existing pattern.)

- [ ] **Step 6: Add the `isWorkflow` branch to `defaultLickEventHandler`** in `host.ts` (so the lick carries its own name/id instead of falling to `cronName`/`cronId`). In the `eventName` chain add `isWorkflow ? event.workflowName : …`; in `eventId` add `isWorkflow ? event.workflowRunId : …`:

```ts
const isWorkflow = event.type === 'workflow';
const eventName = isWebhook
  ? event.webhookName
  : isSprinkle
    ? event.sprinkleName
    : isFsWatch
      ? event.fswatchName
      : isNavigate
        ? event.navigateUrl
        : isUpgrade
          ? `${event.upgradeFromVersion ?? 'unknown'}→${event.upgradeToVersion ?? 'unknown'}`
          : isSessionReload
            ? 'mount-recovery'
            : isWorkflow
              ? (event.workflowName ?? event.workflowRunId ?? 'workflow')
              : event.cronName;
const eventId = isWebhook
  ? event.webhookId
  : isSprinkle
    ? event.sprinkleName
    : isFsWatch
      ? event.fswatchId
      : isNavigate
        ? event.navigateUrl
        : isUpgrade
          ? `upgrade-${event.upgradeToVersion ?? 'unknown'}`
          : isSessionReload
            ? `session-reload-${event.timestamp}`
            : isWorkflow
              ? `workflow-${event.workflowRunId ?? 'unknown'}`
              : event.cronId;
```

- [ ] **Step 7: Run the test to confirm it passes.**

Run: `npm test -w @slicc/webapp -- --run tests/scoops/lick-formatting.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck + lint, then commit.**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "lick-manager|lick-formatting|host" || echo clean` (expect `clean`), then `npm run lint`.

```bash
git add packages/webapp/src/scoops/lick-manager.ts packages/webapp/src/scoops/lick-formatting.ts packages/webapp/src/kernel/host.ts packages/webapp/tests/scoops/lick-formatting.test.ts
git commit -m "feat(workflow): register 'workflow' lick type + cone-facing formatting"
```

---

## Task 2: The `__wf_progress` no-op command

**Files:**

- Create: `packages/webapp/src/shell/supplemental-commands/wf-progress-command.ts`
- Modify: `packages/webapp/src/shell/supplemental-commands/index.ts`
- Test: `packages/webapp/tests/shell/supplemental-commands/wf-progress-command.test.ts`

Why: the prelude (Task 3) emits `exec.spawn(['__wf_progress', kind, text])` on every `phase`/`log`. In a tapped run the `WorkflowRunManager` intercepts it; in **untapped** contexts (`--wait`, plain terminal, SP1 tests) the command must exist and exit 0 so the emit is harmless.

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, expect, it } from 'vitest';
import { createWfProgressCommand } from '../../../src/shell/supplemental-commands/wf-progress-command.js';

describe('__wf_progress', () => {
  it('is a no-op that exits 0', async () => {
    const cmd = createWfProgressCommand();
    expect(cmd.name).toBe('__wf_progress');
    const res = await cmd.execute(['phase', 'Scan'], {
      cwd: '/',
      env: new Map(),
      stdin: '',
    } as any);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npm test -w @slicc/webapp -- --run tests/shell/supplemental-commands/wf-progress-command.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the command.** Create `wf-progress-command.ts`:

```ts
// packages/webapp/src/shell/supplemental-commands/wf-progress-command.ts
import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

/**
 * No-op `__wf_progress` command. The workflow prelude fires
 * `exec.spawn(['__wf_progress', kind, text])` on every phase()/log(); the
 * WorkflowRunManager taps that at the ctx.exec boundary in a backgrounded run.
 * In untapped contexts (--wait, plain terminal) this no-op keeps the emit safe.
 */
export function createWfProgressCommand(): Command {
  return defineCommand('__wf_progress', async () => ({ stdout: '', stderr: '', exitCode: 0 }));
}
```

- [ ] **Step 4: Register it** in `index.ts` — add the import and push it into the `commands` array near `createWorkflowCommand()`:

```ts
import { createWfProgressCommand } from './wf-progress-command.js';
// … inside createSupplementalCommands, in the array:
    createWfProgressCommand(),
```

- [ ] **Step 5: Run the test to confirm it passes.**

Run: `npm test -w @slicc/webapp -- --run tests/shell/supplemental-commands/wf-progress-command.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint + commit.**

```bash
npm run lint
git add packages/webapp/src/shell/supplemental-commands/wf-progress-command.ts packages/webapp/src/shell/supplemental-commands/index.ts packages/webapp/tests/shell/supplemental-commands/wf-progress-command.test.ts
git commit -m "feat(workflow): add no-op __wf_progress command for the progress emit"
```

---

## Task 3: Prelude progress emit (additive, fire-and-forget)

**Files:**

- Modify: `packages/webapp/src/shell/supplemental-commands/workflow-prelude.ts` (the `phase`/`log` definitions, ~lines 79–81)
- Test: `packages/webapp/tests/shell/supplemental-commands/workflow-prelude.test.ts` (extend)

Why: the manager taps progress at the `ctx.exec` boundary. The prelude keeps its existing `console.log('WFPHASE…'/'WFLOG…')` markers (for `--wait`/terminal stdout) **and** additionally fires `__execSpawn(['__wf_progress', kind, text])` so progress is observable live. `__execSpawn` is the already-captured `exec.spawn`. Fire-and-forget — do **not** `await` (a `phase`/`log` must never block on progress).

- [ ] **Step 1: Write the failing test.** In `workflow-prelude.test.ts`, add a test that `phase`/`log` both log the marker AND spawn `__wf_progress`. The harness's `exec` records argv via `spawn`; reuse it:

```ts
it('phase/log emit the console marker AND fire __wf_progress', async () => {
  const calls: string[][] = [];
  const out: string[] = [];
  await run(
    'phase("Scan"); log("hi");',
    {
      spawn: async (a: string[]) => {
        calls.push(a);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
    WF,
    out
  );
  // console.log markers still present (SP1 behavior):
  expect(out.some((l) => l === 'WFPHASEScan')).toBe(true);
  expect(out.some((l) => l === 'WFLOGhi')).toBe(true);
  // and the parallel progress emit:
  expect(calls).toContainEqual(['__wf_progress', 'phase', 'Scan']);
  expect(calls).toContainEqual(['__wf_progress', 'log', 'hi']);
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npm test -w @slicc/webapp -- --run tests/shell/supplemental-commands/workflow-prelude.test.ts`
Expected: FAIL — no `__wf_progress` spawn recorded.

- [ ] **Step 3: Edit the prelude.** Replace the `phase`/`log` definitions so they also fire the progress emit (fire-and-forget; guard `__execSpawn` since untapped/no-exec contexts null it):

```js
function __wfProgress(kind, text) {
  if (__execSpawn) {
    try {
      __execSpawn(['__wf_progress', kind, String(text)]);
    } catch (e) {}
  }
}
let __phase = null;
function phase(title) {
  __phase = String(title);
  console.log('WFPHASE' + __phase);
  __wfProgress('phase', __phase);
}
function log(message) {
  const m = String(message);
  console.log('WFLOG' + m);
  __wfProgress('log', m);
}
```

Note: `__execSpawn(...)` returns a promise; we deliberately do not `await` it (fire-and-forget). The surrounding `try/catch` swallows a synchronous throw only; a rejected promise is harmless (no `await`, no unhandled-rejection in the realm since the manager's tap resolves it, and the no-op command resolves it in untapped contexts).

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `npm test -w @slicc/webapp -- --run tests/shell/supplemental-commands/workflow-prelude.test.ts`
Expected: PASS (the new test + all existing prelude tests).

- [ ] **Step 5: Lint + commit.**

```bash
npm run lint
git add packages/webapp/src/shell/supplemental-commands/workflow-prelude.ts packages/webapp/tests/shell/supplemental-commands/workflow-prelude.test.ts
git commit -m "feat(workflow): prelude emits __wf_progress on phase/log (fire-and-forget)"
```

---

## Task 4: `WorkflowRunManager` — state model + non-blocking `start` + accessors

**Files:**

- Create: `packages/webapp/src/scoops/workflow-run-manager.ts`
- Test: `packages/webapp/tests/scoops/workflow-run-manager.test.ts`

This task builds the core lifecycle with a **stubbed launch** (an injectable runner) so it's unit-testable without the realm. Tasks 5–6 add the exec-tap, pid capture, and completion. Use dependency injection so tests don't need a real orchestrator/realm.

- [ ] **Step 1: Write the failing test** (state + non-blocking start + observeRun). Mirror `agent-bridge.test.ts`'s mock style:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createWorkflowRunManager } from '../../src/scoops/workflow-run-manager.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function makeDeps(overrides: Partial<Parameters<typeof createWorkflowRunManager>[0]> = {}) {
  return {
    sharedFs: { mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) } as any,
    getConeJid: () => 'cone_1',
    fireLick: vi.fn(),
    processManager: { on: vi.fn(() => () => {}) } as any,
    // runRealm is the injectable launch (real impl calls executeJsCode); tests stub it.
    runRealm: vi.fn(async () => ({
      stdout: 'WF_RESULT_x' + JSON.stringify({ ok: true }),
      stderr: '',
      exitCode: 0,
    })),
    makeRunId: () => 'run1',
    splitResult: (stdout: string) => ({ result: { ok: true }, log: '', hadResult: true }),
    ...overrides,
  };
}

// NOTE: `sentinel` is a required field on WorkflowStartOptions — every `mgr.start({...})`
// call below passes `sentinel: 'WF_RESULT_x'` (shown on the first call; add it to each).

describe('WorkflowRunManager', () => {
  it('start() returns a runId without awaiting completion; status running → done; observeRun fires', async () => {
    const realmDone = deferred<{ stdout: string; stderr: string; exitCode: number }>();
    const deps = makeDeps({ runRealm: vi.fn(() => realmDone.promise) });
    const mgr = createWorkflowRunManager(deps as any);
    const states: string[] = [];

    const { runId } = await mgr.start({
      code: 'CODE',
      source: 'SRC',
      name: 'demo',
      filename: 'wf.js',
      parentJid: undefined,
      sentinel: 'WF_RESULT_x',
      ctx: { cwd: '/', env: new Map(), stdin: '', exec: vi.fn() } as any,
    });
    expect(runId).toBe('run1');
    mgr.observeRun(runId, (s) => states.push(s.status));
    expect(mgr.getRun(runId)!.status).toBe('running'); // launched, not awaited

    realmDone.resolve({
      stdout: 'WF_RESULT_x' + JSON.stringify({ ok: true }),
      stderr: '',
      exitCode: 0,
    });
    await vi.waitFor(() => expect(mgr.getRun(runId)!.status).toBe('done'));
    expect(states).toContain('done');
    expect(mgr.listRuns().map((r) => r.id)).toContain('run1');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npm test -w @slicc/webapp -- --run tests/scoops/workflow-run-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the manager with full completion.** Create `workflow-run-manager.ts` with the state type, deps, registry, a non-blocking `start` that calls the injected `runRealm`, and the **complete** completion path — `finish` writes `/shared/workflow-runs/<id>.json` via `deps.sharedFs` and `deliver` fires the lick via `deps.fireLick` for cone-origin runs. (Tasks 5–6 only _add_ the exec-tap, pid capture, and the `__slicc_workflows` publish on top — completion itself is finished here, and the Task-4 tests stub `sharedFs`/`fireLick`.)

```ts
// packages/webapp/src/scoops/workflow-run-manager.ts
import { createLogger } from '../core/logger.js';

const log = createLogger('workflow-run-manager');
export const WORKFLOW_MANAGER_GLOBAL_KEY = '__slicc_workflows';
const RUNS_DIR = '/shared/workflow-runs';

export interface WorkflowRunState {
  id: string;
  name: string | null;
  source: string;
  origin: 'cone' | 'scoop' | 'terminal';
  status: 'running' | 'paused' | 'done' | 'error' | 'killed';
  currentPhase: string | null;
  agentsStarted: number;
  agentsDone: number;
  logs: string[];
  startedAt: string;
  finishedAt: string | null;
  resultPath: string | null;
  preview: string | null;
  error: string | null;
  pid: number | null;
}

export interface WorkflowStartOptions {
  code: string;
  source: string;
  name: string | null;
  filename: string;
  parentJid: string | undefined;
  ctx: CommandContextLike;
  /**
   * The result sentinel. Built ONCE by the command (Task 7) and passed into BOTH
   * `buildWorkflowCode({ sentinel })` (the realm code) and here, so `splitResult`
   * matches exactly what the realm emits. The manager does not invent its own.
   */
  sentinel: string;
}

// Minimal shell ctx shape the manager needs (subset of just-bash CommandContext).
export interface CommandContextLike {
  cwd: string;
  env: Map<string, string>;
  stdin: string;
  exec?: ((cmd: string, opts?: { cwd?: string; args?: string[] }) => Promise<ExecResultLike>) & {
    spawn?: (argv: string[]) => Promise<ExecResultLike>;
  };
  fs?: unknown;
}
export interface ExecResultLike {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface WorkflowRunManagerDeps {
  sharedFs: {
    mkdir(p: string, o: { recursive: boolean }): Promise<void>;
    writeFile(p: string, data: string): Promise<void>;
  };
  getConeJid: () => string | undefined;
  fireLick: (event: import('./lick-manager.js').LickEvent) => void;
  processManager: {
    on(
      event: 'spawn',
      fn: (proc: { pid: number; argv: string[]; kind: string }) => void
    ): () => void;
  };
  // Injectable launch — production wires executeJsCode; tests stub it.
  runRealm: (code: string, argv: string[], ctx: CommandContextLike) => Promise<ExecResultLike>;
  makeRunId: () => string;
  splitResult: (
    stdout: string,
    sentinel: string
  ) => { result: unknown; log: string; hadResult: boolean };
}

export interface WorkflowRunManager {
  start(opts: WorkflowStartOptions): Promise<{ runId: string }>;
  getRun(runId: string): WorkflowRunState | null;
  listRuns(): WorkflowRunState[];
  observeRun(runId: string, handler: (s: WorkflowRunState) => void): () => void;
}

export function createWorkflowRunManager(deps: WorkflowRunManagerDeps): WorkflowRunManager {
  const runs = new Map<string, WorkflowRunState>();
  const observers = new Map<string, Set<(s: WorkflowRunState) => void>>();

  const notify = (id: string) => {
    const s = runs.get(id);
    if (!s) return;
    for (const h of observers.get(id) ?? []) {
      try {
        h(s);
      } catch (e) {
        log.warn('observeRun handler threw', e);
      }
    }
  };

  const classifyOrigin = (parentJid: string | undefined): WorkflowRunState['origin'] => {
    if (parentJid === undefined) return 'terminal';
    return parentJid === deps.getConeJid() ? 'cone' : 'scoop';
  };

  async function start(opts: WorkflowStartOptions): Promise<{ runId: string }> {
    const runId = deps.makeRunId();
    const sentinel = opts.sentinel; // built by the command; never invented here
    const state: WorkflowRunState = {
      id: runId,
      name: opts.name,
      source: opts.source,
      origin: classifyOrigin(opts.parentJid),
      status: 'running',
      currentPhase: null,
      agentsStarted: 0,
      agentsDone: 0,
      logs: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      resultPath: null,
      preview: null,
      error: null,
      pid: null,
    };
    runs.set(runId, state);

    // Task 5 replaces `opts.ctx` with a tapped context + adds pid capture here.
    // The manager is ALWAYS non-blocking: it kicks off the realm and returns the runId
    // immediately. `--wait` is NOT handled here — the command bypasses the manager entirely
    // for `--wait` (Task 7 Step 4) and runs the SP1 inline path, so `start` never awaits.
    void deps
      .runRealm(opts.code, ['workflow', opts.filename], opts.ctx)
      .then((result) => finish(runId, sentinel, result))
      .catch((err) => fail(runId, err instanceof Error ? err.message : String(err)));

    return { runId };
  }

  async function finish(runId: string, sentinel: string, result: ExecResultLike): Promise<void> {
    const { result: value, hadResult } = deps.splitResult(result.stdout, sentinel);
    if (result.exitCode === 137) {
      // SIGKILL (kill -KILL) → 'killed', not 'error' (spec §8).
      return complete(runId, 'killed', null, result.stderr || 'killed (SIGKILL)');
    }
    if (result.exitCode !== 0 || !hadResult) {
      return complete(
        runId,
        'error',
        null,
        result.stderr || (hadResult ? `exit ${result.exitCode}` : 'script produced no result')
      );
    }
    return complete(runId, 'done', value, null);
  }

  // Thrown launch error (realm crash) → error.
  function fail(runId: string, error: string): Promise<void> {
    return complete(runId, 'error', null, error);
  }

  // Single completion path: writes the run file for success AND failure (spec §8
  // requires errors captured in the file too), updates state, notifies, delivers.
  async function complete(
    runId: string,
    status: 'done' | 'error' | 'killed',
    value: unknown,
    error: string | null
  ): Promise<void> {
    const state = runs.get(runId);
    if (!state) return;
    const resultPath = `${RUNS_DIR}/${runId}.json`;
    try {
      await deps.sharedFs.mkdir(RUNS_DIR, { recursive: true });
      await deps.sharedFs.writeFile(
        resultPath,
        JSON.stringify(
          {
            name: state.name,
            status,
            result: status === 'done' ? value : null,
            error,
            logs: state.logs,
            startedAt: state.startedAt,
            finishedAt: new Date().toISOString(),
          },
          null,
          2
        )
      );
      state.resultPath = resultPath;
    } catch (e) {
      log.warn('failed to write run result file', e); // best-effort; state still updates
    }
    state.status = status;
    state.error = error;
    state.finishedAt = new Date().toISOString();
    state.preview = status === 'done' ? previewOf(value) : (error ?? '');
    notify(runId);
    deliver(state);
  }

  function deliver(state: WorkflowRunState): void {
    if (state.origin !== 'cone') return; // terminal/scoop: surfaced via `workflow status`
    deps.fireLick({
      type: 'workflow',
      workflowRunId: state.id,
      workflowName: state.name ?? undefined,
      resultPath: state.resultPath ?? undefined,
      preview: state.preview ?? state.error ?? undefined,
      timestamp: new Date().toISOString(),
      body: { runId: state.id, status: state.status, error: state.error },
    });
  }

  return {
    start,
    getRun: (id) => runs.get(id) ?? null,
    listRuns: () => Array.from(runs.values()),
    observeRun(id, handler) {
      let set = observers.get(id);
      if (!set) {
        set = new Set();
        observers.set(id, set);
      }
      set.add(handler);
      return () => set!.delete(handler);
    },
  };
}

function previewOf(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return (s ?? 'null').slice(0, 200);
}
```

Add the import for `CommandContext` typing only if you prefer the real type; the `CommandContextLike` subset above avoids a hard just-bash dependency in this scoops-layer file. (If `ExecResultLike`/`CommandContextLike` collide with existing types, reuse the real `CommandContext` from just-bash instead.)

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `npm test -w @slicc/webapp -- --run tests/scoops/workflow-run-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Add a terminal-origin + error test, run, confirm pass.** Add to the same file:

```ts
it('terminal-origin does NOT fire a lick; cone-origin does', async () => {
  const fireLick = vi.fn();
  const mgr = createWorkflowRunManager(makeDeps({ fireLick }) as any);
  await mgr.start({
    code: 'C',
    source: 'S',
    name: 'n',
    filename: 'f',
    parentJid: undefined,
    sentinel: 'WF_RESULT_x',
    ctx: {} as any,
  });
  await vi.waitFor(() => expect(mgr.listRuns()[0].status).toBe('done'));
  expect(fireLick).not.toHaveBeenCalled();

  const fireLick2 = vi.fn();
  const mgr2 = createWorkflowRunManager(makeDeps({ fireLick: fireLick2 }) as any);
  await mgr2.start({
    code: 'C',
    source: 'S',
    name: 'n',
    filename: 'f',
    parentJid: 'cone_1',
    sentinel: 'WF_RESULT_x',
    ctx: {} as any,
  });
  await vi.waitFor(() => expect(fireLick2).toHaveBeenCalledTimes(1));
  expect(fireLick2.mock.calls[0][0].type).toBe('workflow');
  expect(fireLick2.mock.calls[0][0].resultPath).toContain('/shared/workflow-runs/');
});

it('non-zero exit → status error + error notification', async () => {
  const fireLick = vi.fn();
  const mgr = createWorkflowRunManager(
    makeDeps({
      fireLick,
      runRealm: vi.fn(async () => ({ stdout: '', stderr: 'boom', exitCode: 1 })),
    }) as any
  );
  await mgr.start({
    code: 'C',
    source: 'S',
    name: 'n',
    filename: 'f',
    parentJid: 'cone_1',
    sentinel: 'WF_RESULT_x',
    ctx: {} as any,
  });
  await vi.waitFor(() => expect(mgr.listRuns()[0].status).toBe('error'));
  expect(mgr.listRuns()[0].error).toContain('boom');
  expect(fireLick).toHaveBeenCalledTimes(1);
});
```

Run the file again → PASS.

- [ ] **Step 6: Lint + commit.**

```bash
npm run lint
git add packages/webapp/src/scoops/workflow-run-manager.ts packages/webapp/tests/scoops/workflow-run-manager.test.ts
git commit -m "feat(workflow): WorkflowRunManager state + non-blocking start + completion delivery"
```

---

## Task 5: Exec-tap (live progress) + pid capture + per-run exec isolation

**Files:**

- Modify: `packages/webapp/src/scoops/workflow-run-manager.ts`
- Test: `packages/webapp/tests/scoops/workflow-run-manager.test.ts` (extend)

Why: progress comes from wrapping the run's `ctx.exec` (the lowering point — `realm-host` calls `ctx.exec(cmd, {args})`). `agent` calls bump `agentsStarted`/`agentsDone`; `__wf_progress` calls update `currentPhase`/`logs` without invoking a real command. Pid capture (`pm.on('spawn')`) records `runState.pid` for `workflow stop`. Each run gets its **own** wrapped ctx so a background run can't corrupt the foreground shell.

- [ ] **Step 1: Write the failing tap test.**

```ts
it('exec-tap: agent argv bumps agentsStarted/Done; __wf_progress updates phase/logs; others pass through', async () => {
  let realExecCalls: string[][] = [];
  const baseCtx = {
    cwd: '/',
    env: new Map<string, string>(),
    stdin: '',
    exec: Object.assign(
      async (cmd: string, opts?: { args?: string[] }) => {
        realExecCalls.push([cmd, ...(opts?.args ?? [])]);
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      },
      { spawn: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }) }
    ),
  } as any;
  // runRealm drives the tapped ctx the way the realm would, then resolves.
  const deps = makeDeps({
    runRealm: vi.fn(async (_code, _argv, ctx: any) => {
      await ctx.exec('__wf_progress', { args: ['phase', 'Scan'] });
      await ctx.exec('__wf_progress', { args: ['log', 'hello'] });
      await ctx.exec('agent', { args: ['--read-only', '/workspace/', '/s', '*', 'do it'] });
      await ctx.exec('ls', { args: ['/workspace'] });
      return { stdout: 'WF_RESULT_x' + JSON.stringify({ ok: true }), stderr: '', exitCode: 0 };
    }),
  });
  const mgr = createWorkflowRunManager(deps as any);
  const { runId } = await mgr.start({
    code: 'C',
    source: 'S',
    name: 'n',
    filename: 'f',
    parentJid: undefined,
    sentinel: 'WF_RESULT_x',
    ctx: baseCtx,
  });
  await vi.waitFor(() => expect(mgr.getRun(runId)!.status).toBe('done'));
  const s = mgr.getRun(runId)!;
  expect(s.currentPhase).toBe('Scan');
  expect(s.logs).toEqual(['Scan', 'hello']); // or however you store phase+log; adjust assertion to your impl
  expect(s.agentsStarted).toBe(1);
  expect(s.agentsDone).toBe(1);
  // __wf_progress was intercepted (not passed through); agent + ls were:
  expect(realExecCalls.find((c) => c[0] === '__wf_progress')).toBeUndefined();
  expect(realExecCalls.find((c) => c[0] === 'agent')).toBeDefined();
  expect(realExecCalls.find((c) => c[0] === 'ls')).toBeDefined();
});
```

(Decide your `logs` shape: the spec says `logs: string[]` of phase/log lines in order. The assertion above stores both phase titles and log messages; if you prefer to track `currentPhase` separately and only push `log()` text, adjust the assertion to match — keep it consistent with Task 8's `status` rendering.)

- [ ] **Step 2: Run it to confirm it fails** (no tap yet — `agentsStarted` stays 0, `__wf_progress` passes through).

Run: `npm test -w @slicc/webapp -- --run tests/scoops/workflow-run-manager.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the tap + pid capture in `start`.** Add a `wrapCtx` helper and a scoped `pm.on('spawn')` listener; replace the `start` launch block:

```ts
function wrapCtx(ctx: CommandContextLike, runId: string): CommandContextLike {
  const realExec = ctx.exec;
  if (!realExec) return ctx;
  const tappedExec = (async (
    cmd: string,
    opts?: { cwd?: string; args?: string[] }
  ): Promise<ExecResultLike> => {
    const args = opts?.args ?? [];
    if (cmd === '__wf_progress') {
      const kind = args[0];
      const text = args[1] ?? '';
      const s = runs.get(runId);
      if (s) {
        if (kind === 'phase') {
          s.currentPhase = text;
          s.logs.push(text);
        } else if (kind === 'log') {
          s.logs.push(text);
        }
        notify(runId);
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (cmd === 'agent') {
      const s = runs.get(runId);
      if (s) {
        s.agentsStarted++;
        notify(runId);
      }
      try {
        return await realExec(cmd, opts);
      } finally {
        const s2 = runs.get(runId);
        if (s2) {
          s2.agentsDone++;
          notify(runId);
        }
      }
    }
    return realExec(cmd, opts);
  }) as CommandContextLike['exec'];
  // Preserve the .spawn surface realm-host doesn't use, but keep parity.
  (tappedExec as { spawn?: unknown }).spawn = (ctx.exec as { spawn?: unknown }).spawn;
  return { ...ctx, exec: tappedExec };
}
```

In `start`, wrap the ctx and capture the pid:

```ts
const wrappedCtx = wrapCtx(opts.ctx, runId);
const offSpawn = deps.processManager.on('spawn', (proc) => {
  // Match by argv, NOT kind: runInRealm registers the JS execution as ProcessKind
  // 'jsh' ('js' is the realm kind, not the process kind), and argv is the
  // ['workflow', filename] we pass to executeJsCode — specific + reliable.
  if (state.pid === null && proc.argv[0] === 'workflow' && proc.argv[1] === opts.filename) {
    state.pid = proc.pid;
    notify(runId);
  }
});
const launch = deps
  .runRealm(opts.code, ['workflow', opts.filename], wrappedCtx)
  .then((result) => finish(runId, sentinel, result))
  .catch((err) => fail(runId, err instanceof Error ? err.message : String(err)))
  .finally(() => offSpawn());
```

**Per-run exec isolation (spec §5 — SP2 decision: accept + document the narrow risk).** The spec wants a background run's exec isolated from the foreground shell because `WasmShellHeadless` shares `cwd`/`lastEnv` (`wasm-shell-headless.ts:522,531`). SP2 reuses the launching `ctx.exec` (via `wrapCtx`) and does NOT add a per-run shell. The honest risk picture (corrected from an earlier draft — do not restate the false "exec surface is only agent/\_\_wf_progress" claim):

- The **documented** workflow API the user body is meant to use — `agent` / `parallel` / `pipeline` / `phase` / `log` — only ever spawns `agent` and `__wf_progress`, and **neither mutates the shell's `cwd`/`lastEnv`** (no `cd`, no env-export; they read `ctx.cwd` but don't write shell state). For workflows that stay within this API, reusing `ctx.exec` is safe.
- **However**, the prelude binds `const __execSpawn = exec.spawn.bind(exec)` (`workflow-prelude.ts:31-33`) at a scope the appended user body closes over (`buildWorkflowCode` emits the prelude, then the body inside `(async () => { … })()` in the SAME function — `workflow-script.ts:46-54`). So a workflow that deliberately calls the **undocumented internal** `__execSpawn(['cd', …])` / `__execSpawn(['secret','set',…])` reaches `ctx.exec` directly (`realm-host.ts:302-315`) and CAN mutate the launching shell's `cwd`/`lastEnv` (`secret set` → `setEnv`, `wasm-shell-headless.ts:319-325`). In a backgrounded run that mutation happens asynchronously against the foreground shell = real corruption.
- **SP2 stance:** reaching `__execSpawn` is **out of contract** — it's an internal, not part of the workflow API surface, and this exposure already exists in SP1 (synchronous `workflow run`). SP2 does not widen it; it only makes it asynchronous. We accept it for SP2 and **defer real isolation to SP6** (the proper fixes: hide `__execSpawn` behind an IIFE so the user body can't see it, OR back the run with a per-run shell that owns its own `cwd`/`lastEnv`). Leave a one-line comment in `wrapCtx` recording this invariant and pointing at SP6.
- **Guard test (covers the in-contract guarantee only):** interleave a backgrounded run's documented-API `agent` execs with a foreground `cd /tmp` on the same shell and assert the foreground `cwd` is unchanged. Add a comment in the test stating it does NOT cover the out-of-contract `__execSpawn` escape hatch (tracked for SP6).

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `npm test -w @slicc/webapp -- --run tests/scoops/workflow-run-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Add a pid-capture test.**

```ts
it('captures the realm pid via pm.on(spawn)', async () => {
  let spawnHandler: ((p: any) => void) | undefined;
  const pm = {
    on: vi.fn((_e: string, fn: any) => {
      spawnHandler = fn;
      return () => {};
    }),
  };
  const realmDone = deferred<any>();
  const deps = makeDeps({ processManager: pm as any, runRealm: vi.fn(() => realmDone.promise) });
  const mgr = createWorkflowRunManager(deps as any);
  const { runId } = await mgr.start({
    code: 'C',
    source: 'S',
    name: 'n',
    filename: 'f',
    parentJid: undefined,
    sentinel: 'WF_RESULT_x',
    ctx: { exec: vi.fn() } as any,
  });
  // Real realm-JS processes are kind:'jsh' (runInRealm default). The production filter
  // matches on argv ([0]==='workflow' && [1]===filename), NOT kind, so kind here is just
  // realistic fixture data — must match reality so the test isn't misleading.
  spawnHandler?.({ pid: 4242, kind: 'jsh', argv: ['workflow', 'f'] });
  expect(mgr.getRun(runId)!.pid).toBe(4242);
  realmDone.resolve({ stdout: 'WF_RESULT_x' + JSON.stringify({}), stderr: '', exitCode: 0 });
  await vi.waitFor(() => expect(mgr.getRun(runId)!.status).toBe('done'));
});
```

Run the file → PASS.

- [ ] **Step 6: Lint + commit.**

```bash
npm run lint
git add packages/webapp/src/scoops/workflow-run-manager.ts packages/webapp/tests/scoops/workflow-run-manager.test.ts
git commit -m "feat(workflow): exec-tap progress + realm pid capture in WorkflowRunManager"
```

---

## Task 6: Publish on `__slicc_workflows` + wire into `kernel/host.ts`

**Files:**

- Modify: `packages/webapp/src/scoops/workflow-run-manager.ts` (add `publishWorkflowRunManager`)
- Modify: `packages/webapp/src/kernel/host.ts`
- Modify: `packages/webapp/src/shell/jsh-executor.ts` **only if** you choose to expose a pid hook — NOT required (the `pm.on('spawn')` capture from Task 5 needs no executor change).
- Test: `packages/webapp/tests/scoops/workflow-run-manager.test.ts` (publish test)

Why: the command and the cone reach the manager via `globalThis.__slicc_workflows`, exactly like `__slicc_agent`. The production `runRealm` is `executeJsCode`; the production `splitResult` is `splitSentinel`; `makeRunId` derives a short id from `makeSentinel()` (the sentinel itself is owned by the command — see "Sentinel ownership" below).

- [ ] **Step 1: Write the failing publish test.**

```ts
import {
  publishWorkflowRunManager,
  WORKFLOW_MANAGER_GLOBAL_KEY,
} from '../../src/scoops/workflow-run-manager.js';

it('publishWorkflowRunManager sets globalThis.__slicc_workflows', () => {
  delete (globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY];
  const mgr = publishWorkflowRunManager(makeDeps() as any);
  expect((globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY]).toBe(mgr);
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npm test -w @slicc/webapp -- --run tests/scoops/workflow-run-manager.test.ts`
Expected: FAIL — `publishWorkflowRunManager` not exported.

- [ ] **Step 3: Add `publishWorkflowRunManager`** to `workflow-run-manager.ts`:

```ts
export function publishWorkflowRunManager(deps: WorkflowRunManagerDeps): WorkflowRunManager {
  const mgr = createWorkflowRunManager(deps);
  (globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY] = mgr;
  log.info('workflow run manager published on globalThis.__slicc_workflows');
  return mgr;
}
```

- [ ] **Step 4: Wire it in `host.ts`** next to `publishAgentBridge` (after `sharedFs` is resolved + after `lickManager` exists — note `lickManager` is created later at ~445, so publish the manager there, OR capture a late-bound `fireLick`). Cleanest: publish after the `lickManager.setEventHandler(...)` line (~451), where `orchestrator`, `processManager`, `sharedFs`, and `lickManager` are all in scope. Import at top and call:

```ts
import { publishWorkflowRunManager } from '../scoops/workflow-run-manager.js';
import { executeJsCode } from '../shell/jsh-executor.js';
import { makeSentinel, splitSentinel } from '../shell/supplemental-commands/workflow-script.js';

// … after lickManager.setEventHandler(...) and with sharedFs available:
if (sharedFs) {
  publishWorkflowRunManager({
    sharedFs,
    getConeJid: () => orchestrator.getScoops().find((s) => s.isCone)?.jid,
    fireLick: (event) => lickManager.emitEvent(event),
    processManager,
    runRealm: (code, argv, ctx) =>
      executeJsCode(code, argv, ctx as unknown as Parameters<typeof executeJsCode>[2], undefined, {
        filename: argv[1],
      }),
    makeRunId: () => makeSentinel().slice('WF_RESULT_'.length, 'WF_RESULT_'.length + 12),
    splitResult: (stdout, sentinel) => splitSentinel(stdout, sentinel),
  });
}
```

**Sentinel ownership:** the manager NEVER invents a sentinel. The _command_ (Task 7) builds the realm `code` via `buildWorkflowCode({ sentinel })`, so the sentinel is decided there and passed through `WorkflowStartOptions.sentinel`. The manager runs the realm with that exact sentinel and later splits the realm stdout with the same one (`deps.splitResult(stdout, opts.sentinel)`). This is why `WorkflowStartOptions` carries `sentinel: string` and `WorkflowRunManagerDeps` has no `sentinelFor` — Task 4's `start` reads `const sentinel = opts.sentinel`. Tests pass `sentinel: 'WF_RESULT_x'` in every `start(...)` call.

- [ ] **Step 5: Write the failing dual-mode (offscreen/worker) test** (spec §9 "Dual-mode"). This proves the panel terminal — which is already offscreen-backed — reaches the manager via the shared global with **no panel→offscreen proxy**, and that the manager + its publish path are float-agnostic (no `window`/`document`). The vitest env is `node` (no DOM), so successful construction in this context _is_ the worker-context assertion; we make it explicit and then assert the command's resolution path reads the same global key the host publishes under.

**Note:** this test lives in `workflow-run-manager.test.ts` but drives the command, so add these imports to that file (it already imports the manager symbols and `vi`):

```ts
import { VirtualFS } from '../../src/fs/index.js';
import { VfsAdapter } from '../../src/shell/vfs-adapter.js';
import { createWorkflowCommand } from '../../src/shell/supplemental-commands/workflow-command.js';
```

```ts
it('dual-mode: manager publishes in a no-DOM (offscreen/worker) context and the command resolves it via the shared global — no proxy', async () => {
  // Worker/offscreen has no DOM. vitest `environment: node` mirrors that, so a clean
  // construct+publish here IS the worker-context assertion (any window/document touch throws).
  expect(typeof window).toBe('undefined');
  expect(typeof document).toBe('undefined');

  delete (globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY];
  // Publish exactly as host.ts does — float-agnostic deps (sharedFs/processManager/fireLick/runRealm).
  const mgr = publishWorkflowRunManager(makeDeps() as any);
  expect((globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY]).toBe(mgr);

  // The command does NOT receive the manager by injection — it resolves it from the SAME
  // global key the host published under. That is the offscreen path: panel terminal
  // (offscreen-backed) → globalThis.__slicc_workflows → manager, with no proxy hop.
  const spy = vi.spyOn(mgr, 'start');
  const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
  await fs.mkdir('/workspace', { recursive: true });
  await fs.writeFile('/workspace/wf.js', `export const meta={name:'demo'}\nreturn 1`);
  const ctx = {
    fs: new VfsAdapter(fs),
    cwd: '/workspace',
    env: new Map<string, string>(),
    stdin: '',
    exec: Object.assign(async () => ({ stdout: '', stderr: '', exitCode: 0 }), {
      spawn: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    }),
  } as any;
  const res = await createWorkflowCommand().execute(['run', '/workspace/wf.js'], ctx);
  expect(res.exitCode).toBe(0);
  expect(spy).toHaveBeenCalledTimes(1); // command reached the published manager, not a proxy/local copy
});
```

- [ ] **Step 6: Run it to confirm it fails, then passes once Steps 3–4 + Task 7 land.**

Run: `npm test -w @slicc/webapp -- --run tests/scoops/workflow-run-manager.test.ts`
Expected before Step 3: FAIL (`publishWorkflowRunManager` not exported). After Steps 3–4 and Task 7's command delegates to the global manager: PASS. (If you author this test before Task 7, mark it `it.skip` with a `// unskip after Task 7` breadcrumb and unskip it in Task 7 Step 7.)

- [ ] **Step 7: Run the manager tests + typecheck host.**

Run: `npm test -w @slicc/webapp -- --run tests/scoops/workflow-run-manager.test.ts` → PASS.
Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "host|workflow-run-manager" || echo clean` → `clean`.

- [ ] **Step 8: Lint + commit.**

```bash
npm run lint
git add packages/webapp/src/scoops/workflow-run-manager.ts packages/webapp/src/kernel/host.ts packages/webapp/tests/scoops/workflow-run-manager.test.ts
git commit -m "feat(workflow): publish WorkflowRunManager on __slicc_workflows + host wiring"
```

---

## Task 7: `workflow` command — delegate to the manager (non-blocking + `--wait` + `status`/`list`/`stop`)

**Files:**

- Modify: `packages/webapp/src/shell/supplemental-commands/workflow-command.ts`
- Modify: `packages/webapp/src/shell/supplemental-commands/index.ts` (thread `getParentJid` into `createWorkflowCommand`)
- Test: `packages/webapp/tests/shell/supplemental-commands/workflow-command.test.ts` (extend)

Why: SP1's command owns `executeJsCode`. SP2 refactors `run` to build the code (unchanged) then **delegate to `__slicc_workflows.start`** (non-blocking default; `--wait` blocks and prints the result), and adds read/stop subcommands. Origin = `'cone'` only when the parent jid equals the cone jid.

- [ ] **Step 1: Accept `getParentJid` + a manager accessor.** Change `createWorkflowCommand()` to `createWorkflowCommand(options: { getParentJid?: () => string | undefined } = {})` and add a `--wait` flag to `parse`/`applyToken` (a boolean flag, no value: in `applyToken`, `case '--wait': o.wait = true; return { i };`, and add `wait?: boolean` to `Parsed`). Resolve the manager from `globalThis`:

```ts
import type { WorkflowRunManager } from '../../scoops/workflow-run-manager.js';
import { WORKFLOW_MANAGER_GLOBAL_KEY } from '../../scoops/workflow-run-manager.js';

function getRunManager(): WorkflowRunManager | undefined {
  return (globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY] as
    | WorkflowRunManager
    | undefined;
}
```

- [ ] **Step 2: Write the failing non-blocking test.** In `workflow-command.test.ts`, install a fake manager on `globalThis` and assert `run` returns the started line without awaiting. **Note:** the existing `workflow-command.test.ts:1` import line is `import { describe, expect, it } from 'vitest';` — these snippets use `vi.fn`, so widen that import to `import { describe, expect, it, vi } from 'vitest';`. Also add an `afterEach(() => { delete (globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY]; });` so the fake manager from one test does not leak into the next (and import `afterEach` from vitest too).

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORKFLOW_MANAGER_GLOBAL_KEY } from '../../../src/scoops/workflow-run-manager.js';

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY];
});

function installFakeManager(over: Partial<any> = {}) {
  const runs = new Map<string, any>();
  const mgr = {
    start: vi.fn(async (opts: any) => {
      const id = 'r1';
      runs.set(id, {
        id,
        name: opts.name,
        status: 'running',
        origin: 'terminal',
        agentsStarted: 0,
        agentsDone: 0,
        logs: [],
        preview: null,
        resultPath: null,
        error: null,
        pid: null,
        currentPhase: null,
        startedAt: 't',
      });
      return { runId: id };
    }),
    getRun: (id: string) => runs.get(id) ?? null,
    listRuns: () => [...runs.values()],
    observeRun: () => () => {},
    ...over,
  };
  (globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY] = mgr;
  return mgr;
}

it('run (non-blocking default) prints the started line + runId', async () => {
  installFakeManager();
  const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
  await fs.mkdir('/workspace', { recursive: true });
  await fs.writeFile('/workspace/wf.js', `export const meta={name:'demo'}\nreturn 1`);
  const res = await createWorkflowCommand().execute(
    ['run', '/workspace/wf.js'],
    await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }))
  );
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toMatch(/started.*r1/i);
});
```

- [ ] **Step 3: Run it to confirm it fails** (current command still calls `executeJsCode` directly).

Run: `npm test -w @slicc/webapp -- --run tests/shell/supplemental-commands/workflow-command.test.ts`
Expected: FAIL.

- [ ] **Step 4: Refactor the `run` body to delegate.** Replace the `executeJsCode` call + `renderResult` return in the `run` branch with manager delegation. Keep the SP1 path under `--wait` (block + print result via `renderResult`). After building `code`/`sentinel`/`banner`:

```ts
if (p.wait) {
  // --wait preserves SP1 foreground behavior EXACTLY: run the realm inline, print
  // the FULL result, and do NOT register a run or fire a completion lick. (Routing
  // --wait through the manager would only surface a preview and would fire an async
  // 'workflow' lick for cone-origin runs — neither of which SP1 did.) The run
  // manager is NOT required on this path.
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await executeJsCode(code, ['workflow', filename], ctx, undefined, { filename });
  } catch (err) {
    return {
      stdout: '',
      stderr: `workflow: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }
  return renderResult(banner, result, sentinel); // SP1 helper — full result, no lick
}

// Non-blocking (default): delegate to the run manager.
const mgr = getRunManager();
if (!mgr) return { stdout: '', stderr: 'workflow: run manager not available\n', exitCode: 1 };
const parentJid = options.getParentJid?.();
const { runId } = await mgr.start({
  code,
  source,
  name: banner.name,
  filename,
  parentJid,
  ctx,
  sentinel,
});
return {
  stdout: `▶ workflow '${banner.name}' started (run ${runId}). Watch: workflow status ${runId}\n`,
  stderr: '',
  exitCode: 0,
};
```

`renderResult`/`renderLog` (the SP1 helpers) **stay** — `--wait` still uses them to print the full result + log markers exactly as SP1 did, so the SP1 command tests that assert that output continue to pass unchanged. Only the non-blocking (default) path is new. `executeJsCode` stays imported (used by `--wait`).

- [ ] **Step 5: Add `status`/`list`/`stop` subcommands.** Extend `parse` so `a[0]` can be `status`/`list`/`stop`. Implement before the `run` logic in the command body:

```ts
if (args[0] === 'list') {
  const mgr = getRunManager();
  if (!mgr) return { stdout: '', stderr: 'workflow: run manager not available\n', exitCode: 1 };
  const rows = mgr
    .listRuns()
    .map(
      (r) => `${r.id}  ${r.status.padEnd(7)}  ${r.agentsDone}/${r.agentsStarted}  ${r.name ?? ''}`
    );
  return { stdout: (rows.length ? rows.join('\n') : '(no runs)') + '\n', stderr: '', exitCode: 0 };
}
if (args[0] === 'status') {
  const mgr = getRunManager();
  const id = args[1];
  const st = mgr?.getRun(id ?? '');
  if (!st) return { stdout: '', stderr: `workflow: no run '${id}'\n`, exitCode: 1 };
  const lines = [
    `run ${st.id}  (${st.name ?? 'unnamed'})  status=${st.status}`,
    `agents ${st.agentsDone}/${st.agentsStarted}  phase=${st.currentPhase ?? '-'}`,
    st.resultPath ? `result: ${st.resultPath}` : '',
    st.preview ? `preview: ${st.preview}` : '',
    st.error ? `error: ${st.error}` : '',
  ].filter(Boolean);
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
}
if (args[0] === 'stop') {
  const mgr = getRunManager();
  const id = args[1];
  const st = mgr?.getRun(id ?? '');
  if (!st) return { stdout: '', stderr: `workflow: no run '${id}'\n`, exitCode: 1 };
  if (st.pid != null) await ctx.exec?.('kill', { args: ['-KILL', String(st.pid)] });
  return { stdout: `stopped run ${id} (pid ${st.pid ?? '?'})\n`, stderr: '', exitCode: 0 };
}
```

(Update `parse`/`HELP` so `status`/`list`/`stop` aren't rejected as "unknown subcommand". The simplest: handle these three before calling `parse`, and let `parse` keep owning `run`.)

- [ ] **Step 6: Thread `getParentJid` in `index.ts`.** Change the registration from `createWorkflowCommand()` to `createWorkflowCommand({ getParentJid: options.getParentJid })` (mirroring how `createAgentCommand({ getParentJid })` is wired). Confirm `SupplementalCommandsConfig` already exposes `getParentJid` (it does — `createAgentCommand` uses it).

- [ ] **Step 7: Write the `--wait` + `status`/`list`/`stop` tests, run, confirm pass.**

```ts
it('--wait blocks and prints the full result (inline SP1 path — bypasses the manager)', async () => {
  // IMPORTANT: --wait does NOT touch the run manager. It runs the real realm via
  // executeJsCode and the realm SELF-EMITS the sentinel line for `return {ok:true}`
  // (buildWorkflowCode appends `__emit(sentinel + stringify(__r))`), which renderResult
  // then extracts. So no installFakeManager and no mock-spawn stdout is involved — the
  // workflow body has no agent() calls, so ctxWith's spawn is never invoked. (Do NOT
  // install a fake manager here; it would be dead code and imply the result comes from
  // the manager, which is the non-blocking path's job, not --wait's.)
  const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
  await fs.mkdir('/workspace', { recursive: true });
  await fs.writeFile('/workspace/wf.js', `export const meta={name:'demo'}\nreturn {ok:true}`);
  const res = await createWorkflowCommand().execute(
    ['run', '--wait', '/workspace/wf.js'],
    await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }))
  );
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toContain('{"ok":true}');
});

it('list / status / stop render run state', async () => {
  const killed: string[][] = [];
  installFakeManager({
    listRuns: () => [
      { id: 'r1', status: 'running', agentsDone: 1, agentsStarted: 2, name: 'demo' },
    ],
    getRun: () => ({
      id: 'r1',
      name: 'demo',
      status: 'running',
      agentsDone: 1,
      agentsStarted: 2,
      currentPhase: 'Scan',
      resultPath: null,
      preview: null,
      error: null,
      pid: 1234,
    }),
  });
  const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
  const ctx = await ctxWith(fs, async (a) => {
    killed.push(a);
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  expect((await createWorkflowCommand().execute(['list'], ctx)).stdout).toContain('r1');
  expect((await createWorkflowCommand().execute(['status', 'r1'], ctx)).stdout).toMatch(
    /status=running/
  );
  await createWorkflowCommand().execute(['stop', 'r1'], ctx);
  expect(killed).toContainEqual(['kill', '-KILL', '1234']);
});
```

Run the file → PASS. Also re-run the SP1 command tests in the same file (the file-not-found / thrown-body cases now go through the manager — adjust those tests to install the fake manager, or assert the new non-blocking line; update as needed so the whole file is green). **If you `it.skip`'d the Task 6 Step 5 dual-mode test** (because the command wasn't wired yet), unskip it now and run `npm test -w @slicc/webapp -- --run tests/scoops/workflow-run-manager.test.ts` → PASS.

- [ ] **Step 7b: Update the SP1 acceptance test for the non-blocking default (REQUIRED — it breaks otherwise).** `packages/webapp/tests/shell/supplemental-commands/workflow-acceptance.test.ts` runs `workflow run …` and parses the LAST stdout line as the JSON result (`expect(parsed.confirmed)…`). After this task, default `workflow run` returns the `▶ … started (run <id>)` line and the JSON result is no longer printed — so that parse breaks. Fix: add `--wait` to the args so the acceptance test keeps exercising the full fan-out/verify result via the inline SP1 path (it does not touch the manager, and the test's `spawn` mock still drives the `agent` calls):

```ts
const res = await createWorkflowCommand().execute(
  [
    'run',
    '--wait', // SP2: default run is non-blocking; --wait keeps the full-result assertion below
    '/workspace/repo-audit.workflow.js',
    '--args',
    '{"files":["a.ts","b.ts"]}',
    '--concurrency',
    '4',
  ],
  await ctxWith(fs, spawn)
);
```

Everything else in that test (the count-only concurrency barrier, the `peak.max` assertions) is unchanged. Run: `npm test -w @slicc/webapp -- --run tests/shell/supplemental-commands/workflow-acceptance.test.ts` → PASS. (Note: this file currently lives on `main` with a deterministic concurrency barrier from the main-unblock fix — keep that barrier; only add `--wait`.)

- [ ] **Step 8: origin-classification unit (manager already covers it; add a command-level guard if you wired origin in the command).** If you pass `parentJid` to the manager (recommended — the manager classifies), no extra command test is needed beyond confirming `start` is called with the right `parentJid`. Add:

```ts
it('passes the parent jid to the manager for origin classification', async () => {
  const mgr = installFakeManager();
  const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
  await fs.mkdir('/workspace', { recursive: true });
  await fs.writeFile('/workspace/wf.js', `export const meta={name:'demo'}\nreturn 1`);
  await createWorkflowCommand({ getParentJid: () => 'cone_1' }).execute(
    ['run', '/workspace/wf.js'],
    await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }))
  );
  expect((mgr.start as any).mock.calls[0][0].parentJid).toBe('cone_1');
});
```

- [ ] **Step 9: Lint + commit.**

```bash
npm run lint
git add packages/webapp/src/shell/supplemental-commands/workflow-command.ts packages/webapp/src/shell/supplemental-commands/index.ts packages/webapp/tests/shell/supplemental-commands/workflow-command.test.ts
git commit -m "feat(workflow): non-blocking run via WorkflowRunManager + status/list/stop + --wait"
```

---

## Task 8: Integration test — background fan-out, progress, file, lick

**Files:**

- Test: `packages/webapp/tests/scoops/workflow-run-manager.integration.test.ts` (new)

Why: prove the pieces compose: a real `splitSentinel` + a mock `runRealm` that drives the tapped ctx through several `agent`/`__wf_progress` calls concurrently; poll `getRun` to `done`; assert the result file write payload, that `agentsDone` advanced past 1, and (cone-origin) the lick.

- [ ] **Step 1: Write the integration test.** Use the REAL `splitSentinel` (import from `workflow-script.js`) and a `sharedFs` spy capturing the write; drive concurrency in the mock `runRealm`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createWorkflowRunManager } from '../../src/scoops/workflow-run-manager.js';
import { splitSentinel } from '../../src/shell/supplemental-commands/workflow-script.js';

it('backgrounds a fan-out: progress advances, file written, cone lick fired', async () => {
  const writes: Array<{ path: string; data: string }> = [];
  const fireLick = vi.fn();
  const sentinel = 'WF_RESULT_int';
  const mgr = createWorkflowRunManager({
    sharedFs: {
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async (p: string, d: string) => {
        writes.push({ path: p, data: d });
      }),
    } as any,
    getConeJid: () => 'cone_1',
    fireLick,
    processManager: { on: vi.fn(() => () => {}) } as any,
    runRealm: async (_c, _a, ctx: any) => {
      await ctx.exec('__wf_progress', { args: ['phase', 'Find'] });
      // two agents concurrently:
      await Promise.all([
        ctx.exec('agent', { args: ['--read-only', '/workspace/', '/s', '*', 'a'] }),
        ctx.exec('agent', { args: ['--read-only', '/workspace/', '/s', '*', 'b'] }),
      ]);
      return {
        stdout: 'logline\n' + sentinel + JSON.stringify({ confirmed: 2 }),
        stderr: '',
        exitCode: 0,
      };
    },
    makeRunId: () => 'int1',
    splitResult: (stdout) => splitSentinel(stdout, sentinel),
  } as any);

  const { runId } = await mgr.start({
    code: 'C',
    source: 'S',
    name: 'audit',
    filename: 'wf.js',
    parentJid: 'cone_1',
    ctx: {
      cwd: '/',
      env: new Map(),
      stdin: '',
      exec: Object.assign(async () => ({ stdout: '', stderr: '', exitCode: 0 }), {
        spawn: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      }),
    } as any,
    sentinel,
  });

  await vi.waitFor(() => expect(mgr.getRun(runId)!.status).toBe('done'));
  const s = mgr.getRun(runId)!;
  expect(s.currentPhase).toBe('Find');
  expect(s.agentsStarted).toBe(2);
  expect(s.agentsDone).toBe(2);
  expect(writes[0].path).toBe('/shared/workflow-runs/int1.json');
  expect(JSON.parse(writes[0].data).result).toEqual({ confirmed: 2 });
  expect(fireLick).toHaveBeenCalledTimes(1);
  expect(fireLick.mock.calls[0][0]).toMatchObject({
    type: 'workflow',
    workflowName: 'audit',
    resultPath: '/shared/workflow-runs/int1.json',
  });
});
```

- [ ] **Step 2: Run it.**

Run: `npm test -w @slicc/webapp -- --run tests/scoops/workflow-run-manager.integration.test.ts`
Expected: PASS (no new production code — this validates Tasks 4–6 composing). If it fails, fix the manager, not the test.

- [ ] **Step 3: Commit.**

```bash
git add packages/webapp/tests/scoops/workflow-run-manager.integration.test.ts
git commit -m "test(workflow): integration — background fan-out, progress, result file, cone lick"
```

---

## Task 9: Documentation

**Files:**

- Modify: `docs/shell-reference.md` (the `workflow` section + command table row)
- Modify: `docs/architecture.md` (subsystem + lick inventory)
- Modify: root `CLAUDE.md`, `packages/webapp/CLAUDE.md`, `packages/vfs-root/shared/CLAUDE.md`

- [ ] **Step 1: `docs/shell-reference.md`.** Update the `workflow` usage block + table row: non-blocking default (`workflow run` prints `▶ … started (run <id>)`), `--wait` for SP1 blocking, and add `workflow status <id>`, `workflow list`, `workflow stop <id>`. Note the cone receives completion as a new turn (path + preview) for cone-origin runs; terminal/scoop runs surface via `workflow status`.

- [ ] **Step 2: `docs/architecture.md`.** Add `WorkflowRunManager` (`scoops/workflow-run-manager.ts`, `__slicc_workflows`, durable realm, exec-tap progress, file+lick delivery) to the subsystem map; add `'workflow'` to the lick-channel inventory; note the `__wf_progress` command + the additive prelude emit.

- [ ] **Step 3: `CLAUDE.md` (root + webapp).** One line each: the run manager + `__slicc_workflows` global + the new `workflow` lick. Keep within `lint:docs` size caps (root ≤ 30000).

- [ ] **Step 4: `packages/vfs-root/shared/CLAUDE.md` (agent-facing, ≤ 3000 bytes).** Update the Workflows section: workflows now run **in the background** by default and report completion as a new turn (`[Workflow: <name>] … Full result: /shared/workflow-runs/<id>.json`); use `--wait` to block; `workflow status`/`list`/`stop`. Keep it terse; trim elsewhere if near the cap.

- [ ] **Step 5: Lint (formats md + checks doc sizes) + commit.**

```bash
npm run lint
git add docs/shell-reference.md docs/architecture.md CLAUDE.md packages/webapp/CLAUDE.md packages/vfs-root/shared/CLAUDE.md
git commit -m "docs(workflow): SP2 background runs — non-blocking default, status/list/stop, run manager + lick"
```

---

## Task 10: Full verification (CI gates) + dual-float manual check

- [ ] **Step 1: `npm run lint`** → clean (do first; most common CI failure).
- [ ] **Step 2: `npm run typecheck`** → 0 errors (6 tsc projects).
- [ ] **Step 3: De-debt `host.ts` (REQUIRED — SP2 touches it) + verify the gate.** SP2 modifies `packages/webapp/src/kernel/host.ts` (Task 1 lick branch + Task 6 manager publish), and it is on biome.json's complexity debt list (`biome.json:267`). The `check-touched-exemptions` gate therefore requires this PR to:
  1. Run `npx biome lint packages/webapp/src/kernel/host.ts` (with the override removed) to list every function over the caps (cognitive ≤ 25, lines ≤ 150 `skipIifes`).
  2. Extract those functions' bodies into named helpers within `host.ts` until each is under the caps. Keep the SP2 additions minimal (one `publishWorkflowRunManager(...)` call; the workflow lick name/id routing as a small helper) so the de-debt surface stays small.
  3. Delete the `"packages/webapp/src/kernel/host.ts"` line from the `biome.json` `overrides` debt list (`biome.json:267`).
  4. Run `node packages/dev-tools/tools/check-touched-exemptions.mjs origin/main` → must print **OK**, and `npx biome check packages/webapp/src/kernel/host.ts` → clean.

  (No other touched file is on the list — see the boy-scout note up top.)

- [ ] **Step 4: `npm test`** → all pass; then `npm run test:coverage:webapp` → at/above the floor in `coverage-thresholds.json` (the new `workflow-run-manager.ts` carries its own tests; add cases if it dips below).
- [ ] **Step 5: `npm run build -w @slicc/webapp && npm run build -w @slicc/chrome-extension`** → both succeed.
- [ ] **Step 6: Manual dual-float smoke** (real scoops; record in the PR body). Standalone (`npm run dev`) and extension (`npm run dev -- --profile=extension`, production build). The script: `workflow run --script 'export const meta={name:"bg"}; phase("go"); const r=await agent("Reply with one word: ok"); return {r}'`.
  - **Terminal-origin (no cone turn):** run it in the **terminal** → prints `▶ … started (run <id>)` immediately; `workflow status <id>` shows progress then `done` with the result file; **the cone chat gets NO turn** (terminal-origin must not notify the cone — spec §5).
  - **Cone-origin (delivers a turn):** ask the **cone in chat** to run the same command via bash → on completion the cone receives a new `[Workflow: bg] … Full result: /shared/workflow-runs/<id>.json` turn (this is the cone-origin lick path).
  - **Survival:** start a longer run, close + reopen the extension side panel mid-run, confirm `workflow status <id>` still resolves (offscreen durability).
- [ ] **Step 7:** Commit any fixups, then `superpowers:finishing-a-development-branch` to rebase onto current `main` (NOT merge — the `linear-history` gate rejects merge commits; use `git fetch && git rebase origin/main && git push --force-with-lease`) and open the PR with the manual dual-float result in the body.

---

## Self-review (run before handing off)

- **Spec coverage:** §2 non-blocking launch (Task 4/7), live progress (Task 3 emit + Task 5 tap), async result delivery (Task 6 file + Task 1 lick); §5 manager API (Task 4–6), `--wait` (Task 7), origin classification (Task 4 `classifyOrigin` + Task 7 parentJid), stop semantics (Task 7 `stop` → `kill -KILL`), per-run exec isolation (Task 5 — **accepted-with-documented-risk for SP2, not implemented**: real isolation deferred to SP6; see the Task 5 note); §6 every file has a task; §9 all test bullets mapped (manager unit Task 4–5, prelude Task 3, command Task 7, integration Task 8, automated dual-mode/offscreen-resolution Task 6 Step 5 + manual dual-float smoke Task 10 Step 6); §10 docs (Task 9). **SP1-file edits:** the prelude gets an additive-only progress emit (Task 3, no behavior change) and the SP1 `workflow-command.ts` is refactored (Task 7) to make `run` non-blocking by default (`--wait` preserves the SP1 blocking path) + add `status`/`list`/`stop` — this `run`-default change is the intended SP2 behavior shift, matching §2/§3.
- **Exec isolation (codex re-review, accepted risk):** SP2 reuses the launching `ctx.exec`. The documented API (`agent`/`parallel`/`pipeline`/`phase`/`log`) cannot mutate shell `cwd`/`lastEnv`, but the undocumented internal `__execSpawn` is reachable from user code and CAN (e.g. `__execSpawn(['cd',…])`). This is **out of contract** for SP2 and pre-exists from SP1; real isolation (hide `__execSpawn` or per-run shell) is deferred to SP6. Documented in Task 5 + a `wrapCtx` comment; the guard test covers only the in-contract guarantee.
- **Boy-scout gate (codex re-review):** `host.ts` is on biome's debt list (`biome.json:267`) and SP2 touches it (Tasks 1 + 6) → this PR MUST de-debt `host.ts` and remove its entry (Task 10 Step 3, concrete). No other touched file is listed.
- **Sentinel coupling (the one cross-task subtlety):** Task 6 Step 4 resolves it — the command builds ONE `sentinel`, passes it into both `buildWorkflowCode({sentinel})` (the realm code) and `mgr.start({sentinel})` (used by `splitResult`). Ensure Tasks 4/5 tests pass `sentinel` in `start(...)` and the `WorkflowStartOptions` type carries it (drop `sentinelFor` from deps).
- **Type consistency:** `WorkflowRunState`/`WorkflowStartOptions`/`WorkflowRunManagerDeps`/`WORKFLOW_MANAGER_GLOBAL_KEY` are used identically across Tasks 4–7; `LickEvent` workflow fields (`workflowRunId`/`workflowName`/`resultPath`/`preview`) match between Task 1 (definition) and Task 6 (`deliver`) and Task 1's `formatLickEventForCone`/`defaultLickEventHandler` reads.
- **Stop reality (spec §5):** `kill -KILL <pid>` ends the realm but in-flight `agent()` host-awaits are not cancelled — documented in Task 9; `stop` only guarantees no NEW agents start. Don't over-promise in the status output.
