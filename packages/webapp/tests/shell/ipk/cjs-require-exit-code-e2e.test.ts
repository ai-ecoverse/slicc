/**
 * Real-shell e2e for require-error -> shell exit-status parity
 * (m4-fix-node-require-error-exit-code).
 *
 * Drives a real `AlmostBashShell` over a fake-indexeddb VirtualFS and runs
 * `node -e "require(...)"` / `node <script>` through the production realm seam,
 * asserting that EVERY uncaught realm error maps to a NON-ZERO shell exit
 * status (Node parity: a failing require exits 1), while a successful require
 * still exits 0:
 *   - a Node-native package (`sharp`) hard-fails non-zero (VAL-REQUIRE-012);
 *   - a package whose `main` points at a missing file exits non-zero
 *     (VAL-REQUIRE-014);
 *   - a package with malformed (invalid-JSON) `package.json` exits non-zero
 *     (VAL-REQUIRE-014);
 *   - a successful require still exits 0 (no regression);
 *   - a missing bare module still exits non-zero (no regression).
 *
 * The `node` command must run trusted so the cross-thread worker RPC await
 * settles before `bash.exec` returns; otherwise the realm's non-zero exit is
 * lost and the shell reports exit 0.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';

let dbCounter = 0;

async function newShell() {
  const { VirtualFS } = await import('../../../src/fs/index.js');
  const { AlmostBashShell } = await import('../../../src/shell/almost-bash-shell.js');
  const fs = await VirtualFS.create({
    dbName: `test-require-exit-${dbCounter++}`,
    wipe: true,
  });
  await fs.mkdir('/work/node_modules', { recursive: true });
  const shell = new AlmostBashShell({ fs, cwd: '/work' });
  return { shell, fs };
}

async function writePackage(
  fs: {
    mkdir: (p: string, o: { recursive: boolean }) => Promise<unknown>;
    writeFile: (p: string, c: string) => Promise<unknown>;
  },
  name: string,
  files: Record<string, string>
): Promise<void> {
  const dir = `/work/node_modules/${name}`;
  await fs.mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    await fs.writeFile(`${dir}/${rel}`, content);
  }
}

describe('require-error -> shell exit-status parity (node -e / node <script>)', () => {
  it('VAL-REQUIRE-012: `node -e "require(\'sharp\')"` exits non-zero with the native-module message', async () => {
    const { shell, fs } = await newShell();
    const run = await shell.executeCommand('node -e "require(\'sharp\')"');
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain('native module');
    expect(run.stderr).toContain('C++ bindings');
    expect(run.stderr).not.toContain('Cannot find module');
    await fs.dispose();
  });

  it('VAL-REQUIRE-014: a package whose main points at a missing file exits non-zero with a clear error', async () => {
    const { shell, fs } = await newShell();
    await writePackage(fs, 'brokenmain', {
      'package.json': JSON.stringify({
        name: 'brokenmain',
        version: '1.0.0',
        main: './nope.js',
      }),
    });
    const run = await shell.executeCommand('node -e "require(\'brokenmain\')"');
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain('nope.js');
    expect(run.stderr).not.toBe('');
    await fs.dispose();
  });

  it('VAL-REQUIRE-014: a package with malformed package.json exits non-zero with a clear parse error', async () => {
    const { shell, fs } = await newShell();
    await writePackage(fs, 'badmeta', {
      'package.json': '{ "name": "badmeta", not valid json',
      'index.js': 'module.exports = 1;',
    });
    const run = await shell.executeCommand('node -e "require(\'badmeta\')"');
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain('Invalid package.json');
    expect(run.stderr).toContain('badmeta');
    await fs.dispose();
  });

  it('a SUCCESSFUL require still exits 0 (no regression)', async () => {
    const { shell, fs } = await newShell();
    await writePackage(fs, 'okpkg', {
      'package.json': JSON.stringify({ name: 'okpkg', version: '1.0.0', main: 'index.js' }),
      'index.js': "module.exports = 'ok-loaded';\n",
    });
    const run = await shell.executeCommand('node -e "console.log(require(\'okpkg\'))"');
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('ok-loaded');
    expect(run.stderr).not.toContain('Cannot find module');
    await fs.dispose();
  });

  it('a missing module still exits non-zero with the install hint (no regression)', async () => {
    const { shell, fs } = await newShell();
    const run = await shell.executeCommand('node -e "require(\'not-installed-xyz\')"');
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("Cannot find module 'not-installed-xyz'");
    await fs.dispose();
  });

  it('the same errors propagate through `node <script>` (not just `node -e`)', async () => {
    const { shell, fs } = await newShell();
    await fs.writeFile('/work/run.js', "require('sharp');");
    const run = await shell.executeCommand('node run.js');
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain('native module');
    await fs.dispose();
  });
});
