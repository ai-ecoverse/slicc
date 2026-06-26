import 'fake-indexeddb/auto';
import type { CommandContext, SecureFetch } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { PYODIDE_VERSION } from '../../../src/kernel/realm/py-realm-shared.js';
import { sha256Hex } from '../../../src/shell/di/fetcher.js';
import { createDiCommand } from '../../../src/shell/supplemental-commands/di-command.js';

type FetchResult = Awaited<ReturnType<SecureFetch>>;

const CDN_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

let dbCounter = 0;
async function newFs(): Promise<VirtualFS> {
  return VirtualFS.create({ dbName: `test-di-cmd-${dbCounter++}`, wipe: true });
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function ctx(cwd = '/workspace'): CommandContext {
  return {
    cwd,
    env: new Map<string, string>(),
    fs: undefined as never,
    stdin: '' as never,
  } as unknown as CommandContext;
}

interface Pkg {
  name: string;
  version: string;
}

async function fixtureFs(pkgs: Pkg[]): Promise<{ fs: VirtualFS; fetch: SecureFetch }> {
  const fs = await newFs();
  const files: Record<string, Uint8Array> = {};
  const lockPackages: Record<string, unknown> = {};
  for (const p of pkgs) {
    const fileName = `${p.name}-${p.version}-py3-none-any.whl`;
    const wheel = bytes(`${p.name}-wheel`);
    files[CDN_BASE + fileName] = wheel;
    lockPackages[p.name] = {
      name: p.name,
      version: p.version,
      file_name: fileName,
      sha256: await sha256Hex(wheel),
    };
  }
  await fs.mkdir('/workspace/node_modules/pyodide', { recursive: true });
  await fs.writeFile(
    '/workspace/node_modules/pyodide/pyodide-lock.json',
    JSON.stringify({ packages: lockPackages })
  );
  const fetch = (async (url: string): Promise<FetchResult> =>
    url in files
      ? { status: 200, statusText: 'OK', headers: {}, body: files[url], url }
      : {
          status: 404,
          statusText: 'Not Found',
          headers: {},
          body: bytes(''),
          url,
        }) as unknown as SecureFetch;
  return { fs, fetch };
}

describe('di-command argv surface', () => {
  it('di add <pkg> stages and reports success', async () => {
    const { fs, fetch } = await fixtureFs([{ name: 'micropip', version: '0.6.0' }]);
    const cmd = createDiCommand('di', { fs, fetch });
    const r = await cmd.execute(['add', 'micropip'], ctx());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/added micropip==0.6.0 \(pyodide-cdn\)/);
  });

  it('di add <pkg>@<ver> uses the exact version', async () => {
    const { fs, fetch } = await fixtureFs([{ name: 'micropip', version: '0.6.0' }]);
    const cmd = createDiCommand('di', { fs, fetch });
    const r = await cmd.execute(['add', 'micropip@0.6.0'], ctx());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/micropip==0.6.0/);
  });

  it('di add a b c installs multiple packages', async () => {
    const { fs, fetch } = await fixtureFs([
      { name: 'aaa', version: '1.0.0' },
      { name: 'bbb', version: '2.0.0' },
      { name: 'ccc', version: '3.0.0' },
    ]);
    const cmd = createDiCommand('di', { fs, fetch });
    const r = await cmd.execute(['add', 'aaa', 'bbb', 'ccc'], ctx());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/aaa==1.0.0/);
    expect(r.stdout).toMatch(/bbb==2.0.0/);
    expect(r.stdout).toMatch(/ccc==3.0.0/);
  });

  it('di add with no package errors', async () => {
    const { fs, fetch } = await fixtureFs([]);
    const cmd = createDiCommand('di', { fs, fetch });
    const r = await cmd.execute(['add'], ctx());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/requires at least one package/);
  });

  it('di list prints recorded packages', async () => {
    const { fs, fetch } = await fixtureFs([{ name: 'micropip', version: '0.6.0' }]);
    const cmd = createDiCommand('di', { fs, fetch });
    await cmd.execute(['add', 'micropip'], ctx());
    const r = await cmd.execute(['list'], ctx());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/micropip/);
    expect(r.stdout).toMatch(/pyodide-cdn/);
  });

  it('an unknown verb is not implemented and exits non-zero', async () => {
    const { fs, fetch } = await fixtureFs([]);
    const cmd = createDiCommand('di', { fs, fetch });
    const r = await cmd.execute(['frobnicate'], ctx());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/not implemented in SLICC's di\/uv subset/);
    expect(r.stderr).toMatch(/di --help/);
  });

  it('--help exits zero; bare invocation exits non-zero with usage', async () => {
    const { fs, fetch } = await fixtureFs([]);
    const cmd = createDiCommand('di', { fs, fetch });
    const help = await cmd.execute(['--help'], ctx());
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toMatch(/Usage:/);
    const bare = await cmd.execute([], ctx());
    expect(bare.exitCode).toBe(1);
  });

  it('the uv alias shares the handler and rejects real-uv subcommands', async () => {
    const { fs, fetch } = await fixtureFs([{ name: 'micropip', version: '0.6.0' }]);
    const uv = createDiCommand('uv', { fs, fetch });
    const add = await uv.execute(['add', 'micropip'], ctx());
    expect(add.exitCode).toBe(0);
    expect(add.stdout).toMatch(/micropip==0.6.0/);
    const venv = await uv.execute(['venv'], ctx());
    expect(venv.exitCode).toBe(1);
    expect(venv.stderr).toMatch(/not implemented in SLICC's di\/uv subset/);
  });
});
