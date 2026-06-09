# SP3 — Workflow Authoring, Save & Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SLICC workflows ergonomic — teach the cone (via a skill) to write/run workflows, let a good run be saved as a reusable command, auto-discover `*.workflow.js` as shell commands, and complete the `agent()` option set with `thinking`.

**Architecture:** Five mechanical seams, all in the existing webapp shell. (1) The `agent()` prelude gains a one-line `--thinking` pass-through. (2) A new pure `workflow-discovery.ts` scans the saved root and skill `.workflows/` dirs into a name→entry map and builds the bare-command→`workflow run` argv. (3) `ScriptCatalog` gains a `getWorkflowCommands()` cache mirroring its `.jsh` cache. (4) `WasmShellHeadless`'s `.jsh` registration is generalized to register workflow names too, with a **single late-binding handler** that resolves precedence (`built-in > .jsh > saved-workflow`) **at dispatch** against current VFS state — no command-table rebuild (just-bash has no unregister). (5) `workflow save` persists a run's source and triggers a re-sync; `which`/`commands` surface workflows from a separate registry. A bundled `workflows/SKILL.md` is the only "trigger" (skills-over-features).

**Tech Stack:** TypeScript, Vitest (`globals: true`, `environment: node`, `fake-indexeddb/auto`), just-bash (WASM shell), the SP1/SP2 workflow runtime (`workflow-{command,prelude,script}.ts`, `WorkflowRunManager`).

**Spec:** `docs/superpowers/specs/2026-06-08-workflow-authoring-design.md` (read it first — this plan implements it section-by-section).

---

## Orientation (read before Task 1)

Key files and their current roles (verified against the tree at plan time):

- `packages/webapp/src/shell/supplemental-commands/workflow-prelude.ts` — the `WORKFLOW_PRELUDE` string; `agent(prompt, opts)` builds `flags` then `argv`. Currently forwards `--model` + `--schema-b64`; drops `thinking`.
- `packages/webapp/src/shell/supplemental-commands/workflow-command.ts` — the `workflow` command. Subcommand dispatch is at the top of the handler (`if (args[0] === 'list' || 'status' || 'stop') return runSubcommand(...)`). `parse()` rejects unknown subcommands. `getRunManager()` resolves the manager from `globalThis[WORKFLOW_MANAGER_GLOBAL_KEY]`. `createWorkflowCommand({ getParentJid })` is the factory. `parseMetaBanner`, `makeSentinel`, `buildWorkflowCode` are imported from `workflow-script.ts`.
- `packages/webapp/src/shell/jsh-discovery.ts` — `discoverJshCommands(fs)` scans for `.jsh`, basename-minus-ext, first-wins. **Mirror this for workflows.**
- `packages/webapp/src/shell/script-catalog.ts` — caches `.jsh`/`.bsh` discovery behind an `FsWatcher`. `getJshCommands()` + the `loadJshCommands()` cache/inflight/generation pattern are what `getWorkflowCommands()` mirrors. The constructor's `watcher.watch('/', () => true, () => this.invalidateJsh())` already fires on ALL path changes.
- `packages/webapp/src/shell/wasm-shell-headless.ts` — owns bare-command registration. `doSyncJshCommands()` (the `Command` whose `execute` re-reads `catalog.getJshCommands()` per call, returns 127 if gone) is the **late-binding idiom** SP3 extends. The guard `if (this.builtinCommandNames.has(name) && !this.registeredJshCommands.has(name)) continue;` protects built-ins. Registered names are added to `builtinCommandNames`. The script watcher predicate `(path) => path.endsWith('.jsh')` (in the constructor) triggers `syncJshCommands()`. `createSupplementalCommands({ getJshCommands: () => this.getJshCommandNames(), getParentJid, ... })` is the wiring point for new callbacks.
- `packages/webapp/src/shell/supplemental-commands/index.ts` — `SupplementalCommandsConfig` (has `getJshCommands?`, `getParentJid?`); `createSupplementalCommands` constructs every command, including `createWorkflowCommand({ getParentJid })`, `createCommandsCommand({ getJshCommands })`, `createWhichCommand({ fs, scriptCatalog })`.
- `packages/webapp/src/shell/supplemental-commands/which-command.ts` / `help-command.ts` — list/resolve `.jsh` commands. `which` resolves any name in `getRegisteredCommands()` to `/usr/bin/<name>` **before** checking scripts (so a workflow registered into `builtinCommandNames` would mislabel — Task 6 fixes this).
- `packages/webapp/src/scoops/workflow-run-manager.ts` — `WorkflowRunState.source` holds the verbatim script; `getRun(id)` returns `Readonly<WorkflowRunState> | null`; `WORKFLOW_MANAGER_GLOBAL_KEY` is the global key. `--wait` runs **never** reach the manager (no `runId` → unsaveable).
- `packages/webapp/src/skills/install-from-drop.ts` — `VALID_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/`.
- `packages/webapp/src/scoops/scoop-context.ts` — loads `/workspace/skills/*` into every scoop's system prompt (zero code needed to make `workflows/SKILL.md` a trigger).

Test idiom (from `tests/shell/supplemental-commands/workflow-command.test.ts` and `workflow-prelude.test.ts`): `import 'fake-indexeddb/auto'`; `VirtualFS.create({ dbName: \`x-${Math.random()}\`, wipe: true })`; build a `ctx`with`VfsAdapter`; for prelude argv, run the prelude string in an `AsyncFn`with a fake`exec.spawn`recording`calls`.

Run a single test file with: `npm test -w @slicc/webapp -- <path> --run`. Lint before every commit: `npm run lint`.

---

## Task 1: `agent()` thinking option (prelude)

**Files:**

- Modify: `packages/webapp/src/shell/supplemental-commands/workflow-prelude.ts` (the `agent()` flag-building + the JSDoc above it)
- Test: `packages/webapp/tests/shell/supplemental-commands/workflow-prelude.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these two `it` blocks inside the `describe('workflow-prelude', …)` in `workflow-prelude.test.ts` (use the existing `run` / `WF` helpers already in that file):

```ts
it('agent({thinking}) adds --thinking <level>', async () => {
  const calls: string[][] = [];
  const exec = {
    spawn: async (a: string[]) => {
      calls.push(a);
      return { stdout: 'ok\n', stderr: '', exitCode: 0 };
    },
  };
  await run('globalThis.__t = await agent("q",{thinking:"high"});', exec, WF);
  const i = calls[0].indexOf('--thinking');
  expect(i).toBeGreaterThan(-1);
  expect(calls[0][i + 1]).toBe('high');
});

