/**
 * The "node can't read stdin" idioms: `fs.readFileSync(0)` /
 * `fs.writeFileSync(1|2, …)`, the `/dev/stdin|stdout|stderr` device paths,
 * `require('readline')` (+ `readline/promises`), and Node-parity
 * `process.stdin.read()` → `null` on empty input.
 *
 * Drives the same in-process `runJsRealm` engine the worker/iframe floats
 * use (behavior parity by construction), with piped stdin threaded exactly
 * like the AlmostBashShell exec pipeline threads it (latin1 `ByteString`).
 */

import { describe, expect, it } from 'vitest';
import { makeCtx, runCode } from './cjs-realm-harness.js';

describe('fs fd support: readFileSync(0) / writeFileSync(1|2)', () => {
  it('readFileSync(0, "utf8") returns the full buffered stdin as text', async () => {
    const ctx = makeCtx({ stdin: 'hello from a pipe\n' });
    const out = await runCode(
      `const fs = require('fs'); process.stdout.write(fs.readFileSync(0, 'utf8'));`,
      ctx
    );
    expect(out.stderr).toBe('');
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('hello from a pipe\n');
  });

  it('readFileSync(0) with no encoding returns bytes (binary-preserving)', async () => {
    // Latin1-threaded binary: one JS char per byte, incl. 0x00 and >0x7f.
    const bytes = String.fromCharCode(0x00, 0xff, 0x7f, 0x80, 0xc3, 0xa9);
    const ctx = makeCtx({ stdin: bytes });
    const out = await runCode(
      `const fs = require('fs');
       const data = fs.readFileSync(0);
       console.log(Array.from(data).join(','));`,
      ctx
    );
    expect(out.stderr).toBe('');
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('0,255,127,128,195,169');
  });

  it('readFileSync(0) does NOT consume process.stdin (separable buffer)', async () => {
    const ctx = makeCtx({ stdin: 'shared' });
    const out = await runCode(
      `const fs = require('fs');
       const viaFd = fs.readFileSync(0, 'utf8');
       const viaStdin = process.stdin.read();
       console.log(JSON.stringify({ viaFd, viaStdin }));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout.trim())).toEqual({ viaFd: 'shared', viaStdin: 'shared' });
  });

  it('writeFileSync(1) lands on stdout and writeFileSync(2) on stderr', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const fs = require('fs');
       fs.writeFileSync(1, 'to-stdout\\n');
       fs.writeFileSync(2, 'to-stderr\\n');`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('to-stdout\n');
    expect(out.stderr).toBe('to-stderr\n');
  });

  it('appendFileSync(2) lands on stderr and byte data is latin1-preserved on fd 1', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const fs = require('fs');
       fs.appendFileSync(2, 'warn: thing\\n');
       fs.writeFileSync(1, new Uint8Array([0x68, 0x69, 0xff]));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBe('warn: thing\n');
    expect(out.stdout).toBe(`hi${String.fromCharCode(0xff)}`);
  });

  it('reading fd 1/2 and unknown numeric fds throw EBADF (sync and async)', async () => {
    const ctx = makeCtx({ stdin: 'x' });
    const out = await runCode(
      `const fs = require('fs');
       const codeOf = (fn) => { try { fn(); return 'no-throw'; } catch (err) { return err.code; } };
       const readFd1 = codeOf(() => fs.readFileSync(1));
       const readFd7 = codeOf(() => fs.readFileSync(7));
       const writeFd0 = codeOf(() => fs.writeFileSync(0, 'nope'));
       const writeFd9 = codeOf(() => fs.writeFileSync(9, 'nope'));
       const asyncRead = await fs.readFile(3, 'utf8').then(() => 'no-throw', (err) => err.code);
       console.log(JSON.stringify({ readFd1, readFd7, writeFd0, writeFd9, asyncRead }));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout.trim())).toEqual({
      readFd1: 'EBADF',
      readFd7: 'EBADF',
      writeFd0: 'EBADF',
      writeFd9: 'EBADF',
      asyncRead: 'EBADF',
    });
  });

  it('async fs.readFile(0)/writeFile(1|2) mirror the sync fd handling', async () => {
    const ctx = makeCtx({ stdin: 'async stdin\n' });
    const out = await runCode(
      `const fs = require('fs');
       const text = await fs.promises.readFile(0, 'utf8');
       await fs.writeFile(1, 'wrote:' + JSON.stringify(text) + '\\n');
       await fs.appendFile(2, 'err-side\\n');`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('wrote:"async stdin\\n"\n');
    expect(out.stderr).toBe('err-side\n');
  });
});

describe('/dev/stdin, /dev/stdout, /dev/stderr device paths', () => {
  it('readFileSync("/dev/stdin") reads the piped input', async () => {
    const ctx = makeCtx({ stdin: 'via device path' });
    const out = await runCode(
      `const fs = require('fs');
       process.stdout.write(fs.readFileSync('/dev/stdin', 'utf8'));`,
      ctx
    );
    expect(out.stderr).toBe('');
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('via device path');
  });

  it('writes to /dev/stdout and /dev/stderr land on the right streams', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const fs = require('fs');
       fs.writeFileSync('/dev/stdout', 'dev-out\\n');
       fs.writeFileSync('/dev/stderr', 'dev-err\\n');
       await fs.writeFile('/dev/stdout', 'dev-out-async\\n');`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('dev-out\ndev-out-async\n');
    expect(out.stderr).toBe('dev-err\n');
  });

  it('existsSync/accessSync/statSync report the stream devices as present', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const fs = require('fs');
       const st = fs.statSync('/dev/stdin');
       fs.accessSync('/dev/stderr'); // must not throw
       console.log(JSON.stringify({
         exists: [fs.existsSync('/dev/stdin'), fs.existsSync('/dev/stdout'), fs.existsSync('/dev/stderr')],
         isFile: st.isFile(),
         isDir: st.isDirectory(),
         isChar: st.isCharacterDevice(),
         asyncExists: await fs.exists('/dev/stdout'),
         asyncStatIsFile: (await fs.stat('/dev/stderr')).isFile,
       }));`,
      ctx
    );
    expect(out.stderr).toBe('');
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout.trim())).toEqual({
      exists: [true, true, true],
      isFile: true,
      isDir: false,
      isChar: true,
      asyncExists: true,
      asyncStatIsFile: true,
    });
  });
});

describe("require('readline')", () => {
  it('createInterface({ input: process.stdin }) emits one line per \\n, then close', async () => {
    const ctx = makeCtx({ stdin: 'alpha\nbeta\ngamma\n' });
    const out = await runCode(
      `const readline = require('readline');
       const rl = readline.createInterface({ input: process.stdin });
       const lines = [];
       rl.on('line', (l) => lines.push(l));
       rl.on('close', () => console.log(JSON.stringify(lines)));`,
      ctx
    );
    expect(out.stderr).toBe('');
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout.trim())).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('emits a final unterminated line and strips CRLF (Node parity)', async () => {
    const ctx = makeCtx({ stdin: 'one\r\ntwo' });
    const out = await runCode(
      `const readline = require('node:readline');
       const rl = readline.createInterface({ input: process.stdin, terminal: false });
       const lines = [];
       rl.on('line', (l) => lines.push(l));
       rl.on('close', () => console.log(JSON.stringify(lines)));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout.trim())).toEqual(['one', 'two']);
  });

  it('supports for await (const line of rl) iteration', async () => {
    const ctx = makeCtx({ stdin: 'a\nb\nc\n' });
    const out = await runCode(
      `const readline = require('readline');
       const rl = readline.createInterface({ input: process.stdin });
       const lines = [];
       for await (const line of rl) lines.push(line.toUpperCase());
       console.log(lines.join('|'));`,
      ctx
    );
    expect(out.stderr).toBe('');
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('A|B|C');
  });

  it("readline/promises question() echoes the query and resolves the next line ('' at EOF)", async () => {
    const ctx = makeCtx({ stdin: 'Ada\n' });
    const out = await runCode(
      `const readline = require('readline/promises');
       const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
       const name = await rl.question('name? ');
       const empty = await rl.question('more? ');
       rl.close();
       console.log(JSON.stringify({ name, empty }));`,
      ctx
    );
    expect(out.stderr).toBe('');
    expect(out.exitCode).toBe(0);
    // The queries carry no trailing newline, so stdout is one line:
    // "name? more? {...}" — parse the JSON tail.
    expect(out.stdout).toContain('name? ');
    expect(out.stdout).toContain('more? ');
    expect(JSON.parse(out.stdout.slice(out.stdout.indexOf('{')))).toEqual({
      name: 'Ada',
      empty: '',
    });
  });

  it('callback readline question() works and process.exit from a line handler sets the exit code', async () => {
    const ctx = makeCtx({ stdin: 'yes\nrest\n' });
    const out = await runCode(
      `const readline = require('readline');
       const rl = readline.createInterface({ input: process.stdin });
       rl.question('go? ', (answer) => {
         console.log('answer:' + answer);
         process.exit(3);
       });`,
      ctx
    );
    expect(out.stdout).toContain('answer:yes');
    expect(out.exitCode).toBe(3);
  });
});

describe('process.stdin.read() Node parity', () => {
  it('returns null (not "") when no input is piped', async () => {
    const ctx = makeCtx();
    const out = await runCode(`console.log(JSON.stringify(process.stdin.read()));`, ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('null');
  });

  it('still returns the buffer when input IS piped, then null', async () => {
    const ctx = makeCtx({ stdin: 'data' });
    const out = await runCode(
      `console.log(JSON.stringify([process.stdin.read(), process.stdin.read()]));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout.trim())).toEqual(['data', null]);
  });
});
