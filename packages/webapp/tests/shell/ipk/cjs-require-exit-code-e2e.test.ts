import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../../src/shell/almost-bash-shell-headless.js';

let dbCounter = 0;

async function newShell() {
  const fs = await VirtualFS.create({
    dbName: `test-require-exit-${dbCounter++}`,
    wipe: true,
  });
  await fs.mkdir('/work/node_modules', { recursive: true });
  const shell = new AlmostBashShellHeadless({ fs, cwd: '/work' });
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
