/**
 * Real-shell e2e for the ESM access path to the `sliccy:` scheme and the
 * `node:` / bare `fs` built-ins from inside a `.jsh` script
 * (esm-schemes-and-sliccy, M5; VAL-GLOBALS-014, VAL-ESM-009/010).
 *
 * Drives a real `AlmostBashShell` over a `fake-indexeddb` VirtualFS through the
 * production realm seam (host transpile + uniform CJS graph). `sliccy:`/`node:`
 * /bare `fs` are built-in schemes, so no `ipk install` / registry mock is
 * needed — these prove a `.jsh` using `import` from those schemes runs
 * end-to-end with the real bundled esbuild transpile.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';

let dbCounter = 0;

async function newShell() {
  const { VirtualFS } = await import('../../../src/fs/index.js');
  const { AlmostBashShell } = await import('../../../src/shell/almost-bash-shell.js');
  const fs = await VirtualFS.create({ dbName: `test-esm-schemes-jsh-${dbCounter++}`, wipe: true });
  await fs.mkdir('/work', { recursive: true });
  const shell = new AlmostBashShell({ fs, cwd: '/work' });
  return { shell, fs };
}

describe('ESM sliccy:/node:/fs schemes from a .jsh over the real shell', () => {
  it('VAL-GLOBALS-014 / VAL-ESM-009: a .jsh using `import { exec } from "sliccy:exec"` runs', async () => {
    const { shell, fs } = await newShell();
    await fs.writeFile(
      '/work/sliccy-esm.jsh',
      [
        "import { exec } from 'sliccy:exec';",
        "const r = await exec('echo jsh-esm');",
        'console.log(r.stdout.trim());',
      ].join('\n')
    );

    const run = await shell.executeCommand('node /work/sliccy-esm.jsh');
    expect(run.stderr).not.toContain('Cannot find module');
    expect(run.stderr).not.toContain('ReferenceError');
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('jsh-esm');
    await fs.dispose();
  });

  it('VAL-ESM-009: a .jsh using a default `import exec from "sliccy:exec"` runs', async () => {
    const { shell, fs } = await newShell();
    await fs.writeFile(
      '/work/sliccy-default.jsh',
      [
        "import exec from 'sliccy:exec';",
        "const r = await exec('echo jsh-default');",
        'console.log(r.stdout.trim());',
      ].join('\n')
    );

    const run = await shell.executeCommand('node /work/sliccy-default.jsh');
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('jsh-default');
    await fs.dispose();
  });

  it('VAL-ESM-010: a .jsh using `import fs from "node:fs"` round-trips the VFS', async () => {
    const { shell, fs } = await newShell();
    await fs.writeFile(
      '/work/node-fs.jsh',
      [
        "import fs from 'node:fs';",
        'console.log(typeof fs.readFile);',
        "await fs.writeFile('/work/jsh-out.txt', 'hi-jsh-fs');",
        "console.log(await fs.readFile('/work/jsh-out.txt'));",
      ].join('\n')
    );

    const run = await shell.executeCommand('node /work/node-fs.jsh');
    expect(run.stderr).not.toContain('Cannot find module');
    expect(run.exitCode).toBe(0);
    const lines = run.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('function');
    expect(lines[1]).toBe('hi-jsh-fs');
    await fs.dispose();
  });

  it('VAL-ESM-010: a .jsh using a bare `import fs from "fs"` returns the VFS bridge', async () => {
    const { shell, fs } = await newShell();
    await fs.writeFile(
      '/work/bare-fs.jsh',
      [
        "import fs from 'fs';",
        "await fs.writeFile('/work/bare-out.txt', 'hi-bare');",
        "console.log(await fs.readFile('/work/bare-out.txt'));",
      ].join('\n')
    );

    const run = await shell.executeCommand('node /work/bare-fs.jsh');
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('hi-bare');
    await fs.dispose();
  });
});
