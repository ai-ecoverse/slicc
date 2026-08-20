/**
 * Unit coverage for `npm run` / `ipk run` (`npm-run.ts`) with a stubbed
 * `ctx.exec`, so the contract is asserted without a full shell:
 *   - the nearest package.json wins and its directory becomes the exec cwd;
 *   - `pre<script>` / `post<script>` ordering, and a failing `pre` aborting;
 *   - extra args are appended shell-quoted, one leading `--` is stripped;
 *   - npm_* env vars and the node_modules/.bin `$PATH` prefix;
 *   - `run` with no script lists, missing script fails (unless `--if-present`);
 *   - `--silent` drops the banner;
 *   - bare `.bin`-only words are rewritten to `ipx <word>`, registered
 *     commands and unknown words are left alone.
 */
import 'fake-indexeddb/auto';
import type { CommandContext, ExecResult, IFileSystem, SecureFetch } from 'just-bash';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { createIpkCommand } from '../../../src/shell/supplemental-commands/ipk-command.js';

const unusedFetch = (() => {
  throw new Error('npm run must not hit the registry');
}) as unknown as SecureFetch;

let dbCounter = 0;
async function newFs(): Promise<VirtualFS> {
  const fs = await VirtualFS.create({ dbName: `test-npm-run-${dbCounter++}`, wipe: true });
  await fs.mkdir('/work', { recursive: true });
  return fs;
}

interface ExecCall {
  command: string;
  cwd: string;
  env: Record<string, string>;
}

interface Harness {
  ctx: CommandContext;
  calls: ExecCall[];
}

function harness(
  cwd: string,
  options: {
    results?: ExecResult[];
    registered?: string[];
  } = {}
): Harness {
  const calls: ExecCall[] = [];
  const results = options.results ?? [];
  const fsLike: Partial<IFileSystem> = {
    resolvePath: (base: string, p: string) => (p.startsWith('/') ? p : `${base}/${p}`),
  };
  const ctx = {
    fs: fsLike as IFileSystem,
    cwd,
    env: new Map<string, string>([['PATH', '/usr/bin']]),
    stdin: new Uint8Array(),
    getRegisteredCommands: () => options.registered ?? [],
    exec: async (command: string, opts: { cwd: string; env?: Record<string, string> }) => {
      calls.push({ command, cwd: opts.cwd, env: opts.env ?? {} });
      return results[calls.length - 1] ?? { stdout: '', stderr: '', exitCode: 0 };
    },
  } as unknown as CommandContext;
  return { ctx, calls };
}

async function writeManifest(fs: VirtualFS, dir: string, manifest: unknown): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(`${dir}/package.json`, JSON.stringify(manifest, null, 2));
}

/** The shim shape `ipk` writes into `node_modules/.bin`. */
async function writeBinShim(fs: VirtualFS, dir: string, bin: string): Promise<void> {
  await fs.mkdir(`${dir}/node_modules/.bin`, { recursive: true });
  await fs.writeFile(
    `${dir}/node_modules/.bin/${bin}`,
    `#!/usr/bin/env node\nrequire("../${bin}/cli.js");\n`
  );
}

function npm(fs: VirtualFS) {
  return createIpkCommand('npm', { fs, fetch: unusedFetch });
}