it('agent() without thinking omits --thinking', async () => {
  const calls: string[][] = [];
  const exec = {
    spawn: async (a: string[]) => {
      calls.push(a);
      return { stdout: 'ok\n', stderr: '', exitCode: 0 };
    },
  };
  await run('globalThis.__t = await agent("q");', exec, WF);
  expect(calls[0]).not.toContain('--thinking');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @slicc/webapp -- tests/shell/supplemental-commands/workflow-prelude.test.ts --run`
Expected: FAIL — the `--thinking high` test fails (`indexOf` returns `-1`).

- [ ] **Step 3: Add the pass-through**

In `workflow-prelude.ts`, inside `async function agent(prompt, opts)`, after the `--schema-b64` line, add the `--thinking` line:

```js
const flags = [];
if (opts.model) flags.push('--model', String(opts.model));
if (opts.thinking) flags.push('--thinking', String(opts.thinking));
if (opts.schema) flags.push('--schema-b64', __b64(JSON.stringify(opts.schema)));
```

(Order relative to `--schema-b64` is irrelevant — the `agent` command parses flags positionally before the trailing `--read-only … *  <prompt>`.)

- [ ] **Step 4: Update the JSDoc**

Replace the comment block at the top of `agent()` (the lines describing `opts.phase`/`opts.label`) with:

```js
opts = opts || {};
// Recognized opts: model (→ --model), thinking (→ --thinking <level>: off|minimal|low|medium|
// high|xhigh; invalid is the agent command's own error → failed subagent → null), schema (→ a
// StructuredOutput contract; result is JSON-parsed). phase/label are ACCEPTED but display-only
// (SP4 progress grouping). isolation/agentType: SP6.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @slicc/webapp -- tests/shell/supplemental-commands/workflow-prelude.test.ts --run`
Expected: PASS (all prelude tests, including the two new ones).

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add packages/webapp/src/shell/supplemental-commands/workflow-prelude.ts packages/webapp/tests/shell/supplemental-commands/workflow-prelude.test.ts
git commit -m "feat(workflow): forward agent() thinking option to --thinking

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Workflow discovery + bare-command argv (pure)

Creates the pure SP3 command-construction helpers: scan saved + skill roots into a name→entry map (skill workflows always `<skill>:<name>`), and coerce a bare-command invocation into a `workflow run` argv.

**Files:**

- Create: `packages/webapp/src/shell/workflow-discovery.ts`
- Test: `packages/webapp/tests/shell/workflow-discovery.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/webapp/tests/shell/workflow-discovery.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../src/fs/index.js';
import {
  buildWorkflowRunArgv,
  discoverWorkflowCommands,
} from '../../src/shell/workflow-discovery.js';

async function fsWith(files: Record<string, string>): Promise<VirtualFS> {
  const fs = await VirtualFS.create({ dbName: `wfd-${Math.random()}`, wipe: true });
  for (const [path, content] of Object.entries(files)) {
    await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(path, content);
  }
  return fs;
}

describe('discoverWorkflowCommands', () => {
  it('discovers a saved workflow as a bare command name', async () => {
    const fs = await fsWith({ '/workspace/.workflows/weekly-audit.workflow.js': 'return 1' });
    const map = await discoverWorkflowCommands(fs);
    expect(map.get('weekly-audit')).toEqual({
      path: '/workspace/.workflows/weekly-audit.workflow.js',
      kind: 'saved',
    });
  });

  it('discovers a skill workflow as <skill>:<name>', async () => {
    const fs = await fsWith({
      '/workspace/skills/triage/.workflows/sweep.workflow.js': 'return 1',
    });
    const map = await discoverWorkflowCommands(fs);
    expect(map.get('triage:sweep')).toEqual({
      path: '/workspace/skills/triage/.workflows/sweep.workflow.js',
      kind: 'skill',
      skill: 'triage',
    });
    expect(map.has('sweep')).toBe(false); // never bare
  });

  it('skips a skill dir whose name has a reserved char', async () => {
    const fs = await fsWith({ '/workspace/skills/bad:name/.workflows/x.workflow.js': 'return 1' });
    const map = await discoverWorkflowCommands(fs);
    expect(map.size).toBe(0);
  });

  it('ignores non-.workflow.js files', async () => {
    const fs = await fsWith({ '/workspace/.workflows/notes.md': 'hi' });
    const map = await discoverWorkflowCommands(fs);
    expect(map.size).toBe(0);
  });
});

describe('buildWorkflowRunArgv', () => {
  const P = '/workspace/.workflows/w.workflow.js';
  it('no args → workflow run <path>', () => {
    expect(buildWorkflowRunArgv(P, [])).toEqual(['workflow', 'run', P]);
  });
  it('single JSON-valid arg → --args verbatim', () => {
    expect(buildWorkflowRunArgv(P, ['123'])).toEqual(['workflow', 'run', P, '--args', '123']);
    expect(buildWorkflowRunArgv(P, ['{"a":1}'])).toEqual([
      'workflow',
      'run',
      P,
      '--args',
      '{"a":1}',
    ]);
  });
  it('single non-JSON arg → JSON-stringified string', () => {
    expect(buildWorkflowRunArgv(P, ['abc'])).toEqual(['workflow', 'run', P, '--args', '"abc"']);
  });
  it('multiple args → JSON string array', () => {
    expect(buildWorkflowRunArgv(P, ['a', 'b'])).toEqual([
      'workflow',
      'run',
      P,
      '--args',
      '["a","b"]',
    ]);
  });
  it('extracts --wait and passes it through', () => {
    expect(buildWorkflowRunArgv(P, ['--wait', '123'])).toEqual([
      'workflow',
      'run',
      P,
      '--wait',
      '--args',
      '123',
    ]);
  });
  it('-- forces the rest as literal positionals', () => {
    expect(buildWorkflowRunArgv(P, ['--', '--wait'])).toEqual([
      'workflow',
      'run',
      P,
      '--args',
      '"--wait"',
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @slicc/webapp -- tests/shell/workflow-discovery.test.ts --run`
Expected: FAIL — module `workflow-discovery.js` does not exist.

- [ ] **Step 3: Implement the module**

Create `packages/webapp/src/shell/workflow-discovery.ts`:

```ts
/**
 * Workflow discovery — scan VirtualFS for `*.workflow.js` files and build a map of
 * command name → entry. Saved workflows (`/workspace/.workflows/`) get the bare stem;
 * skill-bundled workflows (`/workspace/skills/<skill>/.workflows/`) get `<skill>:<stem>`
 * (collision-free — `:` is outside the skill/workflow name charset). Skill segments are
 * validated against VALID_SKILL_NAME and skipped (with a warning) when they contain a
 * reserved char, so a raw directory name can never break the `<skill>:<name>` contract.
 *
 * Mirrors jsh-discovery.ts (first occurrence of a name wins). Naming model + precedence
 * are specified in docs/superpowers/specs/2026-06-08-workflow-authoring-design.md §3.
 */

import { createLogger } from '../core/logger.js';
import type { JshDiscoveryFS } from './jsh-discovery.js';

const log = createLogger('workflow-discovery');

const SAVED_ROOT = '/workspace/.workflows';
const SKILLS_ROOT = '/workspace/skills';
const SUFFIX = '.workflow.js';
// Same charset install-from-drop.ts enforces for skill dirs; a `:` (or other reserved
// char) would break the `<skill>:<name>` namespace, so such dirs are skipped.
const VALID_SKILL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface WorkflowCommandEntry {
  path: string;
  kind: 'saved' | 'skill';
  skill?: string;
}

/** Discover every `*.workflow.js` and return command name → entry. First wins. */
export async function discoverWorkflowCommands(
  fs: JshDiscoveryFS
): Promise<Map<string, WorkflowCommandEntry>> {
  const out = new Map<string, WorkflowCommandEntry>();

  // Saved workflows → bare names.
  if (await fs.exists(SAVED_ROOT)) {
    for await (const path of fs.walk(SAVED_ROOT)) {
      if (!path.endsWith(SUFFIX)) continue;
      const name = stem(path);
      if (name && !out.has(name)) out.set(name, { path, kind: 'saved' });
    }
  }

  // Skill-bundled workflows → `<skill>:<name>` (always namespaced).
  if (await fs.exists(SKILLS_ROOT)) {
    for await (const path of fs.walk(SKILLS_ROOT)) {
      if (!path.endsWith(SUFFIX)) continue;
      const skill = skillSegment(path);
      if (!skill) continue;
      if (!VALID_SKILL_SEGMENT.test(skill)) {
        log.warn(`skipping workflow under invalid skill dir name: ${skill} (${path})`);
        continue;
      }
      const name = `${skill}:${stem(path)}`;
      if (!out.has(name)) out.set(name, { path, kind: 'skill', skill });
    }
  }

  return out;
}

/** `/a/b/foo.workflow.js` → `foo` (basename minus the `.workflow.js` suffix). */
function stem(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.endsWith(SUFFIX) ? base.slice(0, -SUFFIX.length) : base;
}

/** For `/workspace/skills/<skill>/.workflows/x.workflow.js` → `<skill>`; else `null`. */
function skillSegment(path: string): string | null {
  const rest = path.slice(SKILLS_ROOT.length + 1); // strip "/workspace/skills/"
  const slash = rest.indexOf('/');
  return slash > 0 ? rest.slice(0, slash) : null;
}

/**
 * Coerce a bare workflow-command invocation (`<name> [args…]`) into a `workflow run`
 * argv. Arg coercion is intentionally MORE LENIENT than `workflow run --args` (which is
 * strict JSON): a single arg is passed verbatim when it parses as JSON, else JSON-string-
 * wrapped; multiple args → a JSON string array; none → no `--args`. `--wait` is lifted to
 * a `workflow run` flag; `--` forces the remainder to be treated as literal positionals.
 */
export function buildWorkflowRunArgv(path: string, rawArgs: string[]): string[] {
  let wait = false;
  const positionals: string[] = [];
  let literal = false;
  for (const a of rawArgs) {
    if (literal) {
      positionals.push(a);
      continue;
    }
    if (a === '--') {
      literal = true;
      continue;
    }
    if (a === '--wait') {
      wait = true;
      continue;
    }
    positionals.push(a);
  }

  const argv = ['workflow', 'run', path];
  if (wait) argv.push('--wait');

  if (positionals.length === 1) {
    argv.push('--args', asJsonArg(positionals[0]));
  } else if (positionals.length > 1) {
    argv.push('--args', JSON.stringify(positionals));
  }
  return argv;
}

/** A single token: pass through if it parses as JSON, else JSON-stringify it as a string. */
function asJsonArg(token: string): string {
  try {
    JSON.parse(token);
    return token;
  } catch {
    return JSON.stringify(token);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @slicc/webapp -- tests/shell/workflow-discovery.test.ts --run`
Expected: PASS (all 10 cases).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add packages/webapp/src/shell/workflow-discovery.ts packages/webapp/tests/shell/workflow-discovery.test.ts
git commit -m "feat(workflow): add workflow-discovery (scan + bare-command argv)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `ScriptCatalog.getWorkflowCommands()`

Adds a workflow cache to `ScriptCatalog` mirroring its `.jsh` cache, invalidated by the same `/` watcher.

**Files:**

- Modify: `packages/webapp/src/shell/script-catalog.ts`
- Test: `packages/webapp/tests/shell/script-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/shell/script-catalog.test.ts` (mirror the existing jsh-discovery test setup in that file — it constructs a `ScriptCatalog` over a `VirtualFS`-backed `jshFs`). Add:

```ts
it('getWorkflowCommands discovers saved + skill workflows', async () => {
  const fs = await VirtualFS.create({ dbName: `cat-wf-${Math.random()}`, wipe: true });
  await fs.mkdir('/workspace/.workflows', { recursive: true });
  await fs.writeFile('/workspace/.workflows/audit.workflow.js', 'return 1');
  await fs.mkdir('/workspace/skills/triage/.workflows', { recursive: true });
  await fs.writeFile('/workspace/skills/triage/.workflows/sweep.workflow.js', 'return 1');
  const catalog = new ScriptCatalog({ jshFs: fs });
  const map = await catalog.getWorkflowCommands();
  expect(map.get('audit')?.kind).toBe('saved');
  expect(map.get('triage:sweep')?.kind).toBe('skill');
});
```

(If the test file's imports don't already include `ScriptCatalog` and `VirtualFS`, add them: `import { ScriptCatalog } from '../../src/shell/script-catalog.js';` and `import { VirtualFS } from '../../src/fs/index.js';` plus `import 'fake-indexeddb/auto';`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @slicc/webapp -- tests/shell/script-catalog.test.ts --run`
Expected: FAIL — `catalog.getWorkflowCommands is not a function`.

- [ ] **Step 3: Implement `getWorkflowCommands` (mirror the jsh cache)**

In `script-catalog.ts`:

1. Add the import and a clone helper near the top:

```ts
import { discoverWorkflowCommands, type WorkflowCommandEntry } from './workflow-discovery.js';
```

```ts
function cloneWorkflowCommands(
  commands: Map<string, WorkflowCommandEntry>
): Map<string, WorkflowCommandEntry> {
  return new Map([...commands].map(([k, v]) => [k, { ...v }]));
}
```

2. Add fields alongside `jshCache`/`jshInflight`/`jshGeneration`:

```ts
  private workflowCache: Map<string, WorkflowCommandEntry> | null = null;
  private workflowInflight: Promise<Map<string, WorkflowCommandEntry>> | null = null;
  private workflowGeneration = 0;
```

3. In the constructor's `/` watcher callback, also invalidate workflows. Change the existing watch:

```ts
this.watcherUnsubs.push(
  this.watcher.watch(
    '/',
    () => true,
    () => {
      this.invalidateJsh();
      this.invalidateWorkflows();
    }
  )
);
```

4. Add `invalidateWorkflows()` and extend `invalidateAll()`:

```ts
  invalidateWorkflows(): void {
    this.workflowGeneration++;
    this.workflowCache = null;
    this.workflowInflight = null;
  }
```

In `invalidateAll()` add `this.invalidateWorkflows();`.

5. Add the public getter + private loader (mirror `getJshCommands`/`loadJshCommands`; reuse `shouldCacheJsh()` since both depend on the same watcher + mount state):

```ts
  async getWorkflowCommands(): Promise<Map<string, WorkflowCommandEntry>> {
    const commands = await this.loadWorkflowCommands();
    return cloneWorkflowCommands(commands);
  }

  private async loadWorkflowCommands(): Promise<Map<string, WorkflowCommandEntry>> {
    const shouldCache = this.shouldCacheJsh();
    if (shouldCache && this.workflowCache) return this.workflowCache;

    if (!this.workflowInflight) {
      const generation = this.workflowGeneration;
      const inflight = discoverWorkflowCommands(this.jshFs)
        .then((commands) => {
          const cloned = cloneWorkflowCommands(commands);
          if (shouldCache && this.workflowGeneration === generation) {
            this.workflowCache = cloned;
          }
          return cloned;
        })
        .finally(() => {
          if (this.workflowInflight === inflight) {
            this.workflowInflight = null;
          }
        });
      this.workflowInflight = inflight;
    }

    return this.workflowInflight;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @slicc/webapp -- tests/shell/script-catalog.test.ts --run`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add packages/webapp/src/shell/script-catalog.ts packages/webapp/tests/shell/script-catalog.test.ts
git commit -m "feat(workflow): ScriptCatalog.getWorkflowCommands cache

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Registration + dispatch-time precedence (WasmShellHeadless)

Generalizes the `.jsh` sync to register workflow names too, with a **single late-binding handler** per name that resolves `built-in > .jsh > saved-workflow` at dispatch — no table rebuild (just-bash has no unregister; the existing `.jsh` handler already re-resolves at dispatch).

**Files:**

- Modify: `packages/webapp/src/shell/wasm-shell-headless.ts`
- Test: `packages/webapp/tests/shell/wasm-shell.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `tests/shell/wasm-shell.test.ts`. The construction idiom (already used throughout that file) is `new WasmShell({ fs })` → `await shell.syncJshCommands()` → `await shell.executeCommand('…')` → `{ exitCode, stdout, stderr }`. Add `WORKFLOW_MANAGER_GLOBAL_KEY` to the imports (`import { WORKFLOW_MANAGER_GLOBAL_KEY } from '../../src/scoops/workflow-run-manager.js';`) and a local fake-manager installer:

```ts
function installFakeWfManager(): void {
  (globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY] = {
    start: async () => ({ runId: 'r1' }),
    getRun: () => null,
    listRuns: () => [],
    observeRun: () => () => {},
  };
}

describe('WasmShell workflow command registration', () => {
  let fs: VirtualFS;
  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-wf-reg-${Math.random()}`, wipe: true });
  });
  afterEach(async () => {
    delete (globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY];
    await fs.dispose();
  });

  it('registers a saved workflow as a bare command that runs non-blocking', async () => {
    installFakeWfManager();
    await fs.mkdir('/workspace/.workflows', { recursive: true });
    await fs.writeFile(
      '/workspace/.workflows/audit.workflow.js',
      "export const meta = { name: 'audit' };\nreturn 1"
    );
    const shell = new WasmShell({ fs });
    await shell.syncJshCommands();
    const res = await shell.executeCommand('audit');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/started/i); // "▶ workflow 'audit' started (run r1)"
  });

  it('a skill workflow is reachable as <skill>:<name>', async () => {
    installFakeWfManager();
    await fs.mkdir('/workspace/skills/triage/.workflows', { recursive: true });
    await fs.writeFile(
      '/workspace/skills/triage/.workflows/sweep.workflow.js',
      "export const meta = { name: 'sweep' };\nreturn 1"
    );
    const shell = new WasmShell({ fs });
    await shell.syncJshCommands();
    const res = await shell.executeCommand('triage:sweep');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/started/i);
  });

  it('a .jsh wins the bare name over a saved workflow (precedence at dispatch)', async () => {
    installFakeWfManager();
    await fs.mkdir('/workspace/.workflows', { recursive: true });
    await fs.writeFile(
      '/workspace/.workflows/foo.workflow.js',
      "export const meta={name:'foo'};\nreturn 1"
    );
    await fs.writeFile('/workspace/foo.jsh', "console.log('JSH-WON');");
    const shell = new WasmShell({ fs });
    await shell.syncJshCommands();
    const res = await shell.executeCommand('foo');
    expect(res.stdout).toContain('JSH-WON'); // .jsh wins; workflow shadowed
  });

  it('deleting the .jsh falls back to the workflow at dispatch (no re-register)', async () => {
    installFakeWfManager();
    await fs.mkdir('/workspace/.workflows', { recursive: true });
    await fs.writeFile(
      '/workspace/.workflows/foo.workflow.js',
      "export const meta={name:'foo'};\nreturn 1"
    );
    await fs.writeFile('/workspace/foo.jsh', "console.log('JSH-WON');");
    const shell = new WasmShell({ fs });
    await shell.syncJshCommands();
    await fs.unlink('/workspace/foo.jsh');
    // Do NOT call syncJshCommands again — the handler re-resolves at dispatch.
    const res = await shell.executeCommand('foo');
    expect(res.stdout).toMatch(/started/i); // now runs the workflow
  });
});
```

> Implementer note: `new WasmShell({ fs })` over a bare `VirtualFS` does not attach an `FsWatcher`, so `ScriptCatalog` does not cache `.jsh`/workflow discovery — every dispatch re-scans live, which is exactly what makes the deletion-fallback test deterministic. If you instead construct with a watcher, call `shell.syncJshCommands()` after the `unlink` is unnecessary (the handler reads live state), but you may need the catalog's invalidation to have fired; prefer the no-watcher construction shown above for these tests. `beforeEach`/`afterEach`/`vi` are already imported at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @slicc/webapp -- tests/shell/wasm-shell.test.ts --run`
Expected: FAIL — `audit` / `triage:sweep` are not commands (127), the precedence/fallback tests fail.

