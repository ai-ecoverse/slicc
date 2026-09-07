/**
 * Real-shell e2e for DEFERRED nested-require resolution failures.
 *
 * Node resolves `require()` when the call executes, so the optional-dependency
 * idiom — `try { require('supports-color') } catch {}` — costs nothing when the
 * package is absent. SLICC resolves the whole graph up front on the host, and
 * that walk used to THROW on the first unresolvable nested specifier, sinking
 * every module in the graph. Real packages depend on the Node behavior:
 * `debug/src/node.js` has exactly that try/catch, so `require('eslint')` failed
 * with `Cannot find module 'supports-color'` — a package eslint never needs.
 *
 * These run through the production `node <script.js>` path over a real
 * `fake-indexeddb` VirtualFS, so they cover the host graph walker, the wire
 * shape, and the realm require shim together.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../../src/shell/almost-bash-shell-headless.js';

let dbCounter = 0;

async function newShell() {
  const fs = await VirtualFS.create({ dbName: `test-optional-dep-${dbCounter++}`, wipe: true });
  await fs.mkdir('/work', { recursive: true });
  const shell = new AlmostBashShellHeadless({ fs, cwd: '/work' });
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

describe('optional-dependency require e2e: an unresolvable nested specifier is deferred, not fatal', () => {
  it('loads a package whose optional require is caught, and reports the dependency absent', async () => {
    const { shell, fs } = await newShell();
    // The `debug/src/node.js` shape, reduced to its essentials.
    await seed(fs, {
      '/work/node_modules/loggy/package.json': JSON.stringify({ main: 'index.js' }),
      '/work/node_modules/loggy/index.js': `
        let color = null;
        try { color = require('supports-color'); } catch (e) { color = null; }
        module.exports = { color, log: (m) => 'loggy:' + m };
      `,
      '/work/main.js': `
        const loggy = require('loggy');
        console.log(loggy.log('hi'));
        console.log('color=' + loggy.color);
      `,
    });
    const run = await shell.executeCommand('node main.js');
    expect(run.stderr).not.toContain('Cannot find module');
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('loggy:hi');
    expect(run.stdout).toContain('color=null');
    await fs.dispose();
  });

  it('still throws the install-hint error when the missing specifier IS required', async () => {
    const { shell, fs } = await newShell();
    await seed(fs, {
      '/work/node_modules/needy/package.json': JSON.stringify({ main: 'index.js' }),
      '/work/node_modules/needy/index.js': "module.exports = require('absent-pkg');",
      '/work/main.js': "require('needy');",
    });
    const run = await shell.executeCommand('node main.js');
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("Cannot find module 'absent-pkg'");
    expect(run.stderr).toContain('ipk install absent-pkg');
    await fs.dispose();
  });

  it('keeps siblings of a failed edge loadable from the same file', async () => {
    const { shell, fs } = await newShell();
    await seed(fs, {
      '/work/node_modules/mixed/package.json': JSON.stringify({ main: 'index.js' }),
      '/work/node_modules/mixed/index.js': `
        const present = require('./present.js');
        let absent = 'none';
        try { absent = require('nope'); } catch (e) { absent = 'caught'; }
        module.exports = { present, absent };
      `,
      '/work/node_modules/mixed/present.js': "module.exports = 'here';",
      '/work/main.js': "console.log(JSON.stringify(require('mixed')));",
    });
    const run = await shell.executeCommand('node main.js');
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout.trim())).toEqual({ present: 'here', absent: 'caught' });
    await fs.dispose();
  });
});