describe('npm run', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await newFs();
  });

  it('runs the named script in the directory holding the nearest package.json', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      version: '1.2.3',
      scripts: { build: 'echo built' },
    });
    await fs.mkdir('/work/src/deep', { recursive: true });
    const { ctx, calls } = harness('/work/src/deep');

    const r = await npm(fs).execute(['run', 'build'], ctx);

    expect(r.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('echo built');
    expect(calls[0].cwd).toBe('/work');
    expect(r.stdout).toContain('> demo@1.2.3 build');
  });

  it('prefers the nearest package.json over an outer one', async () => {
    await writeManifest(fs, '/work', { name: 'outer', scripts: { build: 'echo outer' } });
    await writeManifest(fs, '/work/inner', { name: 'inner', scripts: { build: 'echo inner' } });
    const { ctx, calls } = harness('/work/inner');

    expect((await npm(fs).execute(['run', 'build'], ctx)).exitCode).toBe(0);
    expect(calls[0].command).toBe('echo inner');
    expect(calls[0].cwd).toBe('/work/inner');
  });

  it('runs pre<script> and post<script> around the script body', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      scripts: { prebuild: 'echo pre', build: 'echo main', postbuild: 'echo post' },
    });
    const { ctx, calls } = harness('/work');

    const r = await npm(fs).execute(['run', 'build'], ctx);

    expect(r.exitCode).toBe(0);
    expect(calls.map((c) => c.command)).toEqual(['echo pre', 'echo main', 'echo post']);
  });

  it('aborts before the main body when pre<script> fails, and propagates its code', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      scripts: { prebuild: 'exit 3', build: 'echo main', postbuild: 'echo post' },
    });
    const { ctx, calls } = harness('/work', {
      results: [{ stdout: '', stderr: 'boom\n', exitCode: 3 }],
    });

    const r = await npm(fs).execute(['run', 'build'], ctx);

    expect(r.exitCode).toBe(3);
    expect(calls.map((c) => c.command)).toEqual(['exit 3']);
    expect(r.stderr).toContain('boom');
    expect(r.stderr).toMatch(/prebuild/);
  });

  it('appends extra args (shell-quoted) to the main body only, stripping one --', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      scripts: { pregreet: 'echo pre', greet: 'echo hi' },
    });
    const { ctx, calls } = harness('/work');

    const r = await npm(fs).execute(['run', 'greet', '--', '--loud', "it's here"], ctx);

    expect(r.exitCode).toBe(0);
    expect(calls[0].command).toBe('echo pre');
    expect(calls[1].command).toBe(`echo hi '--loud' 'it'\\''s here'`);
  });

  it('exports npm_* lifecycle env vars and prepends node_modules/.bin to PATH', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      version: '4.5.6',
      scripts: { build: 'echo built' },
    });
    await fs.mkdir('/work/sub', { recursive: true });
    const { ctx, calls } = harness('/work/sub');

    await npm(fs).execute(['run', 'build'], ctx);

    expect(calls[0].env.npm_lifecycle_event).toBe('build');
    expect(calls[0].env.npm_lifecycle_script).toBe('echo built');
    expect(calls[0].env.npm_package_name).toBe('demo');
    expect(calls[0].env.npm_package_version).toBe('4.5.6');
    expect(calls[0].env.PATH.split(':')[0]).toBe('/work/node_modules/.bin');
    expect(calls[0].env.PATH.endsWith('/usr/bin')).toBe(true);
  });

  it('lists the available scripts when no script name is given', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      version: '1.0.0',
      scripts: { build: 'echo built', test: 'echo tested' },
    });
    const { ctx, calls } = harness('/work');

    const r = await npm(fs).execute(['run'], ctx);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('demo@1.0.0');
    expect(r.stdout).toContain('build');
    expect(r.stdout).toContain('echo tested');
    expect(calls).toHaveLength(0);
  });

  it('fails with the available scripts listed when the script is missing', async () => {
    await writeManifest(fs, '/work', { name: 'demo', scripts: { build: 'echo built' } });
    const { ctx, calls } = harness('/work');

    const r = await npm(fs).execute(['run', 'nope'], ctx);

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/missing script: nope/);
    expect(r.stderr).toContain('build');
    expect(calls).toHaveLength(0);
  });

  it('--if-present turns a missing script into a silent success', async () => {
    await writeManifest(fs, '/work', { name: 'demo', scripts: { build: 'echo built' } });
    const { ctx, calls } = harness('/work');

    const r = await npm(fs).execute(['run', '--if-present', 'nope'], ctx);

    expect(r).toEqual({ stdout: '', stderr: '', exitCode: 0 });
    expect(calls).toHaveLength(0);
  });

  it('consumes npm flags placed AFTER the script name', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      scripts: { build: 'echo built', test: 'echo tested' },
    });

    const silent = harness('/work', {
      results: [{ stdout: 'built\n', stderr: '', exitCode: 0 }],
    });
    const r = await npm(fs).execute(['run', 'build', '--silent'], silent.ctx);
    expect(r.stdout).toBe('built\n');
    expect(silent.calls[0].command).toBe('echo built');

    const shortcut = harness('/work', {
      results: [{ stdout: 'tested\n', stderr: '', exitCode: 0 }],
    });
    const viaTest = await npm(fs).execute(['test', '--silent'], shortcut.ctx);
    expect(viaTest.stdout).toBe('tested\n');
    expect(shortcut.calls[0].command).toBe('echo tested');

    const present = harness('/work');
    const missing = await npm(fs).execute(['run', 'nope', '--if-present'], present.ctx);
    expect(missing).toEqual({ stdout: '', stderr: '', exitCode: 0 });
    expect(present.calls).toHaveLength(0);
  });

  it('passes npm-looking flags after -- through to the script', async () => {
    await writeManifest(fs, '/work', { name: 'demo', scripts: { build: 'echo built' } });
    const { ctx, calls } = harness('/work');

    const r = await npm(fs).execute(['run', 'build', '--', '--silent', '--if-present'], ctx);

    expect(r.exitCode).toBe(0);
    expect(calls[0].command).toBe(`echo built '--silent' '--if-present'`);
    expect(r.stdout).toContain('> demo build');
  });

  it('treats --help after -- as the script\u2019s flag, not ipk\u2019s', async () => {
    await writeManifest(fs, '/work', { name: 'demo', scripts: { lint: 'echo linting' } });
    const { ctx, calls } = harness('/work');

    const r = await npm(fs).execute(['run', 'lint', '--', '--help'], ctx);

    expect(r.exitCode).toBe(0);
    expect(calls[0].command).toBe(`echo linting '--help'`);
    expect(r.stdout).not.toMatch(/install packages from the npm registry/);
  });

  it('--silent suppresses the banner but keeps script output', async () => {
    await writeManifest(fs, '/work', { name: 'demo', scripts: { build: 'echo built' } });
    const { ctx } = harness('/work', {
      results: [{ stdout: 'built\n', stderr: '', exitCode: 0 }],
    });

    const r = await npm(fs).execute(['run', '--silent', 'build'], ctx);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('built\n');
  });

  it('run-script is an alias, and npm test is a lifecycle shortcut', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      scripts: { build: 'echo built', test: 'echo tested' },
    });

    const aliased = harness('/work');
    expect((await npm(fs).execute(['run-script', 'build'], aliased.ctx)).exitCode).toBe(0);
    expect(aliased.calls[0].command).toBe('echo built');

    const shortcut = harness('/work');
    expect((await npm(fs).execute(['test'], shortcut.ctx)).exitCode).toBe(0);
    expect(shortcut.calls[0].command).toBe('echo tested');
    expect(shortcut.calls[0].env.npm_lifecycle_event).toBe('test');
  });

  it('falls back to npm start / restart lifecycle defaults', async () => {
    await writeManifest(fs, '/work', { name: 'demo', scripts: { stop: 'echo stopping' } });
    await fs.writeFile('/work/server.js', 'listen();\n');

    const start = harness('/work');
    expect((await npm(fs).execute(['start'], start.ctx)).exitCode).toBe(0);
    expect(start.calls[0].command).toBe('node server.js');
    expect(start.calls[0].env.npm_lifecycle_event).toBe('start');

    const restart = harness('/work');
    expect((await npm(fs).execute(['restart'], restart.ctx)).exitCode).toBe(0);
    expect(restart.calls[0].command).toBe('npm stop --if-present && npm start');
  });

  it('prefers a declared start script over the server.js default', async () => {
    await writeManifest(fs, '/work', { name: 'demo', scripts: { start: 'echo declared' } });
    await fs.writeFile('/work/server.js', 'listen();\n');
    const { ctx, calls } = harness('/work');

    expect((await npm(fs).execute(['start'], ctx)).exitCode).toBe(0);
    expect(calls[0].command).toBe('echo declared');
  });

  it('still reports a missing start when the package has no server.js', async () => {
    await writeManifest(fs, '/work', { name: 'demo', scripts: { build: 'echo built' } });
    const { ctx, calls } = harness('/work');

    const r = await npm(fs).execute(['start'], ctx);

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/missing script: start/);
    expect(calls).toHaveLength(0);
  });

  it('reports a clear error when no package.json is reachable', async () => {
    const { ctx, calls } = harness('/work');

    const r = await npm(fs).execute(['run', 'build'], ctx);

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/no package\.json/i);
    expect(calls).toHaveLength(0);
  });

  it('reports an unparseable package.json instead of walking past it', async () => {
    await fs.writeFile('/work/package.json', '{ not json');
    const { ctx, calls } = harness('/work');

    const r = await npm(fs).execute(['run', 'build'], ctx);

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/not valid JSON/i);
    expect(calls).toHaveLength(0);
  });

  it('reports a context without exec support instead of silently succeeding', async () => {
    await writeManifest(fs, '/work', { name: 'demo', scripts: { build: 'echo built' } });
    const { ctx } = harness('/work');
    const noExec = { ...ctx, exec: undefined } as unknown as CommandContext;

    const r = await npm(fs).execute(['run', 'build'], noExec);

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/exec/i);
  });

  it('reports a package.json that defines no scripts', async () => {
    await writeManifest(fs, '/work', { name: 'demo', version: '1.0.0' });
    const { ctx } = harness('/work');

    const listing = await npm(fs).execute(['run'], ctx);
    expect(listing.exitCode).toBe(0);
    expect(listing.stdout).toMatch(/no scripts defined/i);

    const missing = await npm(fs).execute(['run', 'build'], ctx);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toMatch(/no scripts/i);
  });
});

