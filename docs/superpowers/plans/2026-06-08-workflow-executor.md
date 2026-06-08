# Workflow Executor (SP1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship a blocking `workflow run` shell command that executes a non-nesting, Claude-Code-format dynamic-workflow `.js` to completion via real SLICC scoops, in both the standalone and extension floats.

**Architecture:** No realm fork. The `workflow` command prepends a **user-space JS prelude** (the orchestration globals `agent`/`parallel`/`pipeline`/`phase`/`log`/`budget`/`args`/`workflow`, a determinism guard, full-global suppression, and a concurrency semaphore) to a lightly-transformed user script, then runs it through the **existing** `executeJsCode` → `runInRealm({kind:'js'})`. `agent()` calls the existing `agent` shell command via the realm's `exec.spawn`; the workflow's return value comes back via a **random per-run** stdout sentinel. `{schema}` extends the `agent` command + `AgentBridge` + `ScoopContext` with a forced-by-instruction `StructuredOutput` tool. In the extension, **no forwarding** is needed — the panel terminal is already offscreen-backed (`RemoteTerminalView`→`TerminalSessionHost`), so the realm runs in offscreen and survives a panel close.

**Tech Stack:** TypeScript, just-bash supplemental commands, `kernel/realm/` runner, pi-agent-core/pi-ai (tool validation via `typebox`), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-08-workflow-executor-design.md` (read it first — twice codex-reviewed).

**Conventions confirmed against the codebase:**
- Commands are invoked in tests via **`cmd.execute(args, ctx)`** (see `tests/shell/supplemental-commands/agent-command.test.ts`), with a `createMockCtx(cwd, fsOptions)` helper returning `{ cwd, fs, env: new Map(), stdin: '' }` (+ `exec` where the command needs it).
- `executeJsCode(code, argv, ctx, pmConfig?, {filename})` resolves `pm`/`realmFactory`/`owner` internally (`shell/jsh-executor.ts`); in vitest it uses the in-process realm.
- `agent --read-only <paths>` and `--model <id>` already exist (`agent-command.ts`); SP1 adds `--schema-b64`.
- `orchestrator.getScoopContext(jid)` exists (for Task 7).
- Progress markers are the literal strings `WFPHASE` / `WFLOG`; the result sentinel is a **random per-run token** threaded through `buildWorkflowCode`/`splitSentinel` (no fixed constant in the real path).

**Prep (once):**
```bash
cd /Users/kpauls/projects/adobe/github/slicc/.claude/worktrees/workflow-executor
npm install
npm test -w @slicc/webapp -- --run tests/shell 2>&1 | tail -5   # baseline green
# Re-confirm pi-agent-core exposes afterToolCall (needed by Task 7):
rg -n "afterToolCall" node_modules/@earendil-works/pi-agent-core/dist/*.d.ts | head
```

---

## Task 1: Pure script helpers (`workflow-script.ts`)

**Files:** Create `packages/webapp/src/shell/supplemental-commands/workflow-script.ts`; test `packages/webapp/tests/shell/supplemental-commands/workflow-script.test.ts`.

- [ ] **Step 1 — failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  makeSentinel, parseMetaBanner, stripExports, buildWorkflowCode, splitSentinel,
} from '../../../src/shell/supplemental-commands/workflow-script.js';

describe('workflow-script', () => {
  it('makeSentinel is random per call and prefixed', () => {
    const a = makeSentinel(), b = makeSentinel();
    expect(a).toMatch(/^WF_RESULT_/); expect(a).not.toBe(b);
  });
  it('parses name/description from a pure-literal meta', () => {
    const src = `export const meta = {\n name: 'review',\n description: 'd',\n}\nreturn 1`;
    expect(parseMetaBanner(src)).toEqual({ name: 'review', description: 'd' });
  });
  it('returns nulls when meta absent', () => {
    expect(parseMetaBanner('const x=1; return x')).toEqual({ name: null, description: null });
  });
  it('strips export from declarations', () => {
    expect(stripExports("export const meta = {}\nexport async function f(){}"))
      .toBe('const meta = {}\nasync function f(){}');
  });
  it('builds code: __WF config + prelude + IIFE body + sentinel emit (threaded token)', () => {
    const code = buildWorkflowCode({
      prelude: '/*P*/',
      config: { args: undefined, cap: 4, budget: null, cwd: '/workspace', agentCwd: '/s/scratch/' },
      body: "export const meta = {}\nreturn { ok: true }",
      sentinel: 'WF_RESULT_xyz',
    });
    expect(code).toContain('"cap":4');
    expect(code).not.toContain('sentinel');          // NOT exposed via __WF (anti-spoof)
    expect(code).not.toContain('"args"');            // undefined omitted by JSON.stringify
    expect(code).toContain('/*P*/');
    expect(code).toContain('const __r = await (async () => {');
    expect(code).toContain('const meta = {}');       // export stripped
    expect(code).toContain('console.log("WF_RESULT_xyz" + JSON.stringify(__r ?? null))');  // literal token
  });
  it('does not expose the sentinel to user code (anti-spoof)', () => {
    const code = buildWorkflowCode({ prelude: '', config: { cap: 4, budget: null, cwd: '/', agentCwd: '/s/' }, body: 'return typeof __WF.sentinel', sentinel: 'WF_RESULT_secret' });
    expect(code).not.toContain('WF_RESULT_secret\\"');   // never a JSON value in __WF
  });
  it('splits the sentinel result line from the log (token param)', () => {
    const out = `WFLOG hi\nWF_RESULT_xyz{"ok":true}\n`;
    expect(splitSentinel(out, 'WF_RESULT_xyz')).toEqual({ result: { ok: true }, log: 'WFLOG hi', hadResult: true });
  });
  it('hadResult:false when no sentinel line', () => {
    expect(splitSentinel('logs\n', 'WF_RESULT_xyz')).toEqual({ result: null, log: 'logs', hadResult: false });
  });
});
```

Run: `npm test -w @slicc/webapp -- --run tests/shell/supplemental-commands/workflow-script.test.ts` → FAIL (module missing).

- [ ] **Step 2 — implementation**

```ts
// packages/webapp/src/shell/supplemental-commands/workflow-script.ts
/** Pure helpers for the `workflow` command: meta parse, export strip, code assembly, sentinel split. */

