// packages/webapp/src/shell/supplemental-commands/workflow-prelude.ts
/**
 * WORKFLOW_PRELUDE — injected ahead of a Claude-Code workflow inside the kind:'js' realm.
 * Defines the orchestration globals, a determinism guard, full-global suppression, and caps.
 *
 * Post m3 globals hard-cut: the realm only injects the Node-standard surface
 * (process/console/require/module/exports/fetch/__dirname/__filename) plus `__WF`.
 * The capability bridges (exec, agent, skill, http, browser, usb, serial, hid, cli,
 * color, time, fmt, pool) and the VFS bridge (fs) reach the workflow via
 * `require('sliccy:<name>')` / `require('fs')`. The `agent()` orchestrator reads
 * `exec.spawn` via the `sliccy:exec` module; the legacy bare-`exec` lookup is kept
 * so the prelude unit test (which builds its own AsyncFunction with `exec` in the
 * param list) keeps exercising the same code path.
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
  apply() { throw new WorkflowDeterminismError('Date() as a function is banned (nondeterministic) — use new Date(arg)'); },
});
const Math = new Proxy(__RealMath, {
  get(t, p) { if (p === 'random') return () => { throw new WorkflowDeterminismError('Math.random() banned — vary by index'); }; const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; },
});
const __det = (w) => () => { throw new WorkflowDeterminismError(w + ' banned (nondeterministic)'); };
const crypto = { getRandomValues: __det('crypto.getRandomValues'), randomUUID: __det('crypto.randomUUID') };
const performance = { now: __det('performance.now') };
const setTimeout = __det('setTimeout'), setInterval = __det('setInterval'), queueMicrotask = __det('queueMicrotask');

// suppression — capture exec.spawn (bare global in legacy float, sliccy:exec
// elsewhere), then null every injected name we can reach. The per-chain
// try/catch swallows the strict-mode ReferenceError when a name isn't declared.
const __execSpawn = (function () {
  try { if (typeof exec !== 'undefined' && exec && exec.spawn) return exec.spawn.bind(exec); } catch (e) {}
  try { var __sx = require('sliccy:exec'); if (__sx && __sx.spawn) return __sx.spawn.bind(__sx); } catch (e) {}
  return null;
})();
try { require = module = exports = process = fetch = undefined; } catch (e) {}
try { exec = fs = skill = http = browser = usb = serial = hid = cli = c = time = fmt = pool = undefined; } catch (e) {}

const __cwd = __WF.cwd || '/workspace';
const __agentCwd = __WF.agentCwd || __cwd;
const args = __WF.args;

function __b64(s) { const b = new TextEncoder().encode(s); let bin=''; for (let i=0;i<b.length;i++) bin+=String.fromCharCode(b[i]); return btoa(bin); }
function __sem(n){ let active=0; const q=[]; return { async acquire(){ if(active<n){active++;return;} await new Promise(r=>q.push(r)); active++; }, release(){ active--; const r=q.shift(); if(r) r(); } }; }
const __slots = __sem(Math.max(1, __WF.cap | 0));
let __total = 0;

async function agent(prompt, opts) {
  opts = opts || {};
  // Recognized opts: model (→ --model), thinking (→ --thinking <level>: off|minimal|low|medium|
  // high|xhigh; invalid is the agent command's own error → failed subagent → null), schema (→ a
  // StructuredOutput contract; result is JSON-parsed). phase/label are ACCEPTED but display-only
  // (SP4 progress grouping). isolation/agentType: SP6.
  if (__total >= 1000) throw new WorkflowAgentCapError('1000-agent total cap reached');
  __total++;
  await __slots.acquire();
  try {
    if (!__execSpawn) throw new WorkflowError('agent runtime unavailable');
    const flags = [];
    if (opts.model) flags.push('--model', String(opts.model));
    if (opts.thinking) flags.push('--thinking', String(opts.thinking));
    if (opts.schema) flags.push('--schema-b64', __b64(JSON.stringify(opts.schema)));
    const argv = ['agent'].concat(flags, ['--read-only', '/workspace/', __agentCwd, '*', String(prompt)]);
    const r = await __execSpawn(argv);
    if (!r || r.exitCode !== 0) {
      // Surface the subagent's real failure (bad model, 5xx, scoop error) before
      // degrading to null, so parallel/pipeline collapsing it stays debuggable.
      if (r && r.stderr) console.error('agent: subagent failed: ' + String(r.stderr).slice(0, 200));
      return null;
    }
    const out = String(r.stdout || '').replace(/\n+$/, '');
    if (!opts.schema) return out;
    try { return JSON.parse(out); } catch (e) { console.error('agent: schema response was not valid JSON: ' + out.slice(0, 120)); return null; }
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

function __wfProgress(kind, text) {
  if (__execSpawn) {
    try {
      const __p = __execSpawn(['__wf_progress', kind, String(text)]);
      // Fire-and-forget: swallow async rejection too (e.g. realm disposed mid-flight),
      // not just a sync throw — otherwise it surfaces as an unhandled rejection.
      if (__p && typeof __p.then === 'function') __p.then(undefined, function () {});
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
const budget = { total: (__WF.budget == null ? null : __WF.budget), spent() { return 0; }, remaining() { return this.total == null ? Infinity : Math.max(0, this.total - this.spent()); } };
function workflow() { throw new WorkflowNestingUnsupportedError('nested workflow() unsupported in SP1'); }
`;
