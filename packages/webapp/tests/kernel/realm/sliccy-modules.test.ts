/**
 * Tests for the `sliccy:` virtual-module scheme + the hard-cut
 * removal of bespoke globals in the JS realm.
 *
 * The realm under test is the in-process factory (no real worker /
 * iframe required); the same `runJsRealm` engine powers production
 * floats so behavior parity is by construction.
 */

import type { CommandContext, FsStat, IFileSystem } from 'just-bash';
import { unsafeBytesFromLatin1 } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { createInProcessJsRealmFactory } from '../../../src/kernel/realm/realm-inprocess.js';
import { executeJsCode } from '../../../src/shell/jsh-executor.js';

function makeFs(files: Record<string, string> = {}): IFileSystem {
  const store = new Map<string, string>(Object.entries(files));
  const fs: IFileSystem = {
    async readFile(p: string): Promise<string> {
      const v = store.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    async readFileBuffer(p: string): Promise<Uint8Array> {
      return new TextEncoder().encode(await fs.readFile(p));
    },
    async writeFile(p: string, c: string | Uint8Array): Promise<void> {
      store.set(p, typeof c === 'string' ? c : new TextDecoder().decode(c));
    },
    async appendFile(p: string, c: string | Uint8Array): Promise<void> {
      store.set(
        p,
        (store.get(p) || '') + (typeof c === 'string' ? c : new TextDecoder().decode(c))
      );
    },
    async exists(p: string): Promise<boolean> {
      return store.has(p);
    },
    async stat(p: string): Promise<FsStat> {
      if (!store.has(p)) throw new Error(`ENOENT: ${p}`);
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: 0o644,
        size: (store.get(p) || '').length,
        mtime: new Date(),
      };
    },
    async mkdir(): Promise<void> {},
    async readdir(): Promise<string[]> {
      return [];
    },
    async rm(p: string): Promise<void> {
      store.delete(p);
    },
    async cp(): Promise<void> {},
    async mv(): Promise<void> {},
    resolvePath(base: string, p: string): string {
      if (p.startsWith('/')) return p;
      if (p === '.') return base;
      return base === '/' ? `/${p}` : `${base}/${p}`;
    },
    getAllPaths(): string[] {
      return [...store.keys()];
    },
    async chmod(): Promise<void> {},
    async symlink(): Promise<void> {},
    async link(): Promise<void> {},
    async readlink(): Promise<string> {
      return '';
    },
    async lstat(p: string): Promise<FsStat> {
      return fs.stat(p);
    },
    async realpath(p: string): Promise<string> {
      return p;
    },
    async utimes(): Promise<void> {},
  };
  return fs;
}

function makeCtx(
  opts: {
    files?: Record<string, string>;
    env?: Record<string, string>;
    exec?: CommandContext['exec'];
  } = {}
): CommandContext {
  const ctx: CommandContext = {
    fs: makeFs(opts.files ?? {}),
    cwd: '/workspace',
    env: new Map<string, string>(Object.entries(opts.env ?? {})),
    stdin: unsafeBytesFromLatin1(''),
  };
  if (opts.exec) ctx.exec = opts.exec;
  return ctx;
}

async function runCode(
  code: string,
  ctx: CommandContext,
  argv: string[] = ['node']
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return executeJsCode(code, argv, ctx, undefined, {
    realmFactory: createInProcessJsRealmFactory(),
  });
}