/** Random per-run result token (a user console.log must not be able to spoof the result). */
export function makeSentinel(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  const rnd = g.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `WF_RESULT_${rnd}`;
}

export interface WorkflowConfig {
  args?: unknown;          // omitted (→ undefined in the realm) when absent — matches spec
  cap: number;
  budget: number | null;
  cwd: string;
  agentCwd: string;        // constrained per-run scratch the command mkdir's before launch
  // NOTE: the result sentinel is NOT in __WF (user code could read/mutate it → spoof). It is
  // inlined as a string literal in the emit line by buildWorkflowCode (see below).
}

// Extracts name/description for the banner. `meta` is REQUIRED — Task 3's command errors if
// `name` is absent (CC parity). `meta.phases` titles are display-only and parsed in SP4 (no UI
// in SP1), so we intentionally don't extract them here.
export function parseMetaBanner(src: string): { name: string | null; description: string | null } {
  const block = extractMetaBlock(src);
  if (block === null) return { name: null, description: null };
  return { name: matchStringField(block, 'name'), description: matchStringField(block, 'description') };
}

export function stripExports(src: string): string {
  return src.replace(/\bexport\s+(const|let|var|function|async\s+function|class)\b/g, '$1');
}

export function buildWorkflowCode(opts: {
  prelude: string;
  config: WorkflowConfig;
  body: string;
  sentinel: string;
}): string {
  // The sentinel is inlined as a LITERAL in the emit (NOT placed in __WF) so user code can neither
  // read nor mutate it. JSON.stringify drops `undefined`, so an absent `args` → `__WF.args === undefined`.
  return (
    `const __WF = ${JSON.stringify(opts.config)};\n` +
    `${opts.prelude}\n` +
    `const __r = await (async () => {\n${stripExports(opts.body)}\n})();\n` +
    `console.log(${JSON.stringify(opts.sentinel)} + JSON.stringify(__r ?? null));\n`
  );
}

export function splitSentinel(stdout: string, sentinel: string): { result: unknown; log: string; hadResult: boolean } {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(sentinel)) {
      const log = [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n').replace(/\n+$/, '');
      try { return { result: JSON.parse(lines[i].slice(sentinel.length)), log, hadResult: true }; }
      catch { return { result: null, log, hadResult: true }; }
    }
  }
  return { result: null, log: stdout.replace(/\n+$/, ''), hadResult: false };
}

function extractMetaBlock(src: string): string | null {
  const m = /\bmeta\s*=\s*\{/.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start + 1, i);
  }
  return null;
}

