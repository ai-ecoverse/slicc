import { describe, expect, it } from 'vitest';
import { WORKFLOW_PRELUDE } from '../../../src/shell/supplemental-commands/workflow-prelude.js';

// PARAMS is the AsyncFunction parameter list the prelude is tested against.
// After the m3 globals hard-cut, the real realm only injects the Node-standard
// surface (process, console, require, module, exports, fetch, __dirname,
// __filename) plus the workflow's own `__WF`. The bespoke globals (exec, skill,
// http, browser, usb, serial, hid, cli, c, time, fmt, pool) and bare `fs` are
// no longer realm-provided — they are reached via `require('sliccy:<name>')` /
// `require('fs')`. We keep them in PARAMS here so the prelude's suppression
// chain (which targets the legacy names) is exercised end-to-end without
// turning every assignment into a try/catch read.
const PARAMS = [
  'fs',
  'process',
  'console',
  'require',
  'module',
  'exports',
  'exec',
  'fetch',
  'skill',
  'http',
  'browser',
  'usb',
  'serial',
  'hid',
  'cli',
  'c',
  'time',
  'fmt',
  'pool',
  '__WF' /* test-only convenience */,
];
function run(body: string, exec: unknown, wf: unknown, out: string[] = []) {
  const AsyncFn = Object.getPrototypeOf(async () => {}).constructor as new (
    ...a: string[]
  ) => (...a: unknown[]) => Promise<unknown>;
  const fn = new AsyncFn(...PARAMS, `"use strict";\n${WORKFLOW_PRELUDE}\n${body}`);
  // Mirror the real realm console (js-realm-shared.ts): log + warn + error.
  const con = {
    log: (s: unknown) => out.push(String(s)),
    warn: (s: unknown) => out.push(String(s)),
    error: (s: unknown) => out.push(String(s)),
  };
  const args = PARAMS.map((p) =>
    p === 'console' ? con : p === 'exec' ? exec : p === '__WF' ? wf : undefined
  );
  return fn(...args);
}
const WF = {
  args: { q: 'hi' },
  cap: 2,
  budget: null,
  cwd: '/workspace',
  agentCwd: '/s/scratch/',
  sentinel: 'X',
};

