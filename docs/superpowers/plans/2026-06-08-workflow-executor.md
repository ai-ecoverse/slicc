# Workflow Executor (SP1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a blocking `workflow run` shell command that executes a non-nesting, Claude-Code-format dynamic-workflow `.js` to completion via real SLICC scoops, in both the standalone and extension floats.

**Architecture:** No realm fork. The command prepends a **user-space JS prelude** (which defines `agent`/`parallel`/`pipeline`/`phase`/`log`/`budget`/`args`/`workflow`, a determinism guard, and a concurrency semaphore) to a lightly-transformed user script, then runs the whole thing through the **existing** `executeJsCode` → `runInRealm({kind:'js'})` path. `agent()` shells out to the **existing `agent` command** via the realm's `exec.spawn`; the result is returned via a stdout sentinel. The `{schema}` path extends the `agent` command + `AgentBridge` + `ScoopContext` to inject a `StructuredOutput` tool. In the extension, a side-panel `workflow run` forwards execution to the offscreen document so the run survives a panel close.

**Tech Stack:** TypeScript, just-bash supplemental commands, the `kernel/realm/` runner, pi-agent-core/pi-ai (tool validation via `typebox`), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-08-workflow-executor-design.md`. Read it before starting.

> **⚠ Corrections from the 2026-06-08 codex review — apply throughout (override the code blocks below where they conflict):**
> 1. **Suppression (Task 2):** the realm injects many globals — null the **full** set after capturing `exec.spawn` and taking `cwd` from `__WF.cwd` (not `process`): `exec = fs = fetch = require = process = module = exports = skill = http = browser = usb = serial = hid = cli = c = time = fmt = pool = undefined;` (`skill`/`http` otherwise re-expose FS/shell/fetch).
> 2. **Determinism guard (Task 2):** broaden beyond `Date`/`Math.random` to also shadow `crypto`, `performance.now`, timers (`setTimeout`/`setInterval`/`queueMicrotask`), and `globalThis`. Document the residual soft-isolation holes (`globalThis.*`, dynamic `import()`, pre-loaded `require()`).
> 3. **Fatal errors (Task 2):** `parallel`/`pipeline` must **rethrow** `WorkflowError` subclasses (cap/budget/determinism) instead of catch-to-`null`.
> 4. **Sentinel (Tasks 1–3):** use a **random per-run** sentinel token (injected via `__WF`), and parse **only** the single wrapper-emitted line bearing it (a user `console.log` must not be able to spoof the result).
> 5. **`agent()` cwd (Task 2):** spawn scoops with a **constrained per-run prefix** (`/shared/workflow-runs/<runId>/scratch/`), not the invoking realm cwd (which is `/` in the ext panel).
> 6. **StructuredOutput nudges (Task 7):** **2** corrective nudges (not 1) before resolving `null`, to match the spec.
> 7. **Task 9 removed:** the panel terminal is already offscreen-backed (`RemoteTerminalView`→`TerminalSessionHost`), so no `workflow-run` chrome-message forwarding / `runRemote` seam is needed — drop it. (The `WorkflowCommandOptions.runRemote` parameter and Task 9 are obsolete.)
> 8. **Exec tap (for SP2/SP5, not SP1):** the host-side progress/cache tap wraps **`ctx.exec`**, not `ctx.exec.spawn`.
> 9. After `npm install`, **re-confirm** pi-agent-core exposes `afterToolCall` (Task 7) before relying on it.

**Prep (once):** This worktree needs its own install before vitest/build resolve pi-ai deep imports:
```bash
cd /Users/kpauls/projects/adobe/github/slicc/.claude/worktrees/workflow-executor
npm install
npm test -w @slicc/webapp -- --run tests/shell 2>&1 | tail -5   # baseline: pre-existing suite green
```

Constants used across tasks: the stdout result sentinel is `"WF_RESULT"`; progress markers are `"WFPHASE"` / `"WFLOG"`.

---

## Task 1: Pure script helpers (`workflow-script.ts`)

**Files:**
- Create: `packages/webapp/src/shell/supplemental-commands/workflow-script.ts`
- Test: `packages/webapp/tests/shell/supplemental-commands/workflow-script.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/webapp/tests/shell/supplemental-commands/workflow-script.test.ts
import { describe, expect, it } from 'vitest';
import {
  SENTINEL,
  parseMetaBanner,
  stripExports,
  buildWorkflowCode,
  splitSentinel,
} from '../../../src/shell/supplemental-commands/workflow-script.js';

