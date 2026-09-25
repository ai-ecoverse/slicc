/**
 * Node programs get Node's fs: trailing callbacks run, `util.promisify` works,
 * and `stat` results have methods. The documented promise API (no callback,
 * boolean stat fields) is unchanged. Before, `fs.readdir(dir, cb)` never
 * called back and the program ended with exit 0 having done nothing.
 */

import { describe, expect, it } from 'vitest';
import { makeCtx, runCode } from './cjs-realm-harness.js';

describe('realm fs: Node callbacks and fs.promises', () => {
  const files = { '/workspace/d/a.txt': 'hello', '/workspace/d/b.txt': 'bye' };

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
    expect(out.stdout).toBe('null a.txt,b.txt\nnull hello\nENOENT\n');
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
    expect(out.stdout).toBe('true 2\n');
  });

  it('keeps the documented promise API without a callback', async () => {
    const out = await runCode(
      `const fs = require('fs');
       const st = await fs.stat('/workspace/d');
       console.log(st.isDirectory, st.isFile, await fs.exists('/workspace/d/a.txt'));`,
      makeCtx({ files })
    );
    expect(out.stdout).toBe('true false true\n');
  });
});