- [ ] **Step 3: Extend the watcher predicate**

In the `wasm-shell-headless.ts` constructor, change the script watcher predicate to also fire on workflow files:

```ts
if (scriptWatcher) {
  scriptWatcher.watch(
    '/',
    (path) => path.endsWith('.jsh') || path.endsWith('.workflow.js'),
    () => {
      void this.syncJshCommands().catch(() => undefined);
    }
  );
}
```

- [ ] **Step 4: Add a workflow-name registry field + filtered getters**

Add the field next to `registeredJshCommands`:

```ts
  /** Workflow command names we've registered (handler is dynamic, so a Set suffices). */
  protected registeredWorkflowCommands = new Set<string>();
```

Add to the top-of-file imports:

```ts
import { buildWorkflowRunArgv, type WorkflowCommandEntry } from './workflow-discovery.js';
```

Add getters near `getFilteredJshCommands()`:

```ts
  private async getFilteredWorkflowCommands(): Promise<Map<string, WorkflowCommandEntry>> {
    const all = await this.scriptCatalog.getWorkflowCommands();
    const filtered = new Map<string, WorkflowCommandEntry>();
    for (const [name, entry] of all) {
      if (!this.isCommandAllowed(name)) continue;
      filtered.set(name, entry);
    }
    return filtered;
  }

  async getWorkflowCommandNames(): Promise<string[]> {
    return [...(await this.getFilteredWorkflowCommands()).keys()];
  }
```

