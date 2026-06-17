/**
 * ESM access path for the `sliccy:` capability scheme and the `node:` / bare
 * `fs` built-ins (esm-schemes-and-sliccy, M5; VAL-ESM-009/010, VAL-GLOBALS-007).
 *
 * The wiring (entry transpile lowering `import ... from 'sliccy:'`/`node:`/`fs`
 * to `require(...)`, served by the realm's synchronous require shim) is shared
 * host-side, so these in-process realm cases prove the static (default / named
 * / namespace) and dynamic `import` forms resolve the SAME bridges as
 * `require`, with no registry/CDN lookup. The harness drives the same
 * `runJsRealm` engine the production worker/iframe floats run.
 */

import type { CommandContext } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { makeCtx, runCode } from './cjs-realm-harness.js';

/** An `exec` ctx that echoes back the `echo <text>` payload (no shell parse). */
function echoExec(): CommandContext['exec'] {
  return (async (command: string) => ({
    stdout: `${command.replace(/^echo\s+/, '')}\n`,
    stderr: '',
    exitCode: 0,
  })) as CommandContext['exec'];
}

describe('VAL-ESM-009 / VAL-GLOBALS-007: sliccy: capabilities are importable via ESM', () => {
  it('static default import of sliccy:exec resolves the callable bridge and runs', async () => {
    const code = `
      import exec from 'sliccy:exec';
      console.log(typeof exec);
      const r = await exec('echo esm-exec');
      console.log(r.stdout.trim());
    `;
    const out = await runCode(code, makeCtx({ exec: echoExec() }));
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('function');
    expect(lines[1]).toBe('esm-exec');
  });

  it('static named import { exec } / { spawn } from sliccy:exec resolves the bridge members', async () => {
    const code = `
      import { exec, spawn } from 'sliccy:exec';
      console.log(typeof exec, typeof spawn);
      const r = await exec('echo named-exec');
      console.log(r.stdout.trim());
    `;
    const out = await runCode(code, makeCtx({ exec: echoExec() }));
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('function function');
    expect(lines[1]).toBe('named-exec');
  });

  it('namespace import * as fmt from sliccy:fmt exposes working helpers', async () => {
    const code = `
      import * as fmt from 'sliccy:fmt';
      console.log(typeof fmt.trunc);
      console.log(fmt.trunc('hello world', 8));
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('function');
    expect(lines[1]).toBe('hello w…');
  });

  it('default import of sliccy:time matches require() (same parseDuration)', async () => {
    const code = `
      import time from 'sliccy:time';
      const req = require('sliccy:time');
      console.log(time.parseDuration('1h'));
      console.log(time.parseDuration('1h') === req.parseDuration('1h'));
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('3600000');
    expect(lines[1]).toBe('true');
  });

  it('dynamic import() of sliccy:fmt / sliccy:http resolves the bridge', async () => {
    const code = `
      const fmt = await import('sliccy:fmt');
      console.log(typeof (fmt.default?.trunc ?? fmt.trunc));
      const http = await import('sliccy:http');
      console.log(typeof (http.default ?? http).client);
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('function');
    expect(lines[1]).toBe('function');
  });

  it('dynamic import of an unknown sliccy: name throws the scheme error, not an install hint', async () => {
    const code = `
      try {
        await import('sliccy:bogus');
        console.log('UNEXPECTED');
      } catch (e) {
        console.log(e.message);
      }
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("unknown sliccy: module 'bogus'");
    expect(out.stdout).not.toContain('run: ipk install');
  });

  it('static import of an unknown sliccy: name fails loudly with the scheme error', async () => {
    const code = `
      import bogus from 'sliccy:bogus';
      console.log('UNEXPECTED', bogus);
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).not.toBe(0);
    expect(out.stdout).not.toContain('UNEXPECTED');
    expect(out.stderr).toContain("unknown sliccy: module 'bogus'");
    expect(out.stderr).not.toContain('run: ipk install');
  });
});

describe('VAL-ESM-010: node: and bare fs imports return the built-in / VFS bridges via ESM', () => {
  it('import fs from "node:fs" returns the VFS bridge and round-trips content', async () => {
    const code = `
      import fs from 'node:fs';
      console.log(typeof fs.readFile);
      await fs.writeFile('val-node.txt', 'hi-node-esm');
      console.log(await fs.readFile('val-node.txt'));
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('function');
    expect(lines[1]).toBe('hi-node-esm');
  });

  it('import { Buffer } from "node:buffer" resolves the built-in', async () => {
    const code = `
      import { Buffer } from 'node:buffer';
      console.log(typeof Buffer.from, Buffer.from('x').length);
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('function 1');
  });

  it('import fs from "fs" (bare, back-compat) returns the VFS bridge', async () => {
    const code = `
      import fs from 'fs';
      console.log(typeof fs.readFile);
      await fs.writeFile('val-bare.txt', 'hi-bare-esm');
      console.log(await fs.readFile('val-bare.txt'));
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('function');
    expect(lines[1]).toBe('hi-bare-esm');
  });

  it('node:fs ESM import and require("fs") back the same VFS store', async () => {
    const code = `
      import fs from 'node:fs';
      const reqFs = require('fs');
      await fs.writeFile('shared.txt', 'cross-bridge');
      console.log(await reqFs.readFile('shared.txt'));
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('cross-bridge');
  });
});
