/**
 * Node programs get Node's fs: trailing callbacks run, `util.promisify` works,
 * and `stat` results have methods. The documented promise API (no callback,
 * boolean stat fields) is unchanged. Before, `fs.readdir(dir, cb)` never
 * called back and the program ended with exit 0 having done nothing.
 */

import { describe, expect, it } from 'vitest';
import { nodeReadFileArgs } from '../../../src/kernel/realm/realm-fs-node-callbacks.js';
import { makeCtx, runCode } from './cjs-realm-harness.js';

describe('nodeReadFileArgs', () => {
  it('injects null encoding when Node omits it so the bridge returns a Buffer', () => {
    expect(nodeReadFileArgs(['/p'])).toEqual(['/p', null]);
    expect(nodeReadFileArgs(['/p', undefined])).toEqual(['/p', null]);
    expect(nodeReadFileArgs(['/p', 'utf8'])).toEqual(['/p', 'utf8']);
    expect(nodeReadFileArgs(['/p', null])).toEqual(['/p', null]);
    expect(nodeReadFileArgs(['/p', { flag: 'r' }])).toEqual(['/p', { flag: 'r', encoding: null }]);
    expect(nodeReadFileArgs(['/p', { encoding: 'utf8' }])).toEqual(['/p', { encoding: 'utf8' }]);
  });
});

describe('realm fs: Node callbacks and fs.promises', () => {
  const files: Record<string, string | Uint8Array> = {
    '/workspace/d/a.txt': 'hello',
    '/workspace/d/b.txt': 'bye',
    // Non-UTF-8 bytes: a text default would mangle 0xff.
    '/workspace/d/bin.dat': new Uint8Array([0x00, 0xff, 0x80, 0x41]),
  };

  it('runs a trailing callback with (err, result)', async () => {
    const out = await runCode(
      `const fs = require('fs');
       fs.readdir('/workspace/d', (err, names) => {
         console.log(err, names.sort().join(','));
         fs.readFile('/workspace/d/a.txt', 'utf8', (err2, text) => console.log(err2, text));
         fs.readFile('/workspace/missing', (err3) => console.log(err3 && err3.code));
       });`,
      makeCtx({ files })
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('null a.txt,b.txt,bin.dat\nnull hello\nENOENT\n');
  });

  it('defaults Node readFile(path, cb) / fs.promises.readFile(path) to Buffer', async () => {
    const out = await runCode(
      `const fs = require('fs');
       fs.readFile('/workspace/d/bin.dat', (err, buf) => {
         console.log(Buffer.isBuffer(buf), buf.length, buf[0], buf[1], buf[2], buf[3]);
         fs.promises.readFile('/workspace/d/bin.dat').then((b) => {
           console.log(Buffer.isBuffer(b), b.readUInt8(1), b.slice(3).toString('utf8'));
         });
       });`,
      makeCtx({ files })
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('true 4 0 255 128 65\ntrue 255 A\n');
  });

  it('gives stat callbacks and util.promisify a Stats with methods', async () => {
    const out = await runCode(
      `const fs = require('fs'); const util = require('util');
       const st = await util.promisify(fs.stat)('/workspace/d');
       console.log(st.isDirectory(), st.isFile());
       fs.stat('/workspace/d/a.txt', (err, s) => console.log(s.isFile(), s.size));
       fs.exists('/workspace/d/a.txt', (yes) => console.log('exists', yes));`,
      makeCtx({ files })
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('true false\ntrue 5\nexists true\n');
  });

  it("makes fs.promises Node's", async () => {
    const out = await runCode(
      `const fs = require('fs');
       const st = await fs.promises.stat('/workspace/d');
       console.log(st.isDirectory(), (await fs.promises.readdir('/workspace/d')).length);`,
      makeCtx({ files })
    );
    expect(out.stdout).toBe('true 3\n');
  });

  it('keeps the documented promise API without a callback', async () => {
    const out = await runCode(
      `const fs = require('fs');
       const st = await fs.stat('/workspace/d');
       const text = await fs.readFile('/workspace/d/a.txt');
       console.log(st.isDirectory, st.isFile, await fs.exists('/workspace/d/a.txt'), typeof text, text);`,
      makeCtx({ files })
    );
    expect(out.stdout).toBe('true false true string hello\n');
  });
});