function matchStringField(block: string, field: string): string | null {
  const m = new RegExp(`\\b${field}\\s*:\\s*(['"\\\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(block);
  return m ? m[2] : null;
}
```

Run the test → PASS. **Commit:** `feat(workflow): pure script helpers (meta/transform/random-sentinel)`.

---

## Task 2: The workflow prelude (`workflow-prelude.ts`)

**Files:** Create `packages/webapp/src/shell/supplemental-commands/workflow-prelude.ts`; test `…/workflow-prelude.test.ts`.

The prelude is injected into the realm's AsyncFunction body (globals are named params). The test reproduces that shape with the **full** injected param set and mocks `exec.spawn`.

- [ ] **Step 1 — failing test**

```ts
import { describe, expect, it } from 'vitest';
import { WORKFLOW_PRELUDE } from '../../../src/shell/supplemental-commands/workflow-prelude.js';

// Real realm params (js-realm-shared.ts) stop at `pool`. `__WF` is NOT a realm param — in the
// real flow buildWorkflowCode prepends `const __WF = {…}`. The test appends `__WF` as a trailing
// param purely so the runner can pass the config without prepending it. Same in-scope effect.
const PARAMS = ['fs','process','console','require','module','exports','exec','fetch','skill','http',
  'browser','usb','serial','hid','cli','c','time','fmt','pool','__WF' /* test-only convenience */];
function run(body: string, exec: unknown, wf: unknown, out: string[] = []) {
  const AsyncFn = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (...a: unknown[]) => Promise<unknown>;
  const fn = new AsyncFn(...PARAMS, `"use strict";\n${WORKFLOW_PRELUDE}\n${body}`);
  const con = { log: (s: unknown) => out.push(String(s)) };
  const args = PARAMS.map((p) => p === 'console' ? con : p === 'exec' ? exec : p === '__WF' ? wf : undefined);
  return fn(...args);
}
const WF = { args: { q: 'hi' }, cap: 2, budget: null, cwd: '/workspace', agentCwd: '/s/scratch/', sentinel: 'X' };

describe('workflow-prelude', () => {
  it('agent() spawns via exec.spawn with --read-only + agentCwd and trims text', async () => {
    const calls: string[][] = [];
    const exec = { spawn: async (a: string[]) => { calls.push(a); return { stdout: 'answer\n', stderr: '', exitCode: 0 }; } };
    await run('globalThis.__t = await agent("q");', exec, WF);
    expect((globalThis as any).__t).toBe('answer');
    expect(calls[0]).toEqual(['agent', '--read-only', '/workspace/', '/s/scratch/', '*', 'q']);
  });
  it('agent({schema}) adds --schema-b64 and JSON-parses', async () => {
    const calls: string[][] = [];
    const exec = { spawn: async (a: string[]) => { calls.push(a); return { stdout: '{"n":1}', stderr: '', exitCode: 0 }; } };
    await run('globalThis.__t = await agent("q",{schema:{type:"object"}});', exec, WF);
    expect((globalThis as any).__t).toEqual({ n: 1 });
    expect(calls[0]).toContain('--schema-b64');
  });
  it('agent() → null on non-zero exit', async () => {
    await run('globalThis.__t = await agent("q");', { spawn: async () => ({ stdout: '', stderr: 'x', exitCode: 1 }) }, WF);
    expect((globalThis as any).__t).toBeNull();
  });
  it('suppression: fs/exec/fetch/require/process/skill/http nulled in user scope', async () => {
    await run('globalThis.__s = [fs,exec,fetch,require,process,skill,http].every(v=>v===undefined);',
      { spawn: async () => ({}) }, WF);
    expect((globalThis as any).__s).toBe(true);
  });
  it('parallel swallows non-fatal → null but RETHROWS fatal WorkflowErrors', async () => {
    const exec = { spawn: async () => ({ stdout: 'x', stderr: '', exitCode: 0 }) };
    await run('globalThis.__a = await parallel([()=>agent("a"), ()=>{throw new Error("z")}]);', exec, WF);
    expect((globalThis as any).__a).toEqual(['x', null]);
    // Math.random() throws a fatal WorkflowDeterminismError → parallel must REJECT, not null it:
    await run('globalThis.__b = await parallel([()=>Math.random()]).then(()=>"no",()=>"threw");', exec, WF);
    expect((globalThis as any).__b).toBe('threw');
  });
  it('pipeline streams per-item with (prev,item,index)', async () => {
    await run('globalThis.__p = await pipeline([10,20],(p,it,i)=>p+i,(p)=>p*2);', { spawn: async () => ({}) }, WF);
    expect((globalThis as any).__p).toEqual([20, 42]);
  });
  it('parallel/pipeline reject above 4096 items', async () => {
    await run('globalThis.__e = await parallel(new Array(4097).fill(()=>1)).then(()=>null,(e)=>e.message);', { spawn: async () => ({}) }, WF);
    expect((globalThis as any).__e).toMatch(/4096/);
  });
  it('determinism guard throws for Date.now/Math.random/crypto/performance/timers/new Date; new Date(arg) ok', async () => {
    const chk = (expr: string) => `(()=>{try{${expr};return "no"}catch(e){return "yes"}})()`;
    await run(`globalThis.__d = [${chk('Date.now()')},${chk('Math.random()')},${chk('crypto.randomUUID()')},${chk('performance.now()')},${chk('setTimeout(()=>{},0)')},${chk('new Date()')}]; globalThis.__ok = new Date(0).getTime();`,
      { spawn: async () => ({}) }, WF);
    expect((globalThis as any).__d).toEqual(['yes','yes','yes','yes','yes','yes']);
    expect((globalThis as any).__ok).toBe(0);
  });
  it('args/budget/phase/log', async () => {
    const out: string[] = [];
    await run('phase("Scan"); log("hi"); globalThis.__args = args; globalThis.__rem = budget.remaining();', { spawn: async () => ({}) }, WF, out);
    expect((globalThis as any).__args).toEqual({ q: 'hi' });
    expect((globalThis as any).__rem).toBe(Infinity);
    expect(out.some((l) => l.startsWith('WFPHASEScan'))).toBe(true);
    expect(out.some((l) => l.startsWith('WFLOGhi'))).toBe(true);
  });
});
```

Run → FAIL.

- [ ] **Step 2 — implementation**

```ts
// packages/webapp/src/shell/supplemental-commands/workflow-prelude.ts
/**
 * WORKFLOW_PRELUDE — injected ahead of a Claude-Code workflow inside the kind:'js' realm.
 * Defines the orchestration globals, a determinism guard, full-global suppression, and caps.
 * Realm-injected names in scope: fs/process/console/require/module/exports/exec/fetch/skill/
 * http/browser/usb/serial/hid/cli/c/time/fmt/pool/__WF. See the SP1 spec §5/§6.
 */
export const WORKFLOW_PRELUDE = String.raw`
class WorkflowError extends Error {}
class WorkflowDeterminismError extends WorkflowError {}
class WorkflowAgentCapError extends WorkflowError {}
class WorkflowNestingUnsupportedError extends WorkflowError {}

// determinism guard — capture real globals, then shadow for the user scope (do NOT shadow
// globalThis: it would TDZ-break this prelude, and globalThis.* is reachable anyway = soft caveat).
const __RealDate = globalThis.Date;
const __RealMath = globalThis.Math;
const Date = new Proxy(__RealDate, {
  construct(t, a) { if (a.length === 0) throw new WorkflowDeterminismError('argless new Date() banned — pass time via args'); return new t(...a); },
  get(t, p) { if (p === 'now') return () => { throw new WorkflowDeterminismError('Date.now() banned'); }; const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; },
  apply(t, _s, a) { return t(...a); },
});
const Math = new Proxy(__RealMath, {
  get(t, p) { if (p === 'random') return () => { throw new WorkflowDeterminismError('Math.random() banned — vary by index'); }; const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; },
});
const __det = (w) => () => { throw new WorkflowDeterminismError(w + ' banned (nondeterministic)'); };
const crypto = { getRandomValues: __det('crypto.getRandomValues'), randomUUID: __det('crypto.randomUUID') };
const performance = { now: __det('performance.now') };
const setTimeout = __det('setTimeout'), setInterval = __det('setInterval'), queueMicrotask = __det('queueMicrotask');

// suppression — capture exec.spawn, then null the full injected param set (skill/http re-expose fs/shell/fetch)
const __execSpawn = (typeof exec !== 'undefined' && exec && exec.spawn) ? exec.spawn.bind(exec) : null;
try { exec = fs = fetch = require = process = module = exports = skill = http = browser = usb = serial = hid = cli = c = time = fmt = pool = undefined; } catch (e) {}

const __cwd = __WF.cwd || '/workspace';
const __agentCwd = __WF.agentCwd || __cwd;
const args = __WF.args;

function __b64(s) { const b = new TextEncoder().encode(s); let bin=''; for (let i=0;i<b.length;i++) bin+=String.fromCharCode(b[i]); return btoa(bin); }
function __sem(n){ let active=0; const q=[]; return { async acquire(){ if(active<n){active++;return;} await new Promise(r=>q.push(r)); active++; }, release(){ active--; const r=q.shift(); if(r) r(); } }; }
const __slots = __sem(Math.max(1, __WF.cap | 0));
let __total = 0;

async function agent(prompt, opts) {
  opts = opts || {};
  // opts.phase / opts.label are ACCEPTED but display-only — they group/label progress in the UI,
  // which is SP4. SP1 honors them as no-ops (no execution effect). opts.isolation/agentType: SP6.
  if (__total >= 1000) throw new WorkflowAgentCapError('1000-agent total cap reached');
  __total++;
  await __slots.acquire();
  try {
    if (!__execSpawn) throw new WorkflowError('agent runtime unavailable');
    const flags = [];
    if (opts.model) flags.push('--model', String(opts.model));
    if (opts.schema) flags.push('--schema-b64', __b64(JSON.stringify(opts.schema)));
    const argv = ['agent'].concat(flags, ['--read-only', '/workspace/', __agentCwd, '*', String(prompt)]);
    const r = await __execSpawn(argv);
    if (!r || r.exitCode !== 0) return null;
    const out = String(r.stdout || '').replace(/\n+$/, '');
    return opts.schema ? JSON.parse(out) : out;
  } finally { __slots.release(); }
}

async function parallel(thunks) {
  if (!Array.isArray(thunks) || thunks.some((t) => typeof t !== 'function')) throw new WorkflowError('parallel() expects an array of functions');
  if (thunks.length > 4096) throw new WorkflowError('parallel(): at most 4096 items per call');
  return Promise.all(thunks.map(async (t) => { try { return await t(); } catch (e) { if (e instanceof WorkflowError) throw e; return null; } }));
}
async function pipeline(items, ...stages) {
  if (!Array.isArray(items)) throw new WorkflowError('pipeline() expects an array as its first argument');
  if (items.length > 4096) throw new WorkflowError('pipeline(): at most 4096 items per call');
  return Promise.all(items.map(async (item, index) => {
    let prev = item;
    for (const stage of stages) { try { prev = await stage(prev, item, index); } catch (e) { if (e instanceof WorkflowError) throw e; return null; } }
    return prev;
  }));
}

let __phase = null;
function phase(title) { __phase = String(title); console.log('WFPHASE' + __phase); }
function log(message) { console.log('WFLOG' + String(message)); }
const budget = { total: (__WF.budget == null ? null : __WF.budget), spent() { return 0; }, remaining() { return this.total == null ? Infinity : Math.max(0, this.total - this.spent()); } };
function workflow() { throw new WorkflowNestingUnsupportedError('nested workflow() unsupported in SP1'); }
`;
```

- [ ] **Also add these concrete asserts** (codex spec-tightening):

```ts
it('full suppression: every injected global is nulled in user scope', async () => {
  await run('globalThis.__all = ["fs","exec","fetch","require","process","module","exports","skill","http","browser","usb","serial","hid","cli","c","time","fmt","pool"].map(n=>eval("typeof "+n)).every(t=>t==="undefined");', { spawn: async () => ({}) }, WF);
  expect((globalThis as any).__all).toBe(true);
});
it('1000-agent total cap throws fatal on the 1001st call', async () => {
  const exec = { spawn: async () => ({ stdout: '', stderr: '', exitCode: 0 }) };
  await run('globalThis.__cap = await (async()=>{ for(let i=0;i<1001;i++){ try{ await agent("x") }catch(e){ return "threw@"+i } } return "no" })();', exec, WF);
  expect((globalThis as any).__cap).toBe('threw@1000');
});
it('budget stub: spent()===0; remaining honors total', async () => {
  await run('globalThis.__b = [budget.spent(), budget.remaining()];', { spawn: async () => ({}) }, { ...WF, budget: 5000 });
  expect((globalThis as any).__b).toEqual([0, 5000]);
});
it('pipeline is no-barrier (item 0 reaches stage 2 before item 1 finishes stage 1)', async () => {
  const order: string[] = []; let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  // globalThis is NOT shadowed, so the realm body can reach these test handles:
  (globalThis as any).__gate = gate; (globalThis as any).__order = order; (globalThis as any).__release = release;
  await run(
    'globalThis.__np = await pipeline([0,1],' +
    '  (v,_i,idx)=> idx===1 ? globalThis.__gate.then(()=>"s1-"+idx) : Promise.resolve("s1-"+idx),' +
    '  (p,_i,idx)=>{ globalThis.__order.push("s2-"+idx); if(idx===0) globalThis.__release(); return p; });',
    { spawn: async () => ({}) }, WF);
  expect(order[0]).toBe('s2-0');              // item 0 finished stage 2 while item 1 was still blocked in stage 1
  expect((globalThis as any).__np).toEqual(['s1-0', 's1-1']);
});
```
(Note: the Task-2 *test* injects `__WF` as a param for convenience; in the real flow `buildWorkflowCode` prepends `const __WF = {…}` ahead of the prelude — equivalent in scope. The no-barrier test wires `__g`/`__o`/`__rel` onto the runner globals; adapt to the `run()` helper.)

- [ ] **Step 3 — hardening (apply + test live; cooperative threat model).** The flat prelude above is *trivially* bypassable: because the user body shares the prelude's lexical scope, a script could call `__execSpawn`, read the real `Date`, mutate `__total`, or patch `console.log` to forge the result. SP1's threat model is **cooperative** (the user's own Claude-authored scripts), so this is acceptable in principle — but cheap structural hardening makes the caps/determinism/result robust against the *fixed* script (closes the codex blockers for that model). Implement and verify against the running realm:
  - **Hide privileged internals in an inner IIFE that returns only the public API.** `buildWorkflowCode` should emit roughly: define `WorkflowError` classes + `crypto`/`performance`/timer throwers + a captured `const __emit = console.log.bind(console)` in the **outer** scope; then ``const { agent, parallel, pipeline, phase, log, budget, args, workflow, Date, Math } = (function(){ <PRELUDE: captures `exec.spawn`, nulls the outer IO params, builds Date/Math proxies over locally-captured reals, defines the API> return { agent, parallel, pipeline, phase, log, budget, args, workflow, Date, Math }; })();`` then the user IIFE, then `__emit(<random literal sentinel> + JSON.stringify(__r ?? null))`. The privileged refs (`__execSpawn`, the real `Date`/`Math`, the counters) stay **inside the IIFE** → a fixed script can't name them; `Date`/`Math` reach the user as un-unwrappable Proxies. (`WorkflowError` lives in the outer scope so both the outer throwers and the prelude's `parallel`/`pipeline` rethrow check share the class.)
  - **Result integrity:** the random sentinel is a **literal** in the `__emit(...)` line (never in `__WF`), and `__emit` is the **pre-captured** `console.log` — so user code can neither learn the token nor intercept the emission. Add a test: a body that patches `console.log` and prints `WF_RESULT_…`-looking lines cannot change the parsed result.
  - **Residual (documented non-goal):** `globalThis.*`, `eval`, dynamic `import()` remain reachable — hard enforcement is the realm-native fork (SP6 backlog).

Run → PASS. **Commit:** `feat(workflow): user-space prelude (determinism guard, suppression, caps, fatal rethrow) + IIFE-scope hardening`.

---

## Task 3: The `workflow run` command (`workflow-command.ts`)

**Files:** Create `…/workflow-command.ts`; test `…/workflow-command.test.ts`. Integration uses the in-process realm (vitest) with a mock `exec.spawn`.

- [ ] **Step 1 — failing test**

```ts
import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../../src/fs/index.js';
import { createVfsAdapter } from '../../../src/shell/vfs-adapter.js';
import { createWorkflowCommand } from '../../../src/shell/supplemental-commands/workflow-command.js';

async function ctxWith(fs: VirtualFS, spawn: (a: string[]) => Promise<{stdout:string;stderr:string;exitCode:number}>) {
  const adapter = createVfsAdapter(fs);
  const exec = Object.assign(async () => ({ stdout: '', stderr: '', exitCode: 0 }), { spawn });
  return { fs: adapter, cwd: '/workspace', env: new Map<string, string>(), stdin: '', exec } as any;
}

describe('workflow run', () => {
  it('runs a fan-out workflow and prints the returned value', async () => {
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    await fs.writeFile('/workspace/wf.js',
      `export const meta = { name:'demo', description:'d' }\n` +
      `const xs = await parallel([()=>agent('a'),()=>agent('b')])\n` +
      `return { xs }`);
    const spawn = async (a: string[]) => ({ stdout: a[a.length-1].toUpperCase(), stderr: '', exitCode: 0 });
    const res = await createWorkflowCommand().execute(['run', '/workspace/wf.js'], await ctxWith(fs, spawn));
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('"xs":["A","B"]');
  });
  it('creates the per-run scratch cwd before running', async () => {
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    await fs.writeFile('/workspace/wf.js', `export const meta={name:'x',description:'d'}\nreturn await agent('hi')`);
    const seen: string[] = [];
    const spawn = async (a: string[]) => { seen.push(a[a.indexOf('--read-only')+2] ?? ''); return { stdout:'ok', stderr:'', exitCode:0 }; }; // +1='/workspace/', +2=__agentCwd, +3='*'
    await createWorkflowCommand().execute(['run','/workspace/wf.js'], await ctxWith(fs, spawn));
    // the agentCwd passed to `agent` must exist on the VFS
    expect(await fs.exists(seen[0])).toBe(true);
  });
  it('errors on missing file', async () => {
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    const res = await createWorkflowCommand().execute(['run','/nope.js'], await ctxWith(fs, async () => ({stdout:'',stderr:'',exitCode:0})));
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/not found/i);
  });
  it('surfaces a thrown body as non-zero', async () => {
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    await fs.writeFile('/workspace/boom.js', `export const meta={name:'b',description:'d'}\nthrow new Error('kaboom')`);
    const res = await createWorkflowCommand().execute(['run','/workspace/boom.js'], await ctxWith(fs, async () => ({stdout:'',stderr:'',exitCode:0})));
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/kaboom/);
  });
});
```

Run → FAIL.

- [ ] **Step 2 — implementation**

```ts
// packages/webapp/src/shell/supplemental-commands/workflow-command.ts
import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { createLogger } from '../../core/logger.js';
import { executeJsCode } from '../jsh-executor.js';
import { WORKFLOW_PRELUDE } from './workflow-prelude.js';
import { buildWorkflowCode, makeSentinel, parseMetaBanner, splitSentinel } from './workflow-script.js';

const log = createLogger('workflow-command');

const HELP = `usage: workflow run <file.js> [--args <json>] [--budget <n>] [--concurrency <n>]
       workflow run --script '<inline js>' [...]
Runs a Claude-Code-format dynamic workflow to completion (SP1: blocking, non-nesting).`;

interface Parsed { help?: boolean; error?: string; file?: string; script?: string; args?: unknown; hasArgs?: boolean; budget?: number | null; cap?: number; }

function parse(a: string[]): Parsed {
  if (a[0] !== 'run') return a.length === 0 || a.includes('-h') || a.includes('--help') ? { help: true } : { error: `workflow: unknown subcommand '${a[0]}' (only 'run' in SP1)` };
  const cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 8;
  const maxCap = Math.min(16, Math.max(1, cores - 2));        // spec cap: min(16, cores-2)
  const o: Parsed = { budget: null, cap: Math.min(4, maxCap) }; // default 4, clamped to maxCap (covers low-core)
  for (let i = 1; i < a.length; i++) {
    const t = a[i];
    if (t === '-h' || t === '--help') return { help: true };
    else if (t === '--script') o.script = a[++i];
    else if (t === '--args') { try { o.args = JSON.parse(a[++i] ?? ''); o.hasArgs = true; } catch { return { error: 'workflow: --args must be valid JSON' }; } }
    else if (t === '--budget') { const n = Number(a[++i]); if (!Number.isFinite(n)) return { error: 'workflow: --budget must be a number' }; o.budget = n; }
    else if (t === '--concurrency') { const n = Number(a[++i]); if (!Number.isFinite(n)) return { error: 'workflow: --concurrency must be a number' }; o.cap = Math.min(maxCap, Math.max(1, Math.trunc(n))); }
    else if (t.startsWith('-')) return { error: `workflow: unknown flag '${t}'` };
    else if (o.file === undefined) o.file = t;
    else return { error: 'workflow: too many arguments' };
  }
  if (o.script === undefined && o.file === undefined) return { error: 'workflow: a <file.js> or --script is required' };
  return o;
}

export function createWorkflowCommand(): Command {
  return defineCommand('workflow', async (args, ctx) => {
    const p = parse(args);
    if (p.help) return { stdout: HELP + '\n', stderr: '', exitCode: 0 };
    if (p.error) return { stdout: '', stderr: p.error + '\n', exitCode: 1 };

    let source: string, filename: string;
    if (p.script !== undefined) { source = p.script; filename = '<workflow>'; }
    else {
      const path = ctx.fs.resolvePath(ctx.cwd, p.file!);
      if (!(await ctx.fs.exists(path))) return { stdout: '', stderr: `workflow: file not found: ${p.file}\n`, exitCode: 1 };
      source = await ctx.fs.readFile(path); filename = p.file!;
    }

    const banner = parseMetaBanner(source);
    if (!banner.name) return { stdout: '', stderr: 'workflow: script must export a meta block with a name (and description)\n', exitCode: 1 };
    const runId = makeSentinel().slice('WF_RESULT_'.length, 'WF_RESULT_'.length + 12) || `${Date.now()}`;
    const agentCwd = `/shared/workflow-runs/${runId}/scratch/`;
    await ctx.fs.mkdir(agentCwd, { recursive: true });   // agent rejects a missing cwd → would null every call
    const sentinel = makeSentinel();
    const code = buildWorkflowCode({
      prelude: WORKFLOW_PRELUDE,
      config: { ...(p.hasArgs ? { args: p.args } : {}), cap: p.cap ?? 4, budget: p.budget ?? null, cwd: ctx.cwd, agentCwd },  // NOTE: sentinel passed separately (not in __WF — anti-spoof)
      body: source,
      sentinel,
    });

    let result: { stdout: string; stderr: string; exitCode: number };
    try { result = await executeJsCode(code, ['workflow', filename], ctx, undefined, { filename }); }
    catch (err) { log.error('workflow run failed', err); return { stdout: '', stderr: `workflow: ${err instanceof Error ? err.message : String(err)}\n`, exitCode: 1 }; }

    const { result: value, log: runLog, hadResult } = splitSentinel(result.stdout, sentinel);
    const head = banner.name ? `workflow: ${banner.name}${banner.description ? ' — ' + banner.description : ''}\n` : '';
    const logBlock = runLog ? renderLog(runLog) + '\n' : '';
    if (result.exitCode !== 0 || !hadResult)
      return { stdout: head + logBlock, stderr: result.stderr || (hadResult ? '' : 'workflow: script produced no result\n'), exitCode: result.exitCode || 1 };
    return { stdout: head + logBlock + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n', stderr: result.stderr, exitCode: 0 };
  });
}

function renderLog(raw: string): string {
  return raw.split('\n').map((l) => l.replace(/^WFPHASE/, '▸ ').replace(/^WFLOG/, '· ')).join('\n');
}
```

Run → PASS. **Commit:** `feat(workflow): workflow run command (blocking, mkdir scratch, random sentinel)`.

---

## Task 4: Register the command

**Files:** Modify `shell/supplemental-commands/index.ts`.

- [ ] Add `import { createWorkflowCommand } from './workflow-command.js';` and add `createWorkflowCommand(),` to the array in `createSupplementalCommands` (next to `createNodeCommand()`).
- [ ] Add a smoke test to `workflow-command.test.ts`:
```ts
import { createSupplementalCommands } from '../../../src/shell/supplemental-commands/index.js';
it('is registered', () => { expect(createSupplementalCommands().some((c) => c.name === 'workflow')).toBe(true); });
```
Run → PASS. **Commit:** `feat(workflow): register the workflow command`.

---

## Task 5: `agent --schema-b64` flag

**Files:** Modify `shell/supplemental-commands/agent-command.ts`; extend `tests/shell/supplemental-commands/agent-command.test.ts`.

- [ ] **Step 1 — failing test** (use the file's existing `createMockCtx` + `.execute`, and stub the bridge):
```ts
it('--schema-b64 forwards a decoded schema to the bridge', async () => {
  let captured: any = null;
  (globalThis as any).__slicc_agent = { spawn: async (o: any) => { captured = o; return { finalText: '{}', exitCode: 0 }; } };
  const schema = { type: 'object', properties: { n: { type: 'number' } } };
  const b64 = Buffer.from(JSON.stringify(schema), 'utf8').toString('base64');
  // createMockCtx grants write on the cwd so the bridge is reached:
  await createAgentCommand().execute(['--schema-b64', b64, '.', '*', 'go'], createMockCtx('/home'));
  expect(captured.structuredOutputSchema).toEqual(schema);
  delete (globalThis as any).__slicc_agent;
});
```
Run → FAIL.

- [ ] **Step 2 — implement.** In `parseArgs`: add `let schemaOut: Record<string, unknown> | undefined;` and a branch (alongside `--model`):
```ts
if (arg === '--schema-b64') {
  const next = args[i + 1];
  if (next === undefined || next === '' || (next.length > 0 && next.startsWith('-'))) return { help: false, error: 'agent: --schema-b64 requires a value' };
  try {
    const bin = atob(next);
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    if (typeof decoded !== 'object' || decoded === null) return { help: false, error: 'agent: --schema-b64 must decode to a JSON object' };
    schemaOut = decoded as Record<string, unknown>;
  } catch { return { help: false, error: 'agent: --schema-b64 must be valid base64-encoded JSON' }; }
  i += 2; continue;
}
```
Add `structuredOutputSchema?: Record<string, unknown>` to `ParsedArgs` and the local `AgentSpawnOptions`; return `structuredOutputSchema: schemaOut`; and in `createAgentCommand`, `if (parsed.structuredOutputSchema !== undefined) spawnOptions.structuredOutputSchema = parsed.structuredOutputSchema;`.

Run → PASS. **Commit:** `feat(agent): --schema-b64 flag`.

---

## Task 6: Thread the schema through the bridge + config type

**Files:** Modify `scoops/types.ts`, `scoops/agent-bridge.ts`; extend `tests/scoops/agent-bridge.test.ts`.

- [ ] **Test** (use the test file's existing orchestrator/bridge harness; if none captures the registered scoop, add a minimal fake `orchestrator` with `registerScoop`/`observeScoop`/`sendPrompt`/`unregisterScoop`/`getScoops` that records the scoop):
```ts
it('copies structuredOutputSchema into scoop.config', async () => {
  const schema = { type: 'object' };
  // arrange a bridge over a fake orchestrator that records registerScoop(scoop)…
  await bridge.spawn({ cwd: '/workspace', allowedCommands: ['*'], prompt: 'p', structuredOutputSchema: schema });
  expect(recordedScoop.config.structuredOutputSchema).toEqual(schema);
});
```
- [ ] **Implement.** `scoops/types.ts` → add `structuredOutputSchema?: Record<string, unknown>;` to `ScoopConfig`. `agent-bridge.ts` → add the field to `AgentSpawnOptions` and, after the thinkingLevel copy into `scoopConfig`, `if (options.structuredOutputSchema !== undefined) scoopConfig.structuredOutputSchema = options.structuredOutputSchema;`.

Run → PASS. **Commit:** `feat(scoops): thread structuredOutputSchema → ScoopConfig`.

---

## Task 7: StructuredOutput tool injection + capture in `ScoopContext`

**Files:** Create `scoops/structured-output-tool.ts`; modify `scoops/scoop-context.ts`, `scoops/agent-bridge.ts`; test `tests/scoops/structured-output-tool.test.ts`.

- [ ] **Step 1 — failing test (pure factory):**
```ts
import { createStructuredOutputTool } from '../../../src/scoops/structured-output-tool.js';
it('exposes the schema as inputSchema and captures args on execute', async () => {
  const cap: { v: unknown } = { v: undefined };
  const tool = createStructuredOutputTool({ type: 'object', properties: { n: { type: 'number' } } }, (v) => { cap.v = v; });
  expect(tool.name).toBe('StructuredOutput');
  expect(tool.inputSchema).toEqual({ type: 'object', properties: { n: { type: 'number' } } });
  const r = await tool.execute({ n: 7 });
  expect(cap.v).toEqual({ n: 7 }); expect(r.isError).toBeFalsy();
});
```
- [ ] **Step 2 — factory:**
```ts
// packages/webapp/src/scoops/structured-output-tool.ts
import type { ToolDefinition, ToolInputSchema } from '../core/types.js';
export function createStructuredOutputTool(schema: Record<string, unknown>, onCapture: (v: unknown) => void): ToolDefinition {
  return {
    name: 'StructuredOutput',
    description: 'Return your final result. Call this exactly once, as your last action. Your arguments ARE the return value and must match the required schema.',
    inputSchema: schema as ToolInputSchema,
    async execute(input) { onCapture(input); return { content: 'Result recorded.' }; },
  };
}
```
Run → PASS.

- [ ] **Step 3 — wire `ScoopContext`** (`scoops/scoop-context.ts`). pi auto-validates args against plain JSON Schema via `typebox`, so the tool just captures already-valid args.
  - Add fields: `private structuredOutputValue: unknown; private structuredOutputCaptured = false;` and a getter `getStructuredOutput() { return { captured: this.structuredOutputCaptured, value: this.structuredOutputValue }; }`.
  - At tool assembly (`const legacyTools = [...]`, ~`:406`), when `this.scoop.config?.structuredOutputSchema` is set: `const { createStructuredOutputTool } = await import('./structured-output-tool.js'); legacyTools.push(createStructuredOutputTool(soSchema, (v) => { this.structuredOutputValue = v; this.structuredOutputCaptured = true; }));`
  - Append a system-prompt instruction (only when set): `"\n\nIMPORTANT: your final action MUST be a single call to the StructuredOutput tool; its arguments are your return value and must satisfy the schema. Do not answer in prose."` — concatenated onto the composed system prompt (do **not** globally force `toolChoice`; the scoop must do its read/research work first).
  - Add an `afterToolCall` hook to `new Agent({...})` (`:576`) that records the validated args when `name === 'StructuredOutput'` (defensive backstop in addition to the tool's `execute` capture).
- [ ] **Step 4 — bridge capture + 2 nudges** (`agent-bridge.ts`). Obtain the context via `orchestrator.getScoopContext(jid)` (exists). After `sendPrompt` resolves, when `scoop.config?.structuredOutputSchema`:
```ts
const ctxRef = orchestrator.getScoopContext(jid);
let so = ctxRef?.getStructuredOutput?.();
for (let nudge = 0; nudge < 2 && !so?.captured; nudge++) {
  await orchestrator.sendPrompt(jid, 'You did not call StructuredOutput. Call it now with your result, matching the schema.', 'agent', 'agent');
  so = ctxRef?.getStructuredOutput?.();
}
if (so?.captured) return { finalText: JSON.stringify(so.value), exitCode: 0 };
return { finalText: 'agent: scoop did not produce StructuredOutput', exitCode: 1 };
```
- [ ] **Step 4b — concrete bridge test** (failing first). Drive the 2-nudge logic with a fake orchestrator whose `getScoopContext(jid)` returns a stub `getStructuredOutput()` that flips to `captured` after a set number of `sendPrompt` calls, and count `sendPrompt` invocations:
```ts
function fakeOrch(captureOnPrompt: number) {
  let prompts = 0; const ctx = { getStructuredOutput: () => ({ captured: prompts >= captureOnPrompt, value: { ok: true } }) };
  return { sendPrompt: async () => { prompts++; }, getScoopContext: () => ctx,
    registerScoop: async () => {}, unregisterScoop: async () => {}, observeScoop: () => () => {}, getScoops: () => [],
    get prompts() { return prompts; } } as any;
}
it('returns captured JSON when StructuredOutput is called (no nudge needed)', async () => {
  const orch = fakeOrch(1); const bridge = createAgentBridge(orch, fakeFs, null);
  const r = await bridge.spawn({ cwd: '/workspace', allowedCommands: ['*'], prompt: 'p', structuredOutputSchema: { type: 'object' } });
  expect(r.exitCode).toBe(0); expect(JSON.parse(r.finalText)).toEqual({ ok: true }); expect(orch.prompts).toBe(1);
});
it('nudges up to 2x, then null when never called', async () => {
  const orch = fakeOrch(99); const bridge = createAgentBridge(orch, fakeFs, null);
  const r = await bridge.spawn({ cwd: '/workspace', allowedCommands: ['*'], prompt: 'p', structuredOutputSchema: { type: 'object' } });
  expect(r.exitCode).not.toBe(0); expect(orch.prompts).toBe(3); // initial + 2 nudges
});
```
- [ ] **Step 5 — typecheck** `npm run typecheck` → 0 new errors (fix accessor signatures). **Commit:** `feat(scoops): StructuredOutput injection + capture (instruct + 2 nudges, no forced toolChoice)`.

---

## Task 8: Acceptance — schema fan-out fixture (mock-scoop integration)

**Files:** Create `tests/fixtures/workflows/repo-audit.workflow.js`; test `tests/shell/supplemental-commands/workflow-acceptance.test.ts`. (This proves the *orchestration/wiring*; the **real-scoop, both-floats** acceptance is the manual check in Task 9 — a unit test can't spin real LLM scoops.)

- [ ] **Fixture** — a self-contained fan-out/verify using `pipeline`/`parallel`/`agent({schema})`:
```js
export const meta = { name: 'repo-audit', description: 'Fan out finders, verify each finding', phases: [{title:'Find'},{title:'Verify'}] }
const FILES = (args && args.files) || ['a.ts', 'b.ts']
const BUGS = { type:'object', properties:{ bugs:{ type:'array', items:{type:'string'} } }, required:['bugs'] }
const VERDICT = { type:'object', properties:{ real:{type:'boolean'} }, required:['real'] }
phase('Find')
const found = await pipeline(FILES,
  (file) => agent(`Find bugs in ${file}`, { phase:'Find', schema: BUGS }),
  (res, file) => parallel((res?.bugs || []).map((b) => () =>
    agent(`Verify "${b}" in ${file}`, { phase:'Verify', schema: VERDICT }).then((v) => ({ file, bug: b, real: !!(v && v.real) }))))
)
const confirmed = found.flat().filter(Boolean).filter((x) => x.real)
log(`confirmed ${confirmed.length}`)
return { confirmed }
```
- [ ] **Test** — this is a **wiring** test (the real `agent --schema-b64`→`AgentBridge`→`StructuredOutput` path is covered by Task 7's unit tests + Task 9's e2e). The mock intercepts `exec.spawn` and honors `--schema-b64` by returning schema-shaped JSON. **The fixture must be written into the VFS** (the real `readFileSync` host content → `fs.writeFile`), because `workflow run <path>` reads from the VFS, not the host fs:

```ts
import { readFileSync } from 'node:fs'; import { fileURLToPath } from 'node:url';
const FIXTURE = readFileSync(fileURLToPath(new URL('../../fixtures/workflows/repo-audit.workflow.js', import.meta.url)), 'utf8');
// in the test:
await fs.mkdir('/workspace', { recursive: true });
await fs.writeFile('/workspace/repo-audit.workflow.js', FIXTURE);   // <- into the VFS, not a host path
const peak = { cur: 0, max: 0 };
const spawn = async (a: string[]) => {
  peak.cur++; peak.max = Math.max(peak.max, peak.cur); await Promise.resolve();
  const prompt = a[a.length - 1]; const hasSchema = a.includes('--schema-b64');
  let stdout = '';
  if (hasSchema && prompt.startsWith('Find bugs')) stdout = JSON.stringify({ bugs: ['x', 'y'] });
  else if (hasSchema && prompt.startsWith('Verify')) stdout = JSON.stringify({ real: prompt.includes('"x"') });
  peak.cur--; return { stdout, stderr: '', exitCode: 0 };
};
const res = await createWorkflowCommand().execute(
  ['run', '/workspace/repo-audit.workflow.js', '--args', '{"files":["a.ts","b.ts"]}', '--concurrency', '4'],
  await ctxWith(fs, spawn));
expect(res.exitCode).toBe(0);
const parsed = JSON.parse(res.stdout.trim().split('\n').pop()!);  // the command prints the result as the LAST line
expect(parsed.confirmed.every((c: any) => c.bug === 'x')).toBe(true);  // only "x" verifies real
expect(peak.max).toBeGreaterThan(1); expect(peak.max).toBeLessThanOrEqual(4);
```
Run → PASS. **Commit:** `test(workflow): schema fan-out acceptance fixture (mock-scoop, concurrency-bounded)`.

---

## Task 9: Real-scoop dual-float acceptance (manual/e2e — the spec's hard gate)

No code/proxy. The spec requires the fan-out fixture to run via **real scoops in both floats**, which is inherently an e2e check.

- [ ] **Standalone:** `npm install && npm run dev`; in the terminal run `workflow run packages/webapp/tests/fixtures/workflows/repo-audit.workflow.js --args '{"files":["src/foo.ts"]}'`; confirm real scoops run, the schema path returns validated objects, and a final `{ confirmed }` prints.
- [ ] **Extension:** `npm run build -w @slicc/chrome-extension`, load `dist/extension`; run the same from the **side-panel terminal**; **close + reopen the panel mid-run** and confirm via `ps` (or logs) the offscreen realm process kept running (process-survival). Reading the result after reopen is SP2.
- [ ] Record both results in the PR description.

---

## Task 10: Documentation

**Files:** `docs/shell-reference.md` (the `workflow` command), `docs/architecture.md` (Workflow Executor subsystem), root + `packages/webapp/CLAUDE.md` (Key Subsystems line), `packages/vfs-root/shared/CLAUDE.md` (agent-facing: the workflow API + when to reach for `workflow run`), `README.md` (one line if user-facing).

- [ ] Write the docs per spec §3/§5. Keep `/shared/CLAUDE.md` practical (6-line example + determinism caveats).
- [ ] `npm run lint` → clean (format + `lint:docs` size limits). **Commit:** `docs(workflow): shell reference, architecture, agent-facing API`.

---

## Task 11: Full verification (CI gates)

- [ ] `npm run lint` (do first — most common CI failure).
- [ ] `npm run typecheck` → 0 errors.
- [ ] `npm test` then `npm run test:coverage -w @slicc/webapp` → pass + coverage at/above the floor in `coverage-thresholds.json` (add tests if a new file dips below).
- [ ] `npm run build -w @slicc/webapp && npm run build -w @slicc/chrome-extension` → both succeed.
- [ ] Commit fixups, then `superpowers:finishing-a-development-branch` to choose merge/PR; include the Task 9 manual dual-float result in the PR body.

---

## Self-review

- **Spec coverage:** Tasks 1–4 = executor + command (§5/§6/§8/§10); 5–7 = `{schema}` path (§3/§7); 8 = mock-scoop acceptance fixture, 9 = real-scoop dual-float acceptance (§1/§11); 10 = docs (§12); 11 = gates.
- **No globalThis TDZ** (Task 2 captures real globals, never shadows `globalThis`). **Random sentinel** threaded through Task 1/3. **`agent()`** passes `--read-only /workspace/` + the mkdir'd `__agentCwd`. **`parallel`/`pipeline`** rethrow `WorkflowError`s. **StructuredOutput** = instruct + capture + 2 nudges, **no** forced `toolChoice`. Tests use **`.execute`** + the existing `createMockCtx` pattern. No `runRemote`, no offscreen forwarding (panel terminal is already offscreen-backed).
- **Post-install:** re-confirm `afterToolCall` exists in pi-agent-core (Task 7).