describe('workflow-prelude', () => {
  it('agent() spawns via exec.spawn with --read-only + agentCwd and trims text', async () => {
    const calls: string[][] = [];
    const exec = {
      spawn: async (a: string[]) => {
        calls.push(a);
        return { stdout: 'answer\n', stderr: '', exitCode: 0 };
      },
    };
    await run('globalThis.__t = await agent("q");', exec, WF);
    expect((globalThis as any).__t).toBe('answer');
    expect(calls[0]).toEqual(['agent', '--read-only', '/workspace/', '/s/scratch/', '*', 'q']);
  });
  it('agent({schema}) adds --schema-b64 and JSON-parses', async () => {
    const calls: string[][] = [];
    const exec = {
      spawn: async (a: string[]) => {
        calls.push(a);
        return { stdout: '{"n":1}', stderr: '', exitCode: 0 };
      },
    };
    await run('globalThis.__t = await agent("q",{schema:{type:"object"}});', exec, WF);
    expect((globalThis as any).__t).toEqual({ n: 1 });
    expect(calls[0]).toContain('--schema-b64');
  });
  it('agent() → null on non-zero exit, and logs the subagent stderr breadcrumb', async () => {
    const out: string[] = [];
    await run(
      'globalThis.__t = await agent("q");',
      { spawn: async () => ({ stdout: '', stderr: 'boom-detail', exitCode: 1 }) },
      WF,
      out
    );
    expect((globalThis as any).__t).toBeNull();
    // The real failure must be surfaced (not silently dropped) before returning null.
    expect(out.some((l) => l.includes('agent: subagent failed') && l.includes('boom-detail'))).toBe(
      true
    );
  });
  it('suppression: fs/exec/fetch/require/process/skill/http nulled in user scope', async () => {
    await run(
      'globalThis.__s = [fs,exec,fetch,require,process,skill,http].every(v=>v===undefined);',
      { spawn: async () => ({}) },
      WF
    );
    expect((globalThis as any).__s).toBe(true);
  });
  it('parallel swallows non-fatal → null but RETHROWS fatal WorkflowErrors', async () => {
    const exec = { spawn: async () => ({ stdout: 'x', stderr: '', exitCode: 0 }) };
    await run(
      'globalThis.__a = await parallel([()=>agent("a"), ()=>{throw new Error("z")}]);',
      exec,
      WF
    );
    expect((globalThis as any).__a).toEqual(['x', null]);
    // Math.random() throws a fatal WorkflowDeterminismError → parallel must REJECT, not null it:
    await run(
      'globalThis.__b = await parallel([()=>Math.random()]).then(()=>"no",()=>"threw");',
      exec,
      WF
    );
    expect((globalThis as any).__b).toBe('threw');
  });
  it('pipeline streams per-item with (prev,item,index)', async () => {
    await run(
      'globalThis.__p = await pipeline([10,20],(p,it,i)=>p+i,(p)=>p*2);',
      { spawn: async () => ({}) },
      WF
    );
    expect((globalThis as any).__p).toEqual([20, 42]);
  });
  it('parallel/pipeline reject above 4096 items', async () => {
    await run(
      'globalThis.__e = await parallel(new Array(4097).fill(()=>1)).then(()=>null,(e)=>e.message);',
      { spawn: async () => ({}) },
      WF
    );
    expect((globalThis as any).__e).toMatch(/4096/);
  });
  it('determinism guard throws for Date.now/Math.random/crypto/performance/timers/new Date/Date(); new Date(arg) ok', async () => {
    const chk = (expr: string) => `(()=>{try{${expr};return "no"}catch(e){return "yes"}})()`;
    await run(
      `globalThis.__d = [${chk('Date.now()')},${chk('Math.random()')},${chk('crypto.randomUUID()')},${chk('performance.now()')},${chk('setTimeout(()=>{},0)')},${chk('new Date()')},${chk('Date()')}]; globalThis.__ok = new Date(0).getTime();`,
      { spawn: async () => ({}) },
      WF
    );
    expect((globalThis as any).__d).toEqual(['yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes']);
    expect((globalThis as any).__ok).toBe(0);
  });
  it('args/budget/phase/log', async () => {
    const out: string[] = [];
    await run(
      'phase("Scan"); log("hi"); globalThis.__args = args; globalThis.__rem = budget.remaining();',
      { spawn: async () => ({}) },
      WF,
      out
    );
    expect((globalThis as any).__args).toEqual({ q: 'hi' });
    expect((globalThis as any).__rem).toBe(Infinity);
    expect(out.some((l) => l.startsWith('WFPHASEScan'))).toBe(true);
    expect(out.some((l) => l.startsWith('WFLOGhi'))).toBe(true);
  });
  it('full suppression: every injected global is nulled in user scope', async () => {
    await run(
      'globalThis.__all = ["fs","exec","fetch","require","process","module","exports","skill","http","browser","usb","serial","hid","cli","c","time","fmt","pool"].map(n=>eval("typeof "+n)).every(t=>t==="undefined");',
      { spawn: async () => ({}) },
      WF
    );
    expect((globalThis as any).__all).toBe(true);
  });
  it('1000-agent total cap throws fatal on the 1001st call', async () => {
    const exec = { spawn: async () => ({ stdout: '', stderr: '', exitCode: 0 }) };
    await run(
      'globalThis.__cap = await (async()=>{ for(let i=0;i<1001;i++){ try{ await agent("x") }catch(e){ return "threw@"+i } } return "no" })();',
      exec,
      WF
    );
    expect((globalThis as any).__cap).toBe('threw@1000');
  });
  it('budget stub: spent()===0; remaining honors total', async () => {
    await run(
      'globalThis.__b = [budget.spent(), budget.remaining()];',
      { spawn: async () => ({}) },
      { ...WF, budget: 5000 }
    );
    expect((globalThis as any).__b).toEqual([0, 5000]);
  });
  it('pipeline is no-barrier (item 0 reaches stage 2 before item 1 finishes stage 1)', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // globalThis is NOT shadowed, so the realm body can reach these test handles:
    (globalThis as any).__gate = gate;
    (globalThis as any).__order = order;
    (globalThis as any).__release = release;
    await run(
      'globalThis.__np = await pipeline([0,1],' +
        '  (v,_i,idx)=> idx===1 ? globalThis.__gate.then(()=>"s1-"+idx) : Promise.resolve("s1-"+idx),' +
        '  (p,_i,idx)=>{ globalThis.__order.push("s2-"+idx); if(idx===0) globalThis.__release(); return p; });',
      { spawn: async () => ({}) },
      WF
    );
    expect(order[0]).toBe('s2-0'); // item 0 finished stage 2 while item 1 was still blocked in stage 1
    expect((globalThis as any).__np).toEqual(['s1-0', 's1-1']);
  });
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
});
