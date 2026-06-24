/**
 * Real-shell e2e for the Node resolution surface through `require()`
 * (cjs-resolution-paths). Drives the production `AlmostBashShell` over a real
 * `fake-indexeddb` `VirtualFS` with a synthesized `node_modules` tree (no
 * registry needed), exercising the realm-wiring-dependent behaviors through the
 * actual `node <script.js>` command path (`node-command.ts`): the
 * nearest-node_modules walk with nearest-wins (VAL-REQUIRE-005), script-relative
 * require resolution (VAL-REQUIRE-018), and per-module `__dirname`/`__filename`
 * for bundled-asset reads (VAL-REQUIRE-019).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';

let dbCounter = 0;

async function newShell() {
  const { VirtualFS } = await import('../../../src/fs/index.js');
  const { AlmostBashShell } = await import('../../../src/shell/almost-bash-shell.js');
  const fs = await VirtualFS.create({ dbName: `test-cjs-resolve-${dbCounter++}`, wipe: true });
  await fs.mkdir('/work', { recursive: true });
  const shell = new AlmostBashShell({ fs, cwd: '/work' });
  return { shell, fs };
}

async function seed(
  fs: Awaited<ReturnType<typeof newShell>>['fs'],
  files: Record<string, string>
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (dir) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path, content);
  }
}

describe('CJS resolution surface e2e: node <script.js> require over a synthesized node_modules tree', () => {
  it('VAL-REQUIRE-005: nearest-node_modules walk prefers the nearest copy from a nested script', async () => {
    const { shell, fs } = await newShell();
    await seed(fs, {
      '/work/node_modules/dep/package.json': JSON.stringify({ main: 'index.js' }),
      '/work/node_modules/dep/index.js': "module.exports = 'far';",
      '/work/a/node_modules/dep/package.json': JSON.stringify({ main: 'index.js' }),
      '/work/a/node_modules/dep/index.js': "module.exports = 'near';",
      '/work/a/b/use.js': "console.log(require('dep'));",
    });
    const run = await shell.executeCommand('node a/b/use.js');
    expect(run.exitCode).toBe(0);
    expect(run.stderr).not.toContain('Cannot find module');
    expect(run.stdout.trim()).toBe('near');
    await fs.dispose();
  });

  it("VAL-REQUIRE-018: a script's requires resolve relative to its own directory, not the shell cwd", async () => {
    const { shell, fs } = await newShell();
    // is-number lives only under the script's directory; cwd /work cannot see it.
    await seed(fs, {
      '/work/proj/node_modules/is-number/package.json': JSON.stringify({ main: 'index.js' }),
      '/work/proj/node_modules/is-number/index.js':
        "module.exports = function isNumber(n) { return typeof n === 'number'; };",
      '/work/proj/run.js': "console.log(require('is-number')(5));",
    });
    const run = await shell.executeCommand('node proj/run.js');
    expect(run.exitCode).toBe(0);
    expect(run.stderr).not.toContain('Cannot find module');
    expect(run.stdout.trim()).toBe('true');
    await fs.dispose();
  });

  it("VAL-REQUIRE-019: a required module's __dirname/__filename are its own dir, so a bundled asset loads", async () => {
    const { shell, fs } = await newShell();
    await seed(fs, {
      '/work/app/main.js': `
        const pkg = require('asset-pkg');
        console.log(pkg.dir);
        console.log(pkg.file);
        console.log(await pkg.readAsset());
      `,
      '/work/node_modules/asset-pkg/package.json': JSON.stringify({ main: 'index.js' }),
      '/work/node_modules/asset-pkg/index.js': `
        const fs = require('fs');
        const path = require('path');
        module.exports = {
          dir: __dirname,
          file: __filename,
          readAsset: () => fs.readFile(path.join(__dirname, 'data.txt')),
        };
      `,
      '/work/node_modules/asset-pkg/data.txt': 'bundled-asset-bytes',
    });
    const run = await shell.executeCommand('node app/main.js');
    expect(run.exitCode).toBe(0);
    expect(run.stderr).not.toContain('Cannot find module');
    const lines = run.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('/work/node_modules/asset-pkg');
    expect(lines[1]).toBe('/work/node_modules/asset-pkg/index.js');
    expect(lines[2]).toBe('bundled-asset-bytes');
    await fs.dispose();
  });
});