- [ ] **Step 5: Generalize the sync to register workflow names with a unified late-binding handler**

In `doSyncJshCommands()`, factor the per-name handler into a method and register the union of jsh + workflow names. Replace the body of `doSyncJshCommands()` with:

```ts
  private async doSyncJshCommands(): Promise<void> {
    try {
      const jshMap = await this.scriptCatalog.getJshCommands();
      const wfMap = await this.getFilteredWorkflowCommands();

      // .jsh names: keep the existing path-keyed registry + guard.
      for (const [name, scriptPath] of jshMap) {
        if (!this.isCommandAllowed(name)) continue;
        if (this.builtinCommandNames.has(name) && !this.registeredJshCommands.has(name)) continue;
        if (this.registeredJshCommands.get(name) === scriptPath) continue;
        this.bash.registerCommand(this.wrapCommandForSudo(this.makeScriptCommand(name)));
        this.registeredJshCommands.set(name, scriptPath);
        this.builtinCommandNames.add(name);
      }

      // Workflow names: register the SAME unified handler ONCE per name (it resolves
      // .jsh-vs-workflow at dispatch, so the order between the two loops is irrelevant).
      for (const name of wfMap.keys()) {
        if (this.registeredWorkflowCommands.has(name)) continue; // already handled
        if (this.registeredJshCommands.has(name)) {
          // A .jsh already installed the unified handler for this name; it already resolves
          // the workflow fallback at dispatch. Just record it so we don't reconsider.
          this.registeredWorkflowCommands.add(name);
          continue;
        }
        if (this.builtinCommandNames.has(name)) continue; // never override a real built-in
        this.bash.registerCommand(this.wrapCommandForSudo(this.makeScriptCommand(name)));
        this.registeredWorkflowCommands.add(name);
        this.builtinCommandNames.add(name);
      }
    } finally {
      this.jshSyncInflight = null;
      if (this.jshSyncDirty) {
        this.jshSyncDirty = false;
        void this.syncJshCommands().catch(() => undefined);
      }
    }
  }
```

