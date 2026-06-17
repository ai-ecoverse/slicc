/**
 * Discoverability e2e for the ipk/ipx command family (M6, VAL-CROSS-014):
 * drives a real AlmostBashShell over a fake-indexeddb VFS and proves that all
 * four commands are present in the command catalog (`commands`) and on the
 * `which`/`/usr/bin` surfaces, and that each responds to `--help` with a
 * non-empty, recognizable usage block and exit 0.
 *
 * The real-registry side of M6 (ipx auto-install-then-run, npm/npx alias
 * parity end-to-end against registry.npmjs.org — VAL-CROSS-005/006) is proven
 * by the browser validator; this suite covers the static discoverability
 * contract that requires no network.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { AlmostBashShell } from '../../../src/shell/almost-bash-shell.js';

const PACKAGE_COMMANDS = ['ipk', 'npm', 'ipx', 'npx'] as const;

describe('ipk/ipx discoverability (VAL-CROSS-014)', () => {
  let fs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-ipk-discover-${dbCounter++}`, wipe: true });
  });

  it('lists ipk, npm, ipx, npx in the `commands` catalog under Packages', async () => {
    const shell = new AlmostBashShell({ fs });
    const result = await shell.executeCommand('commands');
    expect(result.exitCode).toBe(0);

    const lines = result.stdout.split('\n');
    const idx = lines.findIndex((l) => l.trim() === 'Packages:');
    expect(idx).toBeGreaterThan(-1);
    const listing = (lines[idx + 1] ?? '').trim();
    for (const name of PACKAGE_COMMANDS) {
      expect(listing.split(/,\s*/)).toContain(name);
    }
    await fs.dispose();
  });

  it('resolves all four commands through `which` and /usr/bin', async () => {
    const shell = new AlmostBashShell({ fs });
    const which = await shell.executeCommand('which ipk npm ipx npx');
    expect(which.exitCode).toBe(0);
    for (const name of PACKAGE_COMMANDS) {
      expect(which.stdout).toContain(`/usr/bin/${name}`);
    }

    const usrBin = await shell.executeCommand('ls /usr/bin');
    for (const name of PACKAGE_COMMANDS) {
      expect(usrBin.stdout.split(/\s+/)).toContain(name);
    }
    await fs.dispose();
  });

  it('prints recognizable `ipk --help` usage mentioning install/i and exits 0', async () => {
    const shell = new AlmostBashShell({ fs });
    const help = await shell.executeCommand('ipk --help');
    expect(help.exitCode).toBe(0);
    expect(help.stdout.trim().length).toBeGreaterThan(0);
    expect(help.stdout).toContain('ipk');
    expect(help.stdout).toMatch(/install/);
    expect(help.stdout).toMatch(/\bi\b/);
    expect(help.stdout).toContain('Usage:');
    await fs.dispose();
  });

  it('prints recognizable `npm --help` usage (ipk alias) and exits 0', async () => {
    const shell = new AlmostBashShell({ fs });
    const help = await shell.executeCommand('npm --help');
    expect(help.exitCode).toBe(0);
    expect(help.stdout.trim().length).toBeGreaterThan(0);
    expect(help.stdout).toContain('npm');
    expect(help.stdout).toMatch(/install/);
    expect(help.stdout).toContain('Usage:');
    await fs.dispose();
  });

  it('prints recognizable `ipx --help` usage mentioning running a package/bin and exits 0', async () => {
    const shell = new AlmostBashShell({ fs });
    const help = await shell.executeCommand('ipx --help');
    expect(help.exitCode).toBe(0);
    expect(help.stdout.trim().length).toBeGreaterThan(0);
    expect(help.stdout).toContain('ipx');
    expect(help.stdout).toMatch(/bin/);
    expect(help.stdout).toMatch(/run/i);
    expect(help.stdout).toContain('Usage:');
    await fs.dispose();
  });

  it('prints recognizable `npx --help` usage (ipx alias) and exits 0', async () => {
    const shell = new AlmostBashShell({ fs });
    const help = await shell.executeCommand('npx --help');
    expect(help.exitCode).toBe(0);
    expect(help.stdout.trim().length).toBeGreaterThan(0);
    expect(help.stdout).toContain('npx');
    expect(help.stdout).toMatch(/bin/);
    expect(help.stdout).toMatch(/run/i);
    expect(help.stdout).toContain('Usage:');
    await fs.dispose();
  });

  it('`ipk install --help` prints usage and exits 0', async () => {
    const shell = new AlmostBashShell({ fs });
    const help = await shell.executeCommand('ipk install --help');
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('Usage:');
    expect(help.stdout).toMatch(/install/);
    await fs.dispose();
  });

  it('resolves a single `--help` from `commands <name>` for each package command', async () => {
    const shell = new AlmostBashShell({ fs });
    for (const name of PACKAGE_COMMANDS) {
      const help = await shell.executeCommand(`commands ${name}`);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain('Usage:');
      expect(help.stdout).toContain(name);
    }
    await fs.dispose();
  });
});