describe('workflow-script', () => {
  it('parses name/description from a pure-literal meta block', () => {
    const src = `export const meta = {\n  name: 'review-changes',\n  description: 'Review and verify',\n  phases: [{ title: 'Review' }],\n}\nreturn 1`;
    expect(parseMetaBanner(src)).toEqual({
      name: 'review-changes',
      description: 'Review and verify',
    });
  });

  it('returns null name/description when meta is absent', () => {
    expect(parseMetaBanner('const x = 1; return x')).toEqual({ name: null, description: null });
  });

  it('strips the export keyword from declarations', () => {
    expect(stripExports("export const meta = {}\nexport async function f(){}")).toBe(
      'const meta = {}\nasync function f(){}'
    );
  });

  it('wraps the body in an async IIFE and appends the sentinel emit', () => {
    const code = buildWorkflowCode({
      prelude: '/*P*/',
      config: { args: null, cap: 4, budget: null },
      body: "export const meta = {}\nreturn { ok: true }",
    });
    expect(code).toContain('const __WF = {"args":null,"cap":4,"budget":null};');
    expect(code).toContain('/*P*/');
    expect(code).toContain('const __r = await (async () => {');
    expect(code).toContain('const meta = {}'); // export stripped
    expect(code).toContain(`console.log(${JSON.stringify(SENTINEL)} + JSON.stringify(__r ?? null))`);
  });

  it('splits the sentinel result line from the log output', () => {
    const stdout = `WFLOG hi\n${SENTINEL}{"ok":true}\n`;
    expect(splitSentinel(stdout)).toEqual({
      result: { ok: true },
      log: 'WFLOG hi',
      hadResult: true,
    });
  });

  it('reports hadResult:false when no sentinel line is present', () => {
    expect(splitSentinel('just logs\n')).toEqual({
      result: null,
      log: 'just logs',
      hadResult: false,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @slicc/webapp -- --run tests/shell/supplemental-commands/workflow-script.test.ts`
Expected: FAIL — `Cannot find module '.../workflow-script.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/webapp/src/shell/supplemental-commands/workflow-script.ts
/**
 * Pure helpers for the `workflow` command: static meta extraction, export
 * stripping, code assembly (prelude + IIFE-wrapped body + sentinel emit), and
 * sentinel result parsing. No realm/IO here so these are trivially testable.
 */

/** Marker the wrapped script prints to carry its return value back via stdout. */
export const SENTINEL = 'WF_RESULT';

/** Config literal injected ahead of the prelude (read by the prelude as `__WF`). */
export interface WorkflowConfig {
  args: unknown;
  cap: number;
  budget: number | null;
}

/** Extract the workflow's display name/description from its `meta` literal. */
export function parseMetaBanner(src: string): { name: string | null; description: string | null } {
  const block = extractMetaBlock(src);
  if (block === null) return { name: null, description: null };
  return { name: matchStringField(block, 'name'), description: matchStringField(block, 'description') };
}

/** Remove the `export` keyword before top-level declarations (illegal inside a Function body). */
export function stripExports(src: string): string {
  return src.replace(/\bexport\s+(const|let|var|function|async\s+function|class)\b/g, '$1');
}

/** Assemble the final realm code: `__WF` config + prelude + IIFE-wrapped body + sentinel emit. */
export function buildWorkflowCode(opts: {
  prelude: string;
  config: WorkflowConfig;
  body: string;
}): string {
  const stripped = stripExports(opts.body);
  return (
    `const __WF = ${JSON.stringify(opts.config)};\n` +
    `${opts.prelude}\n` +
    `const __r = await (async () => {\n${stripped}\n})();\n` +
    `console.log(${JSON.stringify(SENTINEL)} + JSON.stringify(__r ?? null));\n`
  );
}

/** Split realm stdout into the parsed result (last sentinel line) and the remaining log text. */
export function splitSentinel(stdout: string): { result: unknown; log: string; hadResult: boolean } {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(SENTINEL)) {
      const json = lines[i].slice(SENTINEL.length);
      const log = [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n').replace(/\n+$/, '');
      try {
        return { result: JSON.parse(json), log, hadResult: true };
      } catch {
        return { result: null, log, hadResult: true };
      }
    }
  }
  return { result: null, log: stdout.replace(/\n+$/, ''), hadResult: false };
}

/** Balanced-brace scan for the `meta = { ... }` object literal; returns its inner text or null. */
function extractMetaBlock(src: string): string | null {
  const m = /\bmeta\s*=\s*\{/.exec(src);
  if (!m) return null;
  let depth = 0;
  const start = m.index + m[0].length - 1; // at the opening '{'
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  return null;
}

/** Pull a single-quoted/double-quoted string field value out of a literal block. */
function matchStringField(block: string, field: string): string | null {
  const re = new RegExp(`\\b${field}\\s*:\\s*(['"\\\`])((?:\\\\.|(?!\\1).)*)\\1`);
  const m = re.exec(block);
  return m ? m[2] : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @slicc/webapp -- --run tests/shell/supplemental-commands/workflow-script.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/shell/supplemental-commands/workflow-script.ts packages/webapp/tests/shell/supplemental-commands/workflow-script.test.ts
git commit -m "feat(workflow): pure script helpers (meta parse, transform, sentinel)"
```

---

## Task 2: The workflow prelude (`workflow-prelude.ts`)

**Files:**
- Create: `packages/webapp/src/shell/supplemental-commands/workflow-prelude.ts`
- Test: `packages/webapp/tests/shell/supplemental-commands/workflow-prelude.test.ts`

The prelude is a JS string injected into the realm's AsyncFunction body (which receives `exec`, `process`, `console`, `fs`, `fetch`, `require`, … as named params). The test compiles the same shape with mocks.

- [ ] **Step 1: Write the failing test**

```ts
// packages/webapp/tests/shell/supplemental-commands/workflow-prelude.test.ts
import { describe, expect, it } from 'vitest';
import { WORKFLOW_PRELUDE } from '../../../src/shell/supplemental-commands/workflow-prelude.js';

// Build an async fn matching the realm's injection shape: globals as named params.
function makeRunner(body: string) {
  const AsyncFn = Object.getPrototypeOf(async () => {}).constructor as new (
    ...a: string[]
  ) => (...a: unknown[]) => Promise<unknown>;
  return new AsyncFn('exec', 'process', 'console', 'fs', 'fetch', 'require', '__WF', `"use strict";\n${WORKFLOW_PRELUDE}\n${body}`);
}
function fakeConsole() {
  const out: string[] = [];
  return { log: (s: unknown) => out.push(String(s)), out };
}
const proc = { cwd: () => '/workspace' };
const WF = { args: { q: 'hi' }, cap: 2, budget: null };

describe('workflow-prelude', () => {
  it('agent() spawns via exec.spawn and returns trimmed text', async () => {
    const calls: string[][] = [];
    const exec = { spawn: async (argv: string[]) => { calls.push(argv); return { stdout: 'answer\n', stderr: '', exitCode: 0 }; } };
    const c = fakeConsole();
    const run = makeRunner('globalThis.__t = await agent("question"); ');
    await run(exec, proc, c, undefined, undefined, undefined, WF);
    expect((globalThis as any).__t).toBe('answer');
    expect(calls[0]).toEqual(['agent', '/workspace', '*', 'question']);
  });

  it('agent({schema}) passes --schema-b64 and JSON-parses the result', async () => {
    const calls: string[][] = [];
    const exec = { spawn: async (argv: string[]) => { calls.push(argv); return { stdout: '{"n":1}', stderr: '', exitCode: 0 }; } };
    const run = makeRunner('globalThis.__t = await agent("q", { schema: { type: "object" } });');
    await run(exec, proc, fakeConsole(), undefined, undefined, undefined, WF);
    expect((globalThis as any).__t).toEqual({ n: 1 });
    expect(calls[0]).toContain('--schema-b64');
  });

  it('agent() returns null on non-zero exit', async () => {
    const exec = { spawn: async () => ({ stdout: '', stderr: 'boom', exitCode: 1 }) };
    const run = makeRunner('globalThis.__t = await agent("q");');
    await run(exec, proc, fakeConsole(), undefined, undefined, undefined, WF);
    expect((globalThis as any).__t).toBeNull();
  });

  it('parallel() never rejects — failing thunks become null', async () => {
    const exec = { spawn: async () => ({ stdout: 'x', stderr: '', exitCode: 0 }) };
    const run = makeRunner('globalThis.__t = await parallel([() => agent("a"), () => { throw new Error("z"); }]);');
    await run(exec, proc, fakeConsole(), undefined, undefined, undefined, WF);
    expect((globalThis as any).__t).toEqual(['x', null]);
  });

  it('pipeline() streams each item through stages with (prev,item,index)', async () => {
    const exec = { spawn: async () => ({ stdout: '', stderr: '', exitCode: 0 }) };
    const run = makeRunner(
      'globalThis.__t = await pipeline([10, 20], (p, item, i) => p + i, (p) => p * 2);'
    );
    await run(exec, proc, fakeConsole(), undefined, undefined, undefined, WF);
    expect((globalThis as any).__t).toEqual([20, 42]); // (10+0)*2, (20+1)*2
  });

  it('parallel()/pipeline() reject above 4096 items', async () => {
    const run = makeRunner('globalThis.__err = await parallel(new Array(4097).fill(() => 1)).then(() => null, (e) => e.message);');
    await run({ spawn: async () => ({}) }, proc, fakeConsole(), undefined, undefined, undefined, WF);
    expect((globalThis as any).__err).toMatch(/4096/);
  });

  it('determinism guard throws on Date.now / Math.random / argless new Date', async () => {
    const run = makeRunner(
      'globalThis.__a = (() => { try { Date.now(); return "no"; } catch { return "yes"; } })();' +
      'globalThis.__b = (() => { try { Math.random(); return "no"; } catch { return "yes"; } })();' +
      'globalThis.__c = (() => { try { new Date(); return "no"; } catch { return "yes"; } })();' +
      'globalThis.__d = new Date(0).getTime();'
    );
    await run({ spawn: async () => ({}) }, proc, fakeConsole(), undefined, undefined, undefined, WF);
    expect([(globalThis as any).__a, (globalThis as any).__b, (globalThis as any).__c]).toEqual(['yes', 'yes', 'yes']);
    expect((globalThis as any).__d).toBe(0); // new Date(arg) still works
  });

  it('exposes args and a non-enforcing budget stub; phase()/log() emit markers', async () => {
    const c = fakeConsole();
    const run = makeRunner('phase("Scan"); log("hi"); globalThis.__args = args; globalThis.__rem = budget.remaining();');
    await run({ spawn: async () => ({}) }, proc, c, undefined, undefined, undefined, WF);
    expect((globalThis as any).__args).toEqual({ q: 'hi' });
    expect((globalThis as any).__rem).toBe(Infinity);
    expect(c.out.some((l) => l.startsWith('WFPHASEScan'))).toBe(true);
    expect(c.out.some((l) => l.startsWith('WFLOGhi'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @slicc/webapp -- --run tests/shell/supplemental-commands/workflow-prelude.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/webapp/src/shell/supplemental-commands/workflow-prelude.ts
/**
 * WORKFLOW_PRELUDE — JS injected ahead of a Claude-Code workflow script inside
 * the kind:'js' realm. It defines the orchestration globals (agent, parallel,
 * pipeline, phase, log, budget, args, workflow), installs a determinism guard,
 * and suppresses fs/exec/fetch/require. `agent()` reuses the existing `agent`
 * shell command via the realm's `exec.spawn`. Caps live here (the only spawn
 * path the user script has). See the SP1 design spec for the full contract.
 *
 * Realm-injected names in scope: exec, process, console, fs, fetch, require, __WF.
 */
export const WORKFLOW_PRELUDE = String.raw`
// --- determinism guard (shadow real globals for the user script's scope) ---
const __RealDate = globalThis.Date;
const Date = new Proxy(__RealDate, {
  construct(target, a) {
    if (a.length === 0) throw new Error('WorkflowDeterminismError: argless new Date() is banned (nondeterministic) — pass a timestamp via args');
    return new target(...a);
  },
  get(target, p) {
    if (p === 'now') return () => { throw new Error('WorkflowDeterminismError: Date.now() is banned — pass a timestamp via args'); };
    const v = target[p];
    return typeof v === 'function' ? v.bind(target) : v;
  },
  apply(target, _t, a) { return target(...a); },
});
const Math = new Proxy(globalThis.Math, {
  get(target, p) {
    if (p === 'random') return () => { throw new Error('WorkflowDeterminismError: Math.random() is banned — vary by index instead'); };
    const v = target[p];
    return typeof v === 'function' ? v.bind(target) : v;
  },
});

// --- suppression: capture exec.spawn, then blank the IO globals ---
const __execSpawn = (typeof exec !== 'undefined' && exec && exec.spawn) ? exec.spawn.bind(exec) : null;
try { exec = undefined; } catch (e) {}
try { fs = undefined; } catch (e) {}
try { fetch = undefined; } catch (e) {}
try { require = undefined; } catch (e) {}

const __cwd = (typeof process !== 'undefined' && process.cwd) ? process.cwd() : '/workspace';
const args = __WF.args;

function __b64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// --- concurrency semaphore + total cap ---
function __makeSem(n) {
  let active = 0; const q = [];
  return {
    async acquire() { if (active < n) { active++; return; } await new Promise((r) => q.push(r)); active++; },
    release() { active--; const r = q.shift(); if (r) r(); },
  };
}
const __sem = __makeSem(Math.max(1, __WF.cap | 0));
let __total = 0;
let __phase = null;

async function agent(prompt, opts) {
  opts = opts || {};
  if (__total >= 1000) throw new Error('WorkflowAgentCapError: 1000-agent total cap reached');
  __total++;
  await __sem.acquire();
  try {
    if (!__execSpawn) throw new Error('workflow: agent runtime unavailable');
    const flags = [];
    if (opts.model) flags.push('--model', String(opts.model));
    if (opts.schema) flags.push('--schema-b64', __b64(JSON.stringify(opts.schema)));
    const argv = ['agent'].concat(flags, [__cwd, '*', String(prompt)]);
    const r = await __execSpawn(argv);
    if (!r || r.exitCode !== 0) return null;
    const out = String(r.stdout || '').replace(/\n+$/, '');
    return opts.schema ? JSON.parse(out) : out;
  } finally { __sem.release(); }
}

async function parallel(thunks) {
  if (!Array.isArray(thunks)) throw new Error('parallel() expects an array of functions');
  if (thunks.length > 4096) throw new Error('parallel(): at most 4096 items per call');
  return Promise.all(thunks.map(async (t) => { try { return await t(); } catch (e) { return null; } }));
}

async function pipeline(items, ...stages) {
  if (!Array.isArray(items)) throw new Error('pipeline() expects an array as its first argument');
  if (items.length > 4096) throw new Error('pipeline(): at most 4096 items per call');
  return Promise.all(items.map(async (item, index) => {
    let prev = item;
    for (const stage of stages) {
      try { prev = await stage(prev, item, index); } catch (e) { return null; }
    }
    return prev;
  }));
}

function phase(title) { __phase = String(title); console.log('WFPHASE' + __phase); }
function log(message) { console.log('WFLOG' + String(message)); }

const budget = {
  total: (__WF.budget == null ? null : __WF.budget),
  spent() { return 0; },
  remaining() { return this.total == null ? Infinity : Math.max(0, this.total - this.spent()); },
};

function workflow() { throw new Error('WorkflowNestingUnsupportedError: nested workflow() is not supported in SP1'); }
`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @slicc/webapp -- --run tests/shell/supplemental-commands/workflow-prelude.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/shell/supplemental-commands/workflow-prelude.ts packages/webapp/tests/shell/supplemental-commands/workflow-prelude.test.ts
git commit -m "feat(workflow): user-space prelude (agent/parallel/pipeline/determinism/caps)"
```

---

## Task 3: The `workflow run` command (no-schema, in-place)

**Files:**
- Create: `packages/webapp/src/shell/supplemental-commands/workflow-command.ts`
- Test: `packages/webapp/tests/shell/supplemental-commands/workflow-command.test.ts`

This task wires `workflow run <file>` / `--script` to `executeJsCode`. The integration test runs through the in-process realm (vitest, no `Worker`) with a mock `exec` on the context that intercepts the `agent` argv.

- [ ] **Step 1: Write the failing test**

```ts
// packages/webapp/tests/shell/supplemental-commands/workflow-command.test.ts
import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../../src/fs/index.js';
import { createWorkflowCommand } from '../../../src/shell/supplemental-commands/workflow-command.js';

// Minimal CommandContext with a mock exec whose .spawn answers `agent` argv.
async function ctxWith(fs: VirtualFS, spawn: (argv: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>) {
  const adapter = (await import('../../../src/shell/vfs-adapter.js')).createVfsAdapter(fs);
  const exec = Object.assign(async () => ({ stdout: '', stderr: '', exitCode: 0 }), { spawn });
  return { fs: adapter, cwd: '/workspace', env: new Map<string, string>(), stdin: '' as unknown, exec } as any;
}

describe('workflow run', () => {
  it('runs a fan-out workflow and prints the returned value', async () => {
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    await fs.writeFile(
      '/workspace/wf.js',
      `export const meta = { name: 'demo', description: 'd' }\n` +
        `const xs = await parallel([() => agent('a'), () => agent('b')])\n` +
        `return { xs }`
    );
    const spawn = async (argv: string[]) => ({ stdout: argv[argv.length - 1].toUpperCase(), stderr: '', exitCode: 0 });
    const cmd = createWorkflowCommand();
    const res = await cmd.handler(['run', '/workspace/wf.js'], await ctxWith(fs, spawn));
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('"xs":["A","B"]');
  });

  it('errors on a missing file', async () => {
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    const cmd = createWorkflowCommand();
    const res = await cmd.handler(['run', '/nope.js'], await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 })));
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/not found|cannot find/i);
  });

  it('surfaces a thrown workflow body as a non-zero exit', async () => {
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    await fs.writeFile('/workspace/boom.js', `export const meta = { name: 'b', description: 'd' }\nthrow new Error('kaboom')`);
    const cmd = createWorkflowCommand();
    const res = await cmd.handler(['run', '/workspace/boom.js'], await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 })));
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/kaboom/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @slicc/webapp -- --run tests/shell/supplemental-commands/workflow-command.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/webapp/src/shell/supplemental-commands/workflow-command.ts
import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { createLogger } from '../../core/logger.js';
import { executeJsCode } from '../jsh-executor.js';
import { WORKFLOW_PRELUDE } from './workflow-prelude.js';
import { buildWorkflowCode, parseMetaBanner, splitSentinel } from './workflow-script.js';

const log = createLogger('workflow-command');

const HELP = `usage: workflow run <file.js> [--args <json>] [--budget <tokens>] [--concurrency <n>]
       workflow run --script '<inline js>' [--args <json>] [...]

Runs a Claude-Code-format dynamic workflow to completion (blocking) and prints
its returned value. SP1: non-nesting; no save/list/resume (see the design spec).

Options:
  --script <js>        Inline workflow source instead of a file.
  --args <json>        JSON value exposed to the script as the global \`args\`.
  --budget <tokens>    Sets budget.total (non-enforcing in SP1).
  --concurrency <n>    Max concurrent agents (default 4, clamped to 1..16).
  -h, --help           Show this help.`;

interface Parsed {
  help?: boolean;
  error?: string;
  file?: string;
  script?: string;
  args?: unknown;
  budget?: number | null;
  concurrency?: number;
}

function parse(args: string[]): Parsed {
  if (args[0] !== 'run') {
    if (args.includes('-h') || args.includes('--help') || args.length === 0) return { help: true };
    return { error: `workflow: unknown subcommand '${args[0]}' (only 'run' in SP1)` };
  }
  const out: Parsed = { budget: null, concurrency: 4 };
  let i = 1;
  while (i < args.length) {
    const a = args[i];
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '--script') { out.script = args[++i]; i++; continue; }
    if (a === '--args') {
      try { out.args = JSON.parse(args[++i] ?? ''); } catch { return { error: 'workflow: --args must be valid JSON' }; }
      i++; continue;
    }
    if (a === '--budget') { const n = Number(args[++i]); if (!Number.isFinite(n)) return { error: 'workflow: --budget must be a number' }; out.budget = n; i++; continue; }
    if (a === '--concurrency') { const n = Number(args[++i]); if (!Number.isFinite(n)) return { error: 'workflow: --concurrency must be a number' }; out.concurrency = Math.min(16, Math.max(1, Math.trunc(n))); i++; continue; }
    if (a.startsWith('-')) return { error: `workflow: unknown flag '${a}'` };
    if (out.file === undefined) { out.file = a; i++; continue; }
    return { error: 'workflow: too many arguments' };
  }
  if (out.script === undefined && out.file === undefined) return { error: 'workflow: a <file.js> or --script is required' };
  return out;
}

/** Options for {@link createWorkflowCommand}. Extension wiring (Task 10) supplies a forwarder. */
export interface WorkflowCommandOptions {
  /** When set (extension side panel), forward the run to offscreen instead of running locally. */
  runRemote?: (code: string, filename: string, ctx: CommandContext) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export function createWorkflowCommand(options: WorkflowCommandOptions = {}): Command {
  return defineCommand('workflow', async (args, ctx) => {
    const parsed = parse(args);
    if (parsed.help) return { stdout: HELP + '\n', stderr: '', exitCode: 0 };
    if (parsed.error) return { stdout: '', stderr: parsed.error + '\n', exitCode: 1 };

    let source: string;
    let filename: string;
    if (parsed.script !== undefined) {
      source = parsed.script;
      filename = '<workflow>';
    } else {
      const path = ctx.fs.resolvePath(ctx.cwd, parsed.file!);
      if (!(await ctx.fs.exists(path))) return { stdout: '', stderr: `workflow: file not found: ${parsed.file}\n`, exitCode: 1 };
      source = await ctx.fs.readFile(path);
      filename = parsed.file!;
    }

    const banner = parseMetaBanner(source);
    const code = buildWorkflowCode({
      prelude: WORKFLOW_PRELUDE,
      config: { args: parsed.args ?? null, cap: parsed.concurrency ?? 4, budget: parsed.budget ?? null },
      body: source,
    });

    let result: { stdout: string; stderr: string; exitCode: number };
    try {
      result = options.runRemote
        ? await options.runRemote(code, filename, ctx)
        : await executeJsCode(code, ['workflow', filename], ctx, undefined, { filename });
    } catch (err) {
      log.error('workflow run failed', err);
      return { stdout: '', stderr: `workflow: ${err instanceof Error ? err.message : String(err)}\n`, exitCode: 1 };
    }

    const { result: value, log: runLog, hadResult } = splitSentinel(result.stdout);
    const head = banner.name ? `workflow: ${banner.name}${banner.description ? ' — ' + banner.description : ''}\n` : '';
    const logBlock = runLog ? renderLog(runLog) + '\n' : '';

    if (result.exitCode !== 0 || !hadResult) {
      return { stdout: head + logBlock, stderr: result.stderr || (hadResult ? '' : 'workflow: script produced no result\n'), exitCode: result.exitCode || 1 };
    }
    const printed = typeof value === 'string' ? value : JSON.stringify(value);
    return { stdout: head + logBlock + printed + '\n', stderr: result.stderr, exitCode: 0 };
  });
}

/** Render the streamed phase/log markers into readable lines. */
function renderLog(raw: string): string {
  return raw
    .split('\n')
    .map((l) => l.replace(/^WFPHASE/, '▸ ').replace(/^WFLOG/, '· '))
    .join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @slicc/webapp -- --run tests/shell/supplemental-commands/workflow-command.test.ts`
Expected: PASS (3 tests). If the in-process realm path needs `exec.spawn` and the mock lacks a field, adjust the mock to match `dispatchExec`'s `spawn` return shape (`{stdout,stderr,exitCode}`) — confirmed in §14.4 of the spec.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/shell/supplemental-commands/workflow-command.ts packages/webapp/tests/shell/supplemental-commands/workflow-command.test.ts
git commit -m "feat(workflow): workflow run command (blocking, no-schema)"
```

---

## Task 4: Register the command

**Files:**
- Modify: `packages/webapp/src/shell/supplemental-commands/index.ts`

- [ ] **Step 1: Add the import** (next to the other command imports, alphabetical-ish near `createNodeCommand`)

```ts
import { createWorkflowCommand } from './workflow-command.js';
```

- [ ] **Step 2: Register it** in the `commands` array inside `createSupplementalCommands` (next to `createNodeCommand()`):

```ts
    createNodeCommand(),
    createWorkflowCommand(),
```

- [ ] **Step 3: Verify it resolves** with a quick smoke test appended to `workflow-command.test.ts`:

```ts
import { createSupplementalCommands } from '../../../src/shell/supplemental-commands/index.js';
it('is registered in the supplemental command set', () => {
  expect(createSupplementalCommands().some((c) => c.name === 'workflow')).toBe(true);
});
```

Run: `npm test -w @slicc/webapp -- --run tests/shell/supplemental-commands/workflow-command.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/src/shell/supplemental-commands/index.ts packages/webapp/tests/shell/supplemental-commands/workflow-command.test.ts
git commit -m "feat(workflow): register the workflow command"
```

---

## Task 5: `agent --schema-b64` flag

**Files:**
- Modify: `packages/webapp/src/shell/supplemental-commands/agent-command.ts`
- Test: `packages/webapp/tests/shell/supplemental-commands/agent-command.test.ts` (extend existing)

- [ ] **Step 1: Write the failing test** (append to the existing agent-command test file)

```ts
it('parses --schema-b64 and forwards a decoded schema to the bridge', async () => {
  // Arrange a fake bridge capturing spawn options.
  let captured: any = null;
  (globalThis as any).__slicc_agent = { spawn: async (o: any) => { captured = o; return { finalText: '{}', exitCode: 0 }; } };
  const schema = { type: 'object', properties: { n: { type: 'number' } } };
  const b64 = Buffer.from(JSON.stringify(schema), 'utf8').toString('base64');
  const cmd = createAgentCommand();
  const ctx = await makeAgentCtx(); // existing helper in this test file with a writable cwd
  await cmd.handler(['--schema-b64', b64, '.', '*', 'do it'], ctx);
  expect(captured.structuredOutputSchema).toEqual(schema);
  delete (globalThis as any).__slicc_agent;
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @slicc/webapp -- --run tests/shell/supplemental-commands/agent-command.test.ts`
Expected: FAIL — `captured.structuredOutputSchema` is `undefined`.

- [ ] **Step 3: Implement the flag**

In `agent-command.ts`, add to the `ParsedArgs` interface:
```ts
  structuredOutputSchema?: Record<string, unknown>;
```
In `parseArgs`, add a branch alongside `--model` (before the prompt-slot handling is fine; it follows the same flag rules):
```ts
    if (arg === '--schema-b64') {
      const next = args[i + 1];
      if (next === undefined || next === '' || (next.length > 0 && next.startsWith('-'))) {
        return { help: false, error: 'agent: --schema-b64 requires a value' };
      }
      try {
        const bin = atob(next);
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        const decoded = JSON.parse(new TextDecoder().decode(bytes));
        if (typeof decoded !== 'object' || decoded === null) {
          return { help: false, error: 'agent: --schema-b64 must decode to a JSON object' };
        }
        schemaOut = decoded as Record<string, unknown>;
      } catch {
        return { help: false, error: 'agent: --schema-b64 must be valid base64-encoded JSON' };
      }
      i += 2;
      continue;
    }
```
Add `let schemaOut: Record<string, unknown> | undefined;` near the top of `parseArgs`, and include `structuredOutputSchema: schemaOut` in the returned object. Then in `createAgentCommand`, forward it onto `spawnOptions`:
```ts
    if (parsed.structuredOutputSchema !== undefined) {
      spawnOptions.structuredOutputSchema = parsed.structuredOutputSchema;
    }
```
(Add `structuredOutputSchema?: Record<string, unknown>;` to the local `AgentSpawnOptions` interface in `agent-command.ts`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @slicc/webapp -- --run tests/shell/supplemental-commands/agent-command.test.ts`
Expected: PASS (existing + 1 new).

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/shell/supplemental-commands/agent-command.ts packages/webapp/tests/shell/supplemental-commands/agent-command.test.ts
git commit -m "feat(agent): --schema-b64 flag forwarding a structured-output schema"
```

---

## Task 6: Thread the schema through the bridge + config type

**Files:**
- Modify: `packages/webapp/src/scoops/types.ts`
- Modify: `packages/webapp/src/scoops/agent-bridge.ts`
- Test: `packages/webapp/tests/scoops/agent-bridge.test.ts` (extend existing)

- [ ] **Step 1: Write the failing test** (append to the existing agent-bridge test)

```ts
it('copies structuredOutputSchema from spawn options into scoop.config', async () => {
  // Use the existing test harness's fake orchestrator that captures registerScoop.
  const { bridge, captured } = makeBridgeWithCapture(); // existing/local helper
  const schema = { type: 'object' };
  await bridge.spawn({ cwd: '/workspace', allowedCommands: ['*'], prompt: 'p', structuredOutputSchema: schema });
  expect(captured.scoop.config.structuredOutputSchema).toEqual(schema);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @slicc/webapp -- --run tests/scoops/agent-bridge.test.ts`
Expected: FAIL — `structuredOutputSchema` missing on config.

- [ ] **Step 3: Implement**

In `scoops/types.ts`, add to `ScoopConfig` (the `interface ScoopConfig { ... }` block):
```ts
  /** When set, the scoop is given an ephemeral StructuredOutput tool whose
   *  validated call args become the scoop's return value (workflow agent({schema})). */
  structuredOutputSchema?: Record<string, unknown>;
```
In `scoops/agent-bridge.ts`, add to `AgentSpawnOptions`:
```ts
  /** Forwarded to ScoopConfig: ephemeral StructuredOutput schema. */
  structuredOutputSchema?: Record<string, unknown>;
```
and inside `spawn`, after the `effectiveThinkingLevel` copy into `scoopConfig`:
```ts
    if (options.structuredOutputSchema !== undefined) {
      scoopConfig.structuredOutputSchema = options.structuredOutputSchema;
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @slicc/webapp -- --run tests/scoops/agent-bridge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/scoops/types.ts packages/webapp/src/scoops/agent-bridge.ts packages/webapp/tests/scoops/agent-bridge.test.ts
git commit -m "feat(scoops): thread structuredOutputSchema spawn option -> ScoopConfig"
```

---

## Task 7: StructuredOutput tool injection + capture in `ScoopContext`

**Files:**
- Create: `packages/webapp/src/scoops/structured-output-tool.ts`
- Modify: `packages/webapp/src/scoops/scoop-context.ts`
- Test: `packages/webapp/tests/scoops/structured-output-tool.test.ts`

The pure tool factory is unit-tested directly; the `ScoopContext` wiring is exercised by the Task 8 integration test (constructing a full `ScoopContext` in a unit test is heavy, so we keep this task's test on the pure factory and assert the wiring shape by reading the validated-args capture).

- [ ] **Step 1: Write the failing test**

```ts
// packages/webapp/tests/scoops/structured-output-tool.test.ts
import { describe, expect, it } from 'vitest';
import { createStructuredOutputTool } from '../../../src/scoops/structured-output-tool.js';

describe('structured-output-tool', () => {
  it('exposes the supplied schema as inputSchema and captures args on execute', async () => {
    const capture: { value: unknown } = { value: undefined };
    const tool = createStructuredOutputTool({ type: 'object', properties: { n: { type: 'number' } } }, (v) => { capture.value = v; });
    expect(tool.name).toBe('StructuredOutput');
    expect(tool.inputSchema).toEqual({ type: 'object', properties: { n: { type: 'number' } } });
    const res = await tool.execute({ n: 7 });
    expect(capture.value).toEqual({ n: 7 });
    expect(res.isError).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @slicc/webapp -- --run tests/scoops/structured-output-tool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tool factory**

```ts
// packages/webapp/src/scoops/structured-output-tool.ts
import type { ToolDefinition, ToolInputSchema } from '../core/types.js';

/**
 * An ephemeral tool the workflow gives a scoop when agent({schema}) is used.
 * pi-agent-core validates the call args against `schema` (typebox) before
 * `execute` runs, so by the time we're called the args already match. We just
 * capture them as the scoop's return value.
 */
export function createStructuredOutputTool(
  schema: Record<string, unknown>,
  onCapture: (value: unknown) => void
): ToolDefinition {
  return {
    name: 'StructuredOutput',
    description:
      'Return your final result. Call this exactly once, as your last action. The arguments you pass ARE your return value and must match the required schema.',
    inputSchema: schema as ToolInputSchema,
    async execute(input) {
      onCapture(input);
      return { content: 'Result recorded.' };
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @slicc/webapp -- --run tests/scoops/structured-output-tool.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into `ScoopContext`** (`scoops/scoop-context.ts`)

(a) Add a captured-value field on the class (near other private fields):
```ts
  private structuredOutputValue: unknown = undefined;
  private structuredOutputCaptured = false;
```
(b) At the tool-assembly point (the `const legacyTools = [ ... ]` array, ~line 406), append the tool when configured:
```ts
    const legacyTools = [
      ...createFileTools(gatedFs),
      createBashTool(this.shell),
      ...scoopManagementTools,
    ];
    const soSchema = this.scoop.config?.structuredOutputSchema;
    if (soSchema) {
      const { createStructuredOutputTool } = await import('./structured-output-tool.js');
      legacyTools.push(
        createStructuredOutputTool(soSchema, (v) => {
          this.structuredOutputValue = v;
          this.structuredOutputCaptured = true;
        })
      );
    }
```
(c) Append the instruction to the system prompt. Where `systemPrompt` is built, add (only when `soSchema` is set):
```ts
    const soInstruction = soSchema
      ? '\n\nIMPORTANT: Your final action MUST be a single call to the `StructuredOutput` tool. Its arguments are your return value and must satisfy the required schema. Do not answer in prose.'
      : '';
    // ...append soInstruction to the composed systemPrompt string.
```
(d) Make the scoop's final output the captured value. Where the bridge reads the result, expose a getter:
```ts
  getStructuredOutput(): { captured: boolean; value: unknown } {
    return { captured: this.structuredOutputCaptured, value: this.structuredOutputValue };
  }
```
(e) In `agent-bridge.ts` `spawn`, after `sendPrompt` resolves and before returning, prefer the structured value when a schema was requested:
```ts
    if (scoop.config?.structuredOutputSchema) {
      const so = context.getStructuredOutput?.();
      if (so?.captured) {
        return { finalText: JSON.stringify(so.value), exitCode: 0 };
      }
      // Not called → up to TWO corrective nudges (spec parity), then give up → null (prelude maps exit!=0 to null).
      await orchestrator.sendPrompt(jid, 'You did not call StructuredOutput. Call it now with your result.', 'agent', 'agent');
      const so2 = context.getStructuredOutput?.();
      if (so2?.captured) return { finalText: JSON.stringify(so2.value), exitCode: 0 };
      return { finalText: 'agent: scoop did not produce StructuredOutput', exitCode: 1 };
    }
```
(Obtaining `context` in the bridge: capture the `ScoopContext` from `createScoopTab` — the orchestrator already builds it; expose `orchestrator.getScoopContext(jid)` if not present, or thread it through the existing observe path. Confirm the accessor during implementation; `orchestrator.ts:1894` constructs it.)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck 2>&1 | tail -20`
Expected: no new errors. Fix any signature mismatches (e.g., the `getScoopContext` accessor).

- [ ] **Step 7: Commit**

```bash
git add packages/webapp/src/scoops/structured-output-tool.ts packages/webapp/src/scoops/scoop-context.ts packages/webapp/src/scoops/agent-bridge.ts packages/webapp/tests/scoops/structured-output-tool.test.ts
git commit -m "feat(scoops): StructuredOutput tool injection + capture for agent({schema})"
```

---

## Task 8: End-to-end schema integration + acceptance fixture

**Files:**
- Create: `packages/webapp/tests/shell/supplemental-commands/workflow-acceptance.test.ts`
- Create: `packages/webapp/tests/fixtures/workflows/repo-audit.workflow.js`

- [ ] **Step 1: Write the acceptance fixture** (a self-contained fan-out/verify workflow)

```js
// packages/webapp/tests/fixtures/workflows/repo-audit.workflow.js
export const meta = {
  name: 'repo-audit',
  description: 'Fan out finders over files, verify each finding',
  phases: [{ title: 'Find' }, { title: 'Verify' }],
}
const FILES = args && args.files ? args.files : ['a.ts', 'b.ts']
const BUG_SCHEMA = { type: 'object', properties: { bugs: { type: 'array', items: { type: 'string' } } }, required: ['bugs'] }
const VERDICT = { type: 'object', properties: { real: { type: 'boolean' } }, required: ['real'] }

phase('Find')
const found = await pipeline(
  FILES,
  (file) => agent(`Find bugs in ${file}`, { phase: 'Find', schema: BUG_SCHEMA }),
  (res, file) => parallel((res?.bugs || []).map((b) => () =>
    agent(`Verify bug "${b}" in ${file}`, { phase: 'Verify', schema: VERDICT }).then((v) => ({ file, bug: b, real: !!(v && v.real) }))
  ))
)
const confirmed = found.flat().filter(Boolean).filter((x) => x.real)
log(`confirmed ${confirmed.length}`)
return { confirmed }
```

- [ ] **Step 2: Write the failing test** (mock scoop = deterministic `agent` argv responder honoring `--schema-b64`)

```ts
// packages/webapp/tests/shell/supplemental-commands/workflow-acceptance.test.ts
import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VirtualFS } from '../../../src/fs/index.js';
import { createWorkflowCommand } from '../../../src/shell/supplemental-commands/workflow-command.js';

const fixture = readFileSync(
  fileURLToPath(new URL('../../fixtures/workflows/repo-audit.workflow.js', import.meta.url)),
  'utf8'
);

// Mock the `agent` command: when --schema-b64 is present, return schema-shaped JSON.
function mockSpawn() {
  const concurrentPeak = { n: 0, cur: 0 };
  const spawn = async (argv: string[]) => {
    concurrentPeak.cur++; concurrentPeak.n = Math.max(concurrentPeak.n, concurrentPeak.cur);
    await new Promise((r) => setTimeout(r, 5));
    const hasSchema = argv.includes('--schema-b64');
    const prompt = argv[argv.length - 1];
    let stdout = '';
    if (hasSchema && prompt.startsWith('Find bugs')) stdout = JSON.stringify({ bugs: ['x', 'y'] });
    else if (hasSchema && prompt.startsWith('Verify')) stdout = JSON.stringify({ real: prompt.includes('"x"') });
    concurrentPeak.cur--;
    return { stdout, stderr: '', exitCode: 0 };
  };
  return { spawn, concurrentPeak };
}

describe('workflow acceptance — repo fan-out/verify', () => {
  it('runs the fixture and returns only confirmed findings, bounded by concurrency', async () => {
    const fs = await VirtualFS.create({ dbName: `wfa-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    await fs.writeFile('/workspace/repo-audit.js', fixture);
    const adapter = (await import('../../../src/shell/vfs-adapter.js')).createVfsAdapter(fs);
    const { spawn, concurrentPeak } = mockSpawn();
    const exec = Object.assign(async () => ({ stdout: '', stderr: '', exitCode: 0 }), { spawn });
    const ctx = { fs: adapter, cwd: '/workspace', env: new Map(), stdin: '', exec } as any;

    const res = await createWorkflowCommand().handler(
      ['run', '/workspace/repo-audit.js', '--args', JSON.stringify({ files: ['a.ts', 'b.ts'] }), '--concurrency', '4'],
      ctx
    );

    expect(res.exitCode).toBe(0);
    // Only bug "x" verifies real; two files → two confirmed.
    const parsed = JSON.parse(res.stdout.slice(res.stdout.lastIndexOf('{')));
    expect(parsed.confirmed.map((c: any) => c.bug)).toEqual(['x', 'x']);
    expect(concurrentPeak.n).toBeGreaterThan(1); // genuine overlap
    expect(concurrentPeak.n).toBeLessThanOrEqual(4); // capped
  });
});
```

- [ ] **Step 3: Run it to verify it fails, then passes**

Run: `npm test -w @slicc/webapp -- --run tests/shell/supplemental-commands/workflow-acceptance.test.ts`
Expected first: FAIL (until Tasks 1–4 are merged; the schema decode is exercised end-to-end through the prelude's `--schema-b64`, which the mock honors). Then PASS once the chain works. If the `confirmed` ordering differs, assert on a sorted/length basis instead.

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/tests/shell/supplemental-commands/workflow-acceptance.test.ts packages/webapp/tests/fixtures/workflows/repo-audit.workflow.js
git commit -m "test(workflow): acceptance fixture — repo fan-out/verify with schema + concurrency"
```

---

## Task 9: ~~Extension durability — forward terminal runs to offscreen~~ → REMOVED (codex review)

**This task is obsolete.** The extension side-panel terminal is already a `RemoteTerminalView`
over the **offscreen** `TerminalSessionHost` (`packages/webapp/src/ui/main.ts:976`,
`packages/chrome-extension/src/offscreen.ts`), so a terminal `workflow run` **already executes
in offscreen** — its realm survives a side-panel close with no extra wiring. Do **not** add a
`workflow-run` chrome message or a `runRemote` seam (remove that param from Task 3's command).

**Replacement step (verification only):**
- [ ] In the extension build, run a small workflow from the **side-panel terminal**, close + reopen
  the panel mid-run, and confirm via `ps` / logs that the offscreen realm process kept running
  (process survival). Reading the result after reopen is SP2's job. Record the result in the PR.

<details><summary>Original (obsolete) steps — do not implement</summary>

- [ ] **Step 1: Write the failing test** (the command uses `runRemote` when provided)

```ts
it('uses runRemote when provided (extension side-panel path)', async () => {
  const fs = await VirtualFS.create({ dbName: `wfr-${Math.random()}`, wipe: true });
  await fs.mkdir('/workspace', { recursive: true });
  await fs.writeFile('/workspace/w.js', `export const meta={name:'x',description:'d'}\nreturn 1`);
  let remoteCalled = false;
  const runRemote = async () => { remoteCalled = true; return { stdout: `WF_RESULT1\n`, stderr: '', exitCode: 0 }; };
  const cmd = createWorkflowCommand({ runRemote });
  const res = await cmd.handler(['run', '/workspace/w.js'], await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 })));
  expect(remoteCalled).toBe(true);
  expect(res.stdout).toContain('1');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @slicc/webapp -- --run tests/shell/supplemental-commands/workflow-command.test.ts -t runRemote`
Expected: PASS already if Task 3 shipped the seam — if so, this codifies the contract. If the seam path has a bug, fix the command.

- [ ] **Step 3: Implement the extension wiring**

In `chrome-extension/src/messages.ts`, add a request/response pair mirroring `AGENT_SPAWN_REQUEST_TYPE` (a `WORKFLOW_RUN_REQUEST_TYPE` carrying `{ code, filename }` and returning `{ stdout, stderr, exitCode }`).

In `offscreen-bridge.ts`, handle it by importing `executeJsCode` and running in the offscreen context (which owns the durable realm):
```ts
if (payload.type === WORKFLOW_RUN_REQUEST_TYPE) {
  const ctx = buildOffscreenCommandContext(); // same ctx the offscreen agent shell uses
  const r = await executeJsCode(payload.code, ['workflow', payload.filename], ctx, undefined, { filename: payload.filename });
  sendResponse({ ok: true, result: r });
  return true; // async
}
```

In the side-panel wiring (where `createSupplementalCommands` is constructed for the panel terminal — the extension panel float), pass:
```ts
createWorkflowCommand({
  runRemote: (code, filename) => sendWorkflowRunToOffscreen(code, filename), // chrome.runtime round-trip
})
```
For standalone/offscreen contexts, register `createWorkflowCommand()` with no `runRemote` (runs in place; offscreen is already durable).

- [ ] **Step 4: Build the extension to verify wiring compiles**

Run: `npm run build -w @slicc/chrome-extension 2>&1 | tail -15`
Expected: build succeeds.

- [ ] **Step 5: Manual dual-float check (documented; the hard acceptance gate)**

1. Standalone: `npm run dev`, open the terminal, run `workflow run /workspace/<a small fixture>.js`; confirm it returns the value.
2. Extension: load `dist/extension`, open the side panel terminal, start a workflow that spawns a few `agent()` calls, **close the side panel mid-run, reopen** — confirm via `ps` (or logs) that the offscreen realm process kept running / completed (process survival). Note: reading the final result after reopen is SP2.

Record the result in the PR description.

- [ ] **Step 6: Commit**

```bash
git add packages/chrome-extension/src/messages.ts packages/chrome-extension/src/offscreen-bridge.ts packages/webapp/src/shell/supplemental-commands/index.ts packages/webapp/tests/shell/supplemental-commands/workflow-command.test.ts
git commit -m "feat(workflow): forward side-panel runs to offscreen (survives panel close)"
```

</details>

---

## Task 10: Documentation

**Files:**
- Modify: `docs/shell-reference.md` — add a `workflow` section (subcommand `run`, flags, the API the script may use, the SP1 limitations).
- Modify: `docs/architecture.md` — add a "Workflow Executor" subsystem entry (user-space prelude over `kind:'js'`, `agent()` via the `agent` command, offscreen hosting).
- Modify: root `CLAUDE.md` and `packages/webapp/CLAUDE.md` — one Key-Subsystems line each.
- Modify: `packages/vfs-root/shared/CLAUDE.md` (`/shared/CLAUDE.md`) — agent-facing: the workflow globals (`agent`/`parallel`/`pipeline`/`phase`/`log`/`budget`/`args`), determinism rules, and when to reach for `workflow run`.
- Modify: `README.md` — one line under features if user-facing.

- [ ] **Step 1: Write the docs** (content per the spec §3 API table and §5 architecture). Keep `/shared/CLAUDE.md` practical: a short "Dynamic workflows" section with a 6-line example and the determinism caveats.

- [ ] **Step 2: Lint docs**

Run: `npm run lint 2>&1 | tail -15`
Expected: formatting clean (biome/prettier rewrite), `lint:docs` size limits pass.

- [ ] **Step 3: Commit**

```bash
git add docs/ README.md CLAUDE.md packages/webapp/CLAUDE.md packages/vfs-root/shared/CLAUDE.md
git commit -m "docs(workflow): shell reference, architecture, and agent-facing workflow API"
```

---

## Task 11: Full verification (CI gates)

- [ ] **Step 1: Format + lint**

Run: `npm run lint`
Expected: clean (this is the most common CI failure — do it first).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 3: Tests + coverage**

Run: `npm test` then `npm run test:coverage -w @slicc/webapp 2>&1 | tail -20`
Expected: all pass; coverage at/above the floor in `coverage-thresholds.json` (add tests if a new file dips below).

- [ ] **Step 4: Builds**

Run: `npm run build -w @slicc/webapp && npm run build -w @slicc/chrome-extension`
Expected: both succeed.

- [ ] **Step 5: Commit any fixups, then finish the branch**

Use `superpowers:finishing-a-development-branch` to choose merge/PR. Include the Task 9 manual dual-float result in the PR body.

---

## Self-review notes (for the implementer)

- **Spec coverage:** Tasks 1–4 = executor + command (spec §5/§6/§8/§10); Task 5–8 = schema path (§3/§7) + acceptance (§1/§11); Task 9 = extension durability (§5); Task 10 = docs (§12); Task 11 = verification.
- **Determinism guard** ships in Task 2 even though resume is SP2 — it's the enabler (spec §6).
- **Caps** are in the prelude (spec §5 "Caps"); confirmed acceptable because `agent()` is the only spawn path.
- **Known soft-isolation caveat** (`globalThis` escape) is documented, not fixed — deferred realm-native hardening (spec §13).
- **`budget`** is a non-enforcing stub (`spent()===0`) — spec §6.
- If `orchestrator.getScoopContext(jid)` does not exist, add a minimal accessor in Task 7 step 5 (the context is built at `orchestrator.ts:1894`).