describe('sliccy: virtual-module scheme', () => {
  it("require('sliccy:exec') returns the exec bridge with .spawn", async () => {
    const calls: Array<{ cmd: string; argv?: string[] }> = [];
    const ctx = makeCtx({
      exec: (async (command, opts: { args?: string[] } = {}) => {
        if (Array.isArray(opts.args)) calls.push({ cmd: command, argv: opts.args });
        else calls.push({ cmd: command });
        return { stdout: `ran:${command}\n`, stderr: '', exitCode: 0 };
      }) as CommandContext['exec'],
    });
    const code = `
      const exec = require('sliccy:exec');
      console.log(typeof exec);
      console.log(typeof exec.spawn);
      const a = await exec('echo hi');
      console.log(a.stdout.trim());
      const b = await exec.spawn(['echo', 'hello']);
      console.log(b.stdout.trim());
    `;
    const out = await runCode(code, ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('function');
    expect(out.stdout).toContain('ran:echo hi');
    expect(out.stdout).toContain('ran:echo');
  });

  it("require('sliccy:time') and require('sliccy:fmt') return working helpers", async () => {
    const code = `
      const time = require('sliccy:time');
      const fmt = require('sliccy:fmt');
      console.log(time.parseDuration('1h'));
      console.log(fmt.trunc('hello world', 8));
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('3600000');
    expect(out.stdout).toContain('hello w…');
  });

  it("require('sliccy:pool') runs bounded concurrency", async () => {
    const code = `
      const pool = require('sliccy:pool');
      const out = await pool(2, [1, 2, 3, 4], async (x) => x * 10);
      console.log(JSON.stringify(out));
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('[10,20,30,40]');
  });

  it("require('sliccy:color') and require('sliccy:cli') expose their surfaces", async () => {
    const code = `
      const color = require('sliccy:color');
      const cli = require('sliccy:cli');
      console.log(typeof color.red);
      console.log(typeof cli.die);
      console.log(typeof cli.out);
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    expect(out.stdout.split('\n').filter(Boolean)).toEqual(['function', 'function', 'function']);
  });

  it("require('sliccy:skill') returns a frozen object with dir/refs/assets/config/token", async () => {
    const code = `
      const skill = require('sliccy:skill');
      console.log(typeof skill);
      console.log(Object.isFrozen(skill));
      console.log(typeof skill.config);
      console.log(typeof skill.token);
      console.log(typeof skill.dir);
    `;
    const out = await runCode(code, makeCtx(), ['node', '/workspace/x.jsh']);
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('object');
    expect(lines[1]).toBe('true');
    expect(lines[2]).toBe('function');
    expect(lines[3]).toBe('function');
    expect(lines[4]).toBe('string');
  });

  it("require('sliccy:http') returns the API-client builder", async () => {
    const code = `
      const http = require('sliccy:http');
      console.log(typeof http.client);
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('function');
  });

  it("require('sliccy:browser'|'usb'|'serial'|'hid') exposes the documented surface", async () => {
    const code = `
      console.log(typeof require('sliccy:browser').findTab);
      console.log(typeof require('sliccy:usb').request);
      console.log(typeof require('sliccy:serial').request);
      console.log(typeof require('sliccy:hid').request);
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    expect(out.stdout.split('\n').filter(Boolean)).toEqual([
      'function',
      'function',
      'function',
      'function',
    ]);
  });

  it("require('sliccy:bogus') throws a scheme-specific error", async () => {
    const code = `
      try { require('sliccy:bogus'); console.log('UNEXPECTED'); }
      catch (e) { console.log(e.message); }
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("unknown sliccy: module 'bogus'");
    expect(out.stdout).toContain("require('sliccy:bogus')");
  });

  it("require('sliccy:') (empty name) throws a scheme-specific error", async () => {
    const code = `
      try { require('sliccy:'); console.log('UNEXPECTED'); }
      catch (e) { console.log(e.message); }
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('empty sliccy: module name');
  });

  it('sliccy: requires never hit the registry / no preload warning', async () => {
    const code = `
      const exec = require('sliccy:exec');
      const time = require('sliccy:time');
      console.log(typeof exec, typeof time);
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain('failed to pre-load');
    expect(out.stderr).not.toContain('sliccy:');
  });
});

describe('require("fs") / require("node:fs") still return the VFS bridge', () => {
  it("require('fs') returns the VFS bridge", async () => {
    const ctx = makeCtx({ files: { '/workspace/data.txt': 'hello vfs' } });
    const code = `
      const fs = require('fs');
      console.log(typeof fs.readFile);
      console.log(await fs.readFile('data.txt'));
    `;
    const out = await runCode(code, ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('function');
    expect(out.stdout).toContain('hello vfs');
  });

  it("require('node:fs') strips prefix and returns the VFS bridge", async () => {
    const ctx = makeCtx({ files: { '/workspace/data.txt': 'hello node' } });
    const code = `
      const fs = require('node:fs');
      console.log(await fs.readFile('data.txt'));
    `;
    const out = await runCode(code, ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('hello node');
  });

  it("require('node:http') still throws the browser-unavailable error", async () => {
    const code = `
      try { require('node:http'); console.log('UNEXPECTED'); }
      catch (e) { console.log(e.message); }
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('not available in the browser');
  });
});

describe('Buffer is reachable through the realm seam in both floats', () => {
  it("require('node:buffer').Buffer round-trips Buffer.from/.toString", async () => {
    const code = `
      const { Buffer } = require('node:buffer');
      console.log(typeof Buffer);
      console.log(typeof Buffer.from);
      console.log(Buffer.from('hi-node').toString());
      console.log(Buffer.from('aGVsbG8=', 'base64').toString());
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('function');
    expect(lines[1]).toBe('function');
    expect(lines[2]).toBe('hi-node');
    expect(lines[3]).toBe('hello');
  });

  it("require('buffer').Buffer (bare) also resolves to a working constructor", async () => {
    const code = `
      const { Buffer } = require('buffer');
      console.log(typeof Buffer);
      console.log(Buffer.from('bare-bare').toString());
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('function');
    expect(lines[1]).toBe('bare-bare');
  });

  it('bare Buffer is a defined global in the realm and Buffer.alloc round-trips', async () => {
    const code = `
      console.log(typeof Buffer);
      console.log(typeof Buffer.from);
      console.log(typeof Buffer.alloc);
      const a = Buffer.alloc(4);
      a[0] = 104; a[1] = 105; a[2] = 33; a[3] = 0;
      console.log(a.toString('utf-8', 0, 3));
      console.log(Buffer.from([0x68, 0x69]).toString());
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('function');
    expect(lines[1]).toBe('function');
    expect(lines[2]).toBe('function');
    expect(lines[3]).toBe('hi!');
    expect(lines[4]).toBe('hi');
  });

  it("bare Buffer and require('node:buffer').Buffer refer to the same constructor", async () => {
    const code = `
      const { Buffer: B } = require('node:buffer');
      console.log(B === Buffer);
      console.log(B.from('x').toString() === Buffer.from('x').toString());
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('true');
    expect(lines[1]).toBe('true');
  });
});

describe('bespoke globals are fully removed from the realm', () => {
  it.each([
    'exec',
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
    'fs',
  ])('a bare reference to %s throws ReferenceError and fails loudly', async (name) => {
    const code = `${name};`;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('not defined');
    expect(out.stderr.toLowerCase()).toContain(name);
  });

  it('typeof bareName === "undefined" still works without ReferenceError', async () => {
    const code = `
      console.log(typeof exec, typeof skill, typeof http, typeof fs, typeof cli, typeof c);
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('undefined undefined undefined undefined undefined undefined');
  });

  it('the bespoke globals are not published on globalThis either', async () => {
    const code = `
      const names = ['exec','skill','http','browser','usb','serial','hid','cli','c','color','time','fmt','pool'];
      const seen = names.filter((n) => typeof globalThis[n] !== 'undefined');
      console.log(JSON.stringify(seen));
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('[]');
  });
});

describe('Node-standard globals + CJS scope vars remain bare', () => {
  it('process / console / fetch / Buffer / globalThis / setTimeout / clearTimeout work bare', async () => {
    const code = `
      console.log(typeof process);
      console.log(typeof console);
      console.log(typeof fetch);
      console.log(typeof Buffer);
      console.log(typeof globalThis);
      console.log(typeof setTimeout);
      console.log(typeof clearTimeout);
    `;
    const out = await runCode(code, makeCtx());
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines.every((l) => l === 'function' || l === 'object')).toBe(true);
  });

  it('CJS scope vars (require / module / exports / __dirname / __filename) are bare', async () => {
    const code = `
      console.log(typeof require);
      console.log(typeof module);
      console.log(typeof exports);
      console.log(typeof __dirname);
      console.log(typeof __filename);
    `;
    const out = await runCode(code, makeCtx(), ['node', '/workspace/scripts/x.jsh']);
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines).toEqual(['function', 'object', 'object', 'string', 'string']);
  });

  it('__dirname is the parent directory of __filename', async () => {
    const code = `console.log(__dirname, '||', __filename);`;
    const out = await runCode(code, makeCtx(), ['node', '/workspace/skills/foo/bar.jsh']);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('/workspace/skills/foo || /workspace/skills/foo/bar.jsh');
  });
});
