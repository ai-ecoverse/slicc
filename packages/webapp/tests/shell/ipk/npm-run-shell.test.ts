/**
 * End-to-end `npm run` over a real `AlmostBashShell` + fake-indexeddb VFS.
 * Proves the parts a stubbed `ctx.exec` cannot: the script body is parsed and
 * run by the real shell, the exec cwd is the package directory (not the
 * caller's), env vars reach the script, exit codes propagate, and a bare
 * `node_modules/.bin` word runs through `ipx` on the production realm seam.
 *
 * No registry mock: `npm run` must never touch the network.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { VirtualFS } from '../../../src/fs/index.js';

let dbCounter = 0;

async function newShell() {
  const { VirtualFS } = await import('../../../src/fs/index.js');
  const { AlmostBashShell } = await import('../../../src/shell/almost-bash-shell.js');
  const fs = await VirtualFS.create({ dbName: `test-npm-run-shell-${dbCounter++}`, wipe: true });
  await fs.mkdir('/work', { recursive: true });
  const shell = new AlmostBashShell({ fs, cwd: '/work' });
  return { shell, fs };
}

async function writeManifest(fs: VirtualFS, dir: string, manifest: unknown): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(`${dir}/package.json`, JSON.stringify(manifest, null, 2));
}

describe('npm run via real AlmostBashShell', () => {
  let shell: Awaited<ReturnType<typeof newShell>>['shell'];
  let fs: VirtualFS;

  beforeEach(async () => {
    ({ shell, fs } = await newShell());
  });

  it('runs a script body through the shell and writes its side effects', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      version: '1.0.0',
      scripts: { build: 'echo built > out.txt' },
    });

    const r = await shell.executeCommand('npm run build');

    expect(r.exitCode).toBe(0);
    expect(await fs.readFile('/work/out.txt')).toBe('built\n');
    await fs.dispose();
  });

  it('runs pre/post hooks in order and exposes npm_lifecycle_event', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      version: '1.0.0',
      scripts: {
        prebuild: 'echo pre:$npm_lifecycle_event',
        build: 'echo main:$npm_package_name@$npm_package_version',
        postbuild: 'echo post:$npm_lifecycle_event',
      },
    });

    const r = await shell.executeCommand('npm run --silent build');

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('pre:prebuild\nmain:demo@1.0.0\npost:postbuild\n');
    await fs.dispose();
  });

  it('runs in the package directory even when invoked from a subdirectory', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      version: '1.0.0',
      scripts: { where: 'pwd' },
    });
    await fs.mkdir('/work/src/deep', { recursive: true });

    const r = await shell.executeCommand('cd src/deep && npm run --silent where');

    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('/work');
    await fs.dispose();
  });

  it('propagates a failing script exit code and keeps the shell responsive', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      version: '1.0.0',
      scripts: { fail: 'echo nope >&2; exit 7', postfail: 'echo should-not-run > post.txt' },
    });

    const r = await shell.executeCommand('npm run fail');

    expect(r.exitCode).toBe(7);
    expect(r.stderr).toContain('nope');
    expect(await fs.exists('/work/post.txt')).toBe(false);

    const followUp = await shell.executeCommand('echo ok');
    expect(followUp.exitCode).toBe(0);
    expect(followUp.stdout).toContain('ok');
    await fs.dispose();
  });

  it('forwards extra args after -- to the script body', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      version: '1.0.0',
      scripts: { greet: 'echo hi' },
    });

    const r = await shell.executeCommand('npm run --silent greet -- there friend');

    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hi there friend');
    await fs.dispose();
  });

  it('npm test / ipk run are the same runner as npm run', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      version: '1.0.0',
      scripts: { test: 'echo tested', build: 'echo built' },
    });

    const viaTest = await shell.executeCommand('npm test --silent');
    expect(viaTest.exitCode).toBe(0);
    expect(viaTest.stdout).toContain('tested');

    const viaIpk = await shell.executeCommand('ipk run --silent build');
    expect(viaIpk.exitCode).toBe(0);
    expect(viaIpk.stdout).toContain('built');
    await fs.dispose();
  });

  it('lists scripts with no script name and fails clearly on a missing one', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      version: '1.0.0',
      scripts: { build: 'echo built' },
    });

    const list = await shell.executeCommand('npm run');
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain('build');

    const missing = await shell.executeCommand('npm run nope');
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toMatch(/missing script: nope/);
    await fs.dispose();
  });

  it('runs a bare node_modules/.bin word through ipx', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      version: '1.0.0',
      scripts: { build: 'mytool hello' },
    });
    await writeManifest(fs, '/work/node_modules/mytool', {
      name: 'mytool',
      version: '1.0.0',
      bin: './cli.js',
    });
    await fs.writeFile(
      '/work/node_modules/mytool/cli.js',
      '#!/usr/bin/env node\nconsole.log("MYTOOL:" + process.argv.slice(2).join("|"));\n'
    );
    await fs.mkdir('/work/node_modules/.bin', { recursive: true });
    await fs.writeFile(
      '/work/node_modules/.bin/mytool',
      '#!/usr/bin/env node\nrequire("../mytool/cli.js");\n'
    );

    const r = await shell.executeCommand('npm run --silent build');

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('MYTOOL:hello');
    await fs.dispose();
  });

  it('leaves a shell built-in that shadows a .bin name to the built-in', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      version: '1.0.0',
      scripts: { list: 'echo shadowed' },
    });
    await fs.mkdir('/work/node_modules/.bin', { recursive: true });
    await fs.writeFile('/work/node_modules/.bin/echo', '#!/usr/bin/env node\nprocess.exit(9);\n');

    const r = await shell.executeCommand('npm run --silent list');

    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('shadowed');
    await fs.dispose();
  });

  it('does not reach the network and reports a missing package.json cleanly', async () => {
    const r = await shell.executeCommand('npm run build');

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/no package\.json/i);
    await fs.dispose();
  });
});