describe('npm run bin rewriting', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await newFs();
  });

  it('rewrites a command-position word that only exists as a .bin shim to ipx', async () => {
    await writeManifest(fs, '/work', { name: 'demo', scripts: { build: 'tsup src --watch' } });
    await writeBinShim(fs, '/work', 'tsup');
    const { ctx, calls } = harness('/work', { registered: ['echo', 'ipx'] });

    expect((await npm(fs).execute(['run', 'build'], ctx)).exitCode).toBe(0);
    expect(calls[0].command).toBe('ipx tsup src --watch');
  });

  it('rewrites every command position in a compound script', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      scripts: { ci: 'tsup src && CI=1 tsup dist | cat' },
    });
    await writeBinShim(fs, '/work', 'tsup');
    const { ctx, calls } = harness('/work', { registered: ['cat', 'ipx'] });

    expect((await npm(fs).execute(['run', 'ci'], ctx)).exitCode).toBe(0);
    expect(calls[0].command).toBe('ipx tsup src && CI=1 ipx tsup dist | cat');
  });

  it('finds a .bin shim in a parent node_modules', async () => {
    await writeManifest(fs, '/work/pkg', { name: 'inner', scripts: { build: 'tsup src' } });
    await writeBinShim(fs, '/work', 'tsup');
    const { ctx, calls } = harness('/work/pkg', { registered: [] });

    expect((await npm(fs).execute(['run', 'build'], ctx)).exitCode).toBe(0);
    expect(calls[0].command).toBe('ipx tsup src');
  });

  it('keeps the command position after shell keywords', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      scripts: {
        cond: 'if tsup src; then tsup dist; fi',
        loop: 'while tsup check; do tsup step; done',
        negated: '! tsup fail',
      },
    });
    await writeBinShim(fs, '/work', 'tsup');
    const { ctx, calls } = harness('/work', { registered: [] });

    await npm(fs).execute(['run', 'cond'], ctx);
    await npm(fs).execute(['run', 'loop'], ctx);
    await npm(fs).execute(['run', 'negated'], ctx);

    expect(calls.map((c) => c.command)).toEqual([
      'if ipx tsup src; then ipx tsup dist; fi',
      'while ipx tsup check; do ipx tsup step; done',
      '! ipx tsup fail',
    ]);
  });

  it('does not rewrite the subject of for/case, which is never a command', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      scripts: {
        loop: 'for tsup in a b; do echo $tsup; done',
        pick: 'case tsup in *) echo x;; esac',
      },
    });
    await writeBinShim(fs, '/work', 'tsup');
    const { ctx, calls } = harness('/work', { registered: ['echo'] });

    await npm(fs).execute(['run', 'loop'], ctx);
    await npm(fs).execute(['run', 'pick'], ctx);

    expect(calls.map((c) => c.command)).toEqual([
      'for tsup in a b; do echo $tsup; done',
      'case tsup in *) echo x;; esac',
    ]);
  });

  it('leaves registered commands, unknown words, and paths untouched', async () => {
    await writeManifest(fs, '/work', {
      name: 'demo',
      scripts: {
        registered: 'tsc --noEmit',
        unknown: 'definitely-not-installed --x',
        path: './scripts/build.jsh',
      },
    });
    await writeBinShim(fs, '/work', 'tsc');
    const { ctx, calls } = harness('/work', { registered: ['tsc'] });

    await npm(fs).execute(['run', 'registered'], ctx);
    await npm(fs).execute(['run', 'unknown'], ctx);
    await npm(fs).execute(['run', 'path'], ctx);

    expect(calls.map((c) => c.command)).toEqual([
      'tsc --noEmit',
      'definitely-not-installed --x',
      './scripts/build.jsh',
    ]);
  });
});