Then add the unified handler method (it is the old `.jsh` `execute`, plus a workflow-fallback branch before the 127):

```ts
  /**
   * One late-binding handler per script-command name. Resolves precedence at DISPATCH
   * against current VFS state: built-in > .jsh > saved-workflow. (just-bash has no
   * unregister, so we never rebuild the table — the handler reads live discovery each call.)
   */
  private makeScriptCommand(name: string): Command {
    const catalog = this.scriptCatalog;
    const shell = this;
    const discoveryFs = this.options.jshDiscoveryFs ?? this.options.fs;
    const cmdName = name;
    return {
      name,
      trusted: true,
      async execute(args: string[], ctx) {
        const execFn: typeof ctx.exec =
          ctx.exec ??
          ((cmd, opts) =>
            shell.bash.exec(cmd, { env: Object.fromEntries(ctx.env), cwd: opts?.cwd ?? ctx.cwd }));

        // 1) .jsh wins the bare name.
        const jshMap = await catalog.getJshCommands();
        const jshPath = jshMap.get(cmdName);
        if (jshPath) {
          let code: string;
          try {
            const raw = await discoveryFs.readFile(jshPath, { encoding: 'utf-8' });
            code = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
          } catch {
            return { stdout: '', stderr: `jsh: cannot read script '${jshPath}'\n`, exitCode: 127 };
          }
          return executeJsCode(
            code,
            ['node', jshPath, ...args],
            { fs: ctx.fs, cwd: ctx.cwd, env: ctx.env, stdin: ctx.stdin, exec: execFn },
            shell.buildJshProcessConfig()
          );
        }

        // 2) Else a workflow (saved bare or skill <skill>:<name>) — route through the
        //    `workflow run` command path (NOT executeJsCode on the raw file).
        const wfMap = await catalog.getWorkflowCommands();
        const wf = wfMap.get(cmdName);
        if (wf) {
          const argv = buildWorkflowRunArgv(wf.path, args);
          return execFn(argv[0], { args: argv.slice(1), cwd: ctx.cwd });
        }

        // 3) Gone.
        return { stdout: '', stderr: `${cmdName}: command no longer exists\n`, exitCode: 127 };
      },
    };
  }
```

> Implementer note: this REPLACES the inline `const command: Command = { … }` that used to live in `doSyncJshCommands`. The jsh execution branch is byte-for-byte the old behavior; the only additions are the workflow-fallback branch and that it's now a named method registered from both loops.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w @slicc/webapp -- tests/shell/wasm-shell.test.ts --run`
Expected: PASS (the 4 new tests + all pre-existing `.jsh` tests still green — the jsh path is unchanged behavior).

- [ ] **Step 7: Run the broader shell suite (no regressions)**

Run: `npm test -w @slicc/webapp -- tests/shell --run`
Expected: PASS.

- [ ] **Step 8: Lint and commit**

```bash
npm run lint
git add packages/webapp/src/shell/wasm-shell-headless.ts packages/webapp/tests/shell/wasm-shell.test.ts
git commit -m "feat(workflow): register *.workflow.js as commands with dispatch-time precedence

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `workflow save` subcommand + sync plumbing

**Files:**

- Modify: `packages/webapp/src/shell/supplemental-commands/workflow-command.ts`
- Modify: `packages/webapp/src/shell/supplemental-commands/index.ts` (add `syncScriptCommands` to config + thread into `createWorkflowCommand`)
- Modify: `packages/webapp/src/shell/wasm-shell-headless.ts` (pass `syncScriptCommands` into `createSupplementalCommands`)
- Test: `packages/webapp/tests/shell/supplemental-commands/workflow-command.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `workflow-command.test.ts` (reuse `installFakeManager`, `ctxWith`):

```ts
describe('workflow save', () => {
  it('persists the run source and triggers a sync', async () => {
    const mgr = installFakeManager();
    mgr.getRun = (id: string) =>
      id === 'r1' ? ({ id, source: "export const meta={name:'audit'}\nreturn 1" } as any) : null;
    const fs = await VirtualFS.create({ dbName: `wf-save-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    let synced = 0;
    const cmd = createWorkflowCommand({ syncScriptCommands: async () => void synced++ });
    const res = await cmd.execute(
      ['save', 'r1', 'audit'],
      await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    );
    expect(res.exitCode).toBe(0);
    expect(await fs.readFile('/workspace/.workflows/audit.workflow.js')).toContain("name:'audit'");
    expect(synced).toBe(1);
  });

  it('rejects a name already taken by an existing command', async () => {
    const mgr = installFakeManager();
    mgr.getRun = (id: string) => ({ id, source: "export const meta={name:'x'}\nreturn 1" }) as any;
    const fs = await VirtualFS.create({ dbName: `wf-save2-${Math.random()}`, wipe: true });
    const ctx = await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    (ctx as any).getRegisteredCommands = () => ['ls', 'git'];
    const res = await createWorkflowCommand().execute(['save', 'r1', 'ls'], ctx);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/already a command|taken/i);
  });

  it('errors for a --wait (unmanaged) run id', async () => {
    installFakeManager(); // getRun returns null for unknown ids
    const fs = await VirtualFS.create({ dbName: `wf-save3-${Math.random()}`, wipe: true });
    const res = await createWorkflowCommand().execute(
      ['save', 'nope', 'audit'],
      await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/no run|no such run/i);
  });

  it('refuses to overwrite without --force, allows with --force', async () => {
    const mgr = installFakeManager();
    mgr.getRun = (id: string) =>
      ({ id, source: "export const meta={name:'audit'}\nreturn 2" }) as any;
    const fs = await VirtualFS.create({ dbName: `wf-save4-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace/.workflows', { recursive: true });
    await fs.writeFile('/workspace/.workflows/audit.workflow.js', 'old');
    const ctx = await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const r1 = await createWorkflowCommand().execute(['save', 'r1', 'audit'], ctx);
    expect(r1.exitCode).toBe(1);
    const r2 = await createWorkflowCommand().execute(['save', 'r1', 'audit', '--force'], ctx);
    expect(r2.exitCode).toBe(0);
    expect(await fs.readFile('/workspace/.workflows/audit.workflow.js')).toContain('return 2');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @slicc/webapp -- tests/shell/supplemental-commands/workflow-command.test.ts --run`
Expected: FAIL — `save` is an unknown subcommand.

- [ ] **Step 3: Add the `save` dispatch + factory option**

In `workflow-command.ts`, change the factory signature and the dispatch:

```ts
export function createWorkflowCommand(
  options: {
    getParentJid?: () => string | undefined;
    syncScriptCommands?: () => void | Promise<void>;
  } = {}
): Command {
  return defineCommand('workflow', async (args, ctx) => {
    if (args[0] === 'list' || args[0] === 'status' || args[0] === 'stop')
      return runSubcommand(args, ctx);
    if (args[0] === 'save') return runSave(args, ctx, options);

    const p = parse(args);
    // … unchanged …
```

- [ ] **Step 4: Implement `runSave`**

Add a `SAVE_NAME` validator and the function (place near `runSubcommand`):

```ts
const SAVE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SAVED_WORKFLOWS_DIR = '/workspace/.workflows';

// `workflow save <runId> <name> [--force]` — persist a backgrounded run's source as a
// reusable bare command. Reject-at-save on name collision (built-in / existing command).
// --wait runs bypass the manager (no runId) → "no run". See spec §Save.
async function runSave(
  args: string[],
  ctx: CommandContext,
  options: { syncScriptCommands?: () => void | Promise<void> }
): Promise<ExecResult> {
  const rest = args.slice(1).filter((a) => a !== '--force');
  const force = args.includes('--force');
  const [runId, name] = rest;
  if (!runId || !name)
    return { stdout: '', stderr: 'usage: workflow save <runId> <name> [--force]\n', exitCode: 1 };
  if (!SAVE_NAME.test(name))
    return {
      stdout: '',
      stderr: `workflow: invalid name '${name}' (use [a-z0-9][a-z0-9-]*)\n`,
      exitCode: 1,
    };

  // Reject-at-save: don't shadow a built-in / existing command (the dispatch-time precedence
  // would otherwise let a .jsh/built-in keep the bare name and silently shadow this workflow).
  const existing = new Set(ctx.getRegisteredCommands?.() ?? []);
  if (existing.has(name))
    return {
      stdout: '',
      stderr: `workflow: '${name}' is already a command — choose another name\n`,
      exitCode: 1,
    };

  const mgr = getRunManager();
  const run = mgr?.getRun(runId);
  if (!run)
    return {
      stdout: '',
      stderr: `workflow: no run '${runId}' (only backgrounded runs are saveable; --wait runs are not)\n`,
      exitCode: 1,
    };
  if (!run.source)
    return { stdout: '', stderr: `workflow: run '${runId}' has no source to save\n`, exitCode: 1 };

  const path = `${SAVED_WORKFLOWS_DIR}/${name}.workflow.js`;
  if (!force && (await ctx.fs.exists(path)))
    return {
      stdout: '',
      stderr: `workflow: ${path} already exists (pass --force to overwrite)\n`,
      exitCode: 1,
    };

  await ctx.fs.mkdir(SAVED_WORKFLOWS_DIR, { recursive: true });
  await ctx.fs.writeFile(path, run.source);
  await options.syncScriptCommands?.();

  return { stdout: `saved workflow '${name}' → ${path} (run: ${name})\n`, stderr: '', exitCode: 0 };
}
```

- [ ] **Step 5: Thread `syncScriptCommands` through the config**

In `index.ts`:

1. Add to `SupplementalCommandsConfig`:

```ts
  /** Re-run script-command registration (jsh + workflows) after a `workflow save`. */
  syncScriptCommands?: () => void | Promise<void>;
```

2. Update the `createWorkflowCommand` call site:

```ts
    createWorkflowCommand({
      getParentJid: options.getParentJid,
      syncScriptCommands: options.syncScriptCommands,
    }),
```

In `wasm-shell-headless.ts`, in the `createSupplementalCommands({ … })` call, add:

```ts
      getJshCommands: () => this.getJshCommandNames(),
      getWorkflowCommands: () => this.getWorkflowCommandNames(),
      syncScriptCommands: () => this.syncJshCommands(),
```

(`getWorkflowCommands` here is consumed by Task 6's `commands`/`which`; `syncJshCommands` is the unified sync from Task 4.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w @slicc/webapp -- tests/shell/supplemental-commands/workflow-command.test.ts --run`
Expected: PASS (4 new `save` tests + all pre-existing `workflow run` tests).

- [ ] **Step 7: Update the command's HELP text**

In `workflow-command.ts`, extend the `HELP` constant with the `save` line:

```
       workflow save <runId> <name> [--force]
```

- [ ] **Step 8: Lint and commit**

```bash
npm run lint
git add packages/webapp/src/shell/supplemental-commands/workflow-command.ts packages/webapp/src/shell/supplemental-commands/index.ts packages/webapp/src/shell/wasm-shell-headless.ts packages/webapp/tests/shell/supplemental-commands/workflow-command.test.ts
git commit -m "feat(workflow): workflow save subcommand + sync plumbing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `which` / `commands` visibility

Surface workflows from the discovery map (a separate registry), with correct precedence labeling — without mislabeling a workflow registered into `builtinCommandNames` as a plain `/usr/bin` built-in.

**Files:**

- Modify: `packages/webapp/src/shell/supplemental-commands/which-command.ts`
- Modify: `packages/webapp/src/shell/supplemental-commands/help-command.ts`
- Modify: `packages/webapp/src/shell/supplemental-commands/index.ts` (pass `getWorkflowCommands`/catalog where needed)
- Test: `packages/webapp/tests/shell/supplemental-commands/which-command.test.ts`, `packages/webapp/tests/shell/supplemental-commands/help-command.test.ts`

- [ ] **Step 1: Write the failing tests**

In `which-command.test.ts` (mirror its existing `ScriptCatalog`/`VirtualFS` setup):

```ts
it('resolves a saved workflow to its path labeled (workflow)', async () => {
  const fs = await VirtualFS.create({ dbName: `which-wf-${Math.random()}`, wipe: true });
  await fs.mkdir('/workspace/.workflows', { recursive: true });
  await fs.writeFile('/workspace/.workflows/audit.workflow.js', 'return 1');
  const catalog = new ScriptCatalog({ jshFs: fs });
  const ctx: any = { cwd: '/workspace', env: new Map(), getRegisteredCommands: () => ['audit'] };
  const res = await createWhichCommand({ fs, scriptCatalog: catalog }).execute(['audit'], ctx);
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toContain('/workspace/.workflows/audit.workflow.js');
  expect(res.stdout).toContain('(workflow)');
});

it('shows the .jsh path and marks the workflow shadowed when both exist', async () => {
  const fs = await VirtualFS.create({ dbName: `which-wf2-${Math.random()}`, wipe: true });
  await fs.mkdir('/workspace/.workflows', { recursive: true });
  await fs.writeFile('/workspace/.workflows/foo.workflow.js', 'return 1');
  await fs.writeFile('/workspace/foo.jsh', 'x');
  const catalog = new ScriptCatalog({ jshFs: fs });
  const ctx: any = { cwd: '/workspace', env: new Map(), getRegisteredCommands: () => ['foo'] };
  const res = await createWhichCommand({ fs, scriptCatalog: catalog }).execute(['foo'], ctx);
  expect(res.stdout).toContain('/workspace/foo.jsh');
  expect(res.stdout).toMatch(/shadow/i);
});
```

In `help-command.test.ts`:

```ts
it('lists workflow commands under a Workflows section', async () => {
  const cmd = createCommandsCommand({ getWorkflowCommands: async () => ['audit', 'triage:sweep'] });
  const ctx: any = { cwd: '/', env: new Map(), getRegisteredCommands: () => ['ls'] };
  const res = await cmd.execute([], ctx);
  expect(res.stdout).toMatch(/Workflows:/);
  expect(res.stdout).toContain('audit');
  expect(res.stdout).toContain('triage:sweep');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @slicc/webapp -- tests/shell/supplemental-commands/which-command.test.ts tests/shell/supplemental-commands/help-command.test.ts --run`
Expected: FAIL — no `(workflow)` label / no `Workflows:` section / `getWorkflowCommands` not an option.

- [ ] **Step 3: Update `which`**

In `which-command.ts`: import `discoverWorkflowCommands`, fetch the workflow map, and reorder resolution so scripts win over the `builtin`-registered name and workflows are labeled. Replace the resolution block (the loop that builds `stdoutLines`):

```ts
const jshCommands = resolvedOptions.scriptCatalog
  ? await resolvedOptions.scriptCatalog.getJshCommands()
  : resolvedOptions.fs
    ? await discoverJshCommands(resolvedOptions.fs)
    : new Map<string, string>();
const workflowCommands = resolvedOptions.scriptCatalog
  ? await resolvedOptions.scriptCatalog.getWorkflowCommands()
  : resolvedOptions.fs
    ? await discoverWorkflowCommands(resolvedOptions.fs)
    : new Map();

const stdoutLines: string[] = [];
let allFound = true;

for (const name of args) {
  const jshPath = jshCommands.get(name);
  const wf = workflowCommands.get(name);
  if (jshPath) {
    stdoutLines.push(jshPath); // .jsh wins the bare name
    if (wf) stdoutLines.push(`${wf.path} (workflow, shadowed by .jsh)`);
  } else if (wf) {
    stdoutLines.push(`${wf.path} (workflow)`);
  } else if (builtinSet.has(name)) {
    stdoutLines.push(`/usr/bin/${name}`); // real built-in
  } else {
    allFound = false;
  }
}
```

Add the import: `import { discoverWorkflowCommands } from '../workflow-discovery.js';`

- [ ] **Step 4: Update `commands`**

In `help-command.ts`: add `getWorkflowCommands?: () => Promise<string[]>;` to `CommandsCommandOptions`; fetch it; pass to `formatHelp`; render a section. In `formatHelp(commands, jshCommands = [], workflowCommands = [])` add after the `.jsh` block:

```ts
if (workflowCommands.length > 0) {
  lines.push('  Workflows:');
  lines.push(`    ${workflowCommands.sort().join(', ')}\n`);
}
```

And in the handler:

```ts
const jshCommands = (await options.getJshCommands?.()) ?? [];
const workflowCommands = (await options.getWorkflowCommands?.()) ?? [];
return {
  stdout: formatHelp(commands, jshCommands, workflowCommands),
  stderr: '',
  exitCode: 0,
};
```

- [ ] **Step 5: Wire `getWorkflowCommands` into `commands` in `index.ts`**

```ts
    createCommandsCommand({
      getJshCommands: options.getJshCommands,
      getWorkflowCommands: options.getWorkflowCommands,
    }),
```

Add `getWorkflowCommands?: () => Promise<string[]>;` to `SupplementalCommandsConfig` (the shell already passes it from Task 5 Step 5).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w @slicc/webapp -- tests/shell/supplemental-commands/which-command.test.ts tests/shell/supplemental-commands/help-command.test.ts --run`
Expected: PASS.

- [ ] **Step 7: Lint and commit**

```bash
npm run lint
git add packages/webapp/src/shell/supplemental-commands/which-command.ts packages/webapp/src/shell/supplemental-commands/help-command.ts packages/webapp/src/shell/supplemental-commands/index.ts packages/webapp/tests/shell/supplemental-commands/which-command.test.ts packages/webapp/tests/shell/supplemental-commands/help-command.test.ts
git commit -m "feat(workflow): surface workflows in which/commands with precedence labels

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: The `workflows` skill (the trigger)

A bundled native skill is the only "trigger" — auto-loaded into every scoop's system prompt by the skills engine (zero code).

**Files:**

- Create: `packages/vfs-root/workspace/skills/workflows/SKILL.md`
- Test: `packages/webapp/tests/skills/discover.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/skills/discover.test.ts` (mirror its existing `discoverSkills` test that writes a `SKILL.md` and asserts name/description). The bundled file is copied into the VFS at init; the test writes it to the in-memory FS and asserts discovery:

```ts
it('discovers the bundled workflows skill', async () => {
  const fs = await VirtualFS.create({ dbName: `skill-wf-${Math.random()}`, wipe: true });
  await fs.mkdir('/workspace/skills/workflows', { recursive: true });
  await fs.writeFile(
    '/workspace/skills/workflows/SKILL.md',
    '---\nname: workflows\ndescription: Use when a task warrants a dynamic workflow.\n---\n# Workflows\n'
  );
  const skills = await discoverSkills(fs, '/workspace/skills');
  expect(skills.some((s) => s.name === 'workflows')).toBe(true);
});
```

(Match the exact `discoverSkills` signature used elsewhere in that file.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @slicc/webapp -- tests/skills/discover.test.ts --run`
Expected: FAIL (the in-test write makes it pass already if `discoverSkills` works — if so, this test mainly guards the format; keep it as a regression). If it passes immediately, that's fine — proceed to author the real bundled file (Step 3), which is the actual deliverable.

- [ ] **Step 3: Author the skill**

Create `packages/vfs-root/workspace/skills/workflows/SKILL.md`:

````markdown
---
name: workflows
description: |
  Use this when a task is a fan-out/aggregate job worth orchestrating in code rather
  than doing turn-by-turn: codebase-wide sweeps, large migrations, multi-source research
  you cross-check, or multi-angle planning. Covers authoring a workflow (the meta block +
  the agent/parallel/pipeline/phase/log API), running it (non-blocking by default), and
  saving a good run as a reusable command. NOT for one-off single-agent tasks — use a
  plain scoop or `agent` for those.
allowed-tools: bash, read_file, write_file
---

# Workflows

A workflow is a plain-JS orchestration script that fans out to parallel sub-agents and
keeps intermediate results in script variables (not your context). You author it, run it
with `workflow run`, and — once it's good — `workflow save` it as a reusable command.

## When to reach for a workflow

- A sweep over many files/items where each unit is independent (lint, classify, summarize).
- A migration applied across a codebase in parallel, then aggregated.
- Research that fans out to several sources and cross-checks them.
- Multi-angle planning (draft N approaches in parallel, then synthesize).

If it's a single self-contained task, just use a plain scoop or the `agent` command — a
workflow is overhead you don't need.

## The API (available inside a workflow script)

- `agent(prompt, opts?)` → the sub-agent's text (or parsed JSON when `opts.schema` is set),
  or `null` on failure. `opts`: `{ model?, thinking?, schema?, phase?, label? }`.
  - `thinking`: `off | minimal | low | medium | high | xhigh` (per-agent reasoning effort).
  - `schema`: a JSON Schema; the result is constrained to it and JSON-parsed for you.
  - `phase` / `label`: display-only grouping (no execution effect yet).
- `parallel(thunks)` → runs an array of `() => Promise` concurrently (bounded by the cap).
- `pipeline(items, ...stages)` → maps items through stages.
- `phase(title)` / `log(message)` → progress markers.
- `args` → the value passed when the workflow is invoked (`<name> '<json>'`).

## Authoring

A workflow MUST export a `meta` block with a `name` (description optional):

```js
export const meta = { name: 'weekly-audit', description: 'Audit each package in parallel' };

const pkgs = args?.packages ?? ['webapp', 'node-server'];
phase('audit');
const findings = await parallel(
  pkgs.map((p) => () => agent(`Audit packages/${p} for TODOs. One line each.`, { thinking: 'low' }))
);
return findings.filter(Boolean);
```
````

## Running

```bash
workflow run my.workflow.js            # non-blocking — returns a run id; result arrives as a turn
workflow run my.workflow.js --wait     # block and print the full result
workflow status <runId>                # progress
workflow list                          # all runs
```

Default is non-blocking: you get a run id immediately and the result comes back as a new
turn (with a path + preview) when it finishes. Run non-blocking when you intend to save —
only backgrounded runs can be saved.

## Saving as a reusable command

```bash
workflow save <runId> weekly-audit     # → /workspace/.workflows/weekly-audit.workflow.js
weekly-audit                           # now a bare command
weekly-audit '{"packages":["cherry"]}' # JSON arg arrives as `args`
```

Saved workflows live in `/workspace/.workflows/` and become bare commands (`weekly-audit`).
Skills can also ship workflows under `skills/<skill>/.workflows/`, which register as
`<skill>:<name>`. If a bare name collides, the precedence is `built-in > .jsh > saved-workflow`
(a built-in or `.jsh` keeps the bare name; the workflow is still runnable via
`workflow run /workspace/.workflows/<name>.workflow.js`). `workflow save` rejects a name
that's already a command, so pick another.

````

- [ ] **Step 3b: Verify the skill lints (tessl SKILL.md lint)**

Run: `npm run lint:skills`
Expected: PASS (no SKILL.md violations).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @slicc/webapp -- tests/skills/discover.test.ts --run`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add packages/vfs-root/workspace/skills/workflows/SKILL.md packages/webapp/tests/skills/discover.test.ts
git commit -m "feat(workflow): add workflows authoring skill

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
````

---

## Task 8: Documentation

**Files:**

- Modify: `docs/shell-reference.md` (the `workflow` section)
- Modify: `packages/vfs-root/shared/CLAUDE.md` (point the cone at the workflows skill)
- Modify: `docs/architecture.md` (note `*.workflow.js` discovery alongside `.jsh`/`.bsh`)
- Modify: `packages/webapp/CLAUDE.md` (the `workflow-{command,prelude,script}.ts` bullet — mention save + discovery)

- [ ] **Step 1: `docs/shell-reference.md`**

In the `workflow` section, add a `workflow save` entry and a "Saved & skill workflows as commands" subsection covering: `workflow save <runId> <name> [--force]` (backgrounded runs only); saved → bare `<name>` from `/workspace/.workflows/`, skill-bundled → `<skill>:<name>` from `skills/*/.workflows/`; the bare-name precedence `built-in > .jsh > saved-workflow` resolved at dispatch; the `workflow run <path>` fallback for a shadowed workflow; and the lenient `args` coercion with the `foo 123` / `foo '"123"'` / `foo a b` examples and the `--` separator.

- [ ] **Step 2: `packages/vfs-root/shared/CLAUDE.md`**

Add a line under the relevant section pointing the cone at the workflows skill, e.g.: "For fan-out/aggregate work (sweeps, migrations, multi-source research, multi-angle planning), use the `workflows` skill — author a `workflow run` script, then `workflow save` a good run as a reusable command."

- [ ] **Step 3: `docs/architecture.md`**

Where `.jsh`/`.bsh` discovery is described, add that `*.workflow.js` files under `/workspace/.workflows/` (bare names) and `/workspace/skills/*/.workflows/` (`<skill>:<name>`) are discovered as commands routed through the workflow runner, with dispatch-time precedence `built-in > .jsh > saved-workflow`.

- [ ] **Step 4: `packages/webapp/CLAUDE.md`**

Extend the `supplemental-commands/workflow-{command,prelude,script}.ts` bullet to mention: `workflow save` persists a run's source to `/workspace/.workflows/`; `*.workflow.js` auto-discovers as commands (`workflow-discovery.ts` + `ScriptCatalog.getWorkflowCommands`); `agent()` accepts `thinking`.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add docs/shell-reference.md packages/vfs-root/shared/CLAUDE.md docs/architecture.md packages/webapp/CLAUDE.md
git commit -m "docs(workflow): document workflow save + *.workflow.js discovery

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] **Full gates** (the repo's CI gates; run from the repo root):

```bash
npm run lint
npm run typecheck
npm run test
npm run test:coverage
npm run build
npm run build -w @slicc/chrome-extension
```

Expected: all green. Coverage must stay at/above each package's floor in `coverage-thresholds.json` — the new pure modules (`workflow-discovery.ts`) and command branches are well-covered by Tasks 2/4/5/6.

- [ ] **Manual smoke (optional, both floats)**: in a SLICC terminal, run a small workflow non-blocking, `workflow save <runId> demo`, then run `demo` as a bare command; confirm `which demo` shows `(workflow)` and `commands` lists it under "Workflows:".

---

## Self-review notes (for the executor)

- **Precedence correctness hinges on Task 4's _single_ handler.** Both the `.jsh` loop and the workflow loop register the SAME `makeScriptCommand(name)` function; it resolves `.jsh`-then-workflow at dispatch. This is what makes late arrival / deletion order-independent with no unregister. Do not give workflows a separate handler that runs the workflow directly — that reintroduces the order-dependence bug.
- **Never `executeJsCode` a `*.workflow.js` raw.** Workflows must go through `workflow run` (Task 4 Step 5, branch 2) so the prelude/determinism guards + the run manager apply.
- **Reject-at-save uses `ctx.getRegisteredCommands()`** (built-ins + already-registered scripts). It can't see a `.jsh` that will be dropped _later_ — that's the dispatch-time precedence's job (built-in/`.jsh` keep the bare name; the workflow stays runnable via `workflow run <path>`).
- **Type names to keep consistent:** `WorkflowCommandEntry` (`{ path, kind: 'saved'|'skill', skill? }`), `discoverWorkflowCommands`, `buildWorkflowRunArgv`, `getWorkflowCommands` (catalog), `getWorkflowCommandNames` (shell), `registeredWorkflowCommands` (shell field), `syncScriptCommands` (config callback).
