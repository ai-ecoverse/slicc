/**
 * ipk-installed Python packages on an ipk-installed interpreter's path: the
 * manifests' `slicc.python` blocks, which packages match the interpreter,
 * and the `_slicc_packages.pth` written into its user site.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { GLOBAL_NODE_MODULES } from '../../../src/shell/ipk/global-prefix.js';
import {
  ensurePth,
  matches,
  type PythonInterpreter,
  pthFor,
  pthPath,
  pythonOf,
} from '../../../src/shell/ipk/python-packages.js';
import { scanPythonPackages } from '../../../src/shell/ipk/wasm-programs.js';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';

const CP314: PythonInterpreter = {
  pkg: '@ai-ecoverse/py-cpython',
  version: '3.14',
  abi: 'cp314',
  platform: 'wasix_wasm32',
};

describe('slicc.python in a manifest', () => {
  it('an interpreter declares version, abi and platform; a package its site-packages (and what it needs)', () => {
    expect(
      pythonOf('/m/cpython', 'cpython', {
        version: '3.14',
        abi: 'cp314',
        platform: 'wasix_wasm32',
        sitePackages: 'lib/python3.14/site-packages',
      })
    ).toEqual({
      interpreter: { pkg: 'cpython', version: '3.14', abi: 'cp314', platform: 'wasix_wasm32' },
      package: { pkg: 'cpython', sitePackages: '/m/cpython/lib/python3.14/site-packages' },
    });
    expect(
      pythonOf('/m/numpy', 'py-numpy', {
        sitePackages: 'lib/python3.14/site-packages/',
        requires: { abi: 'cp314', platform: 'wasix_wasm32' },
      }).package
    ).toEqual({
      pkg: 'py-numpy',
      sitePackages: '/m/numpy/lib/python3.14/site-packages',
      requires: { abi: 'cp314', platform: 'wasix_wasm32' },
    });
    // Nothing outside the package, nothing half-declared.
    expect(pythonOf('/m/x', 'x', { sitePackages: '../../etc' })).toEqual({});
    expect(pythonOf('/m/x', 'x', { sitePackages: '/etc' })).toEqual({});
    expect(pythonOf('/m/x', 'x', { version: '3.14' })).toEqual({});
    expect(pythonOf('/m/x', 'x', undefined)).toEqual({});
  });

  it('pure Python goes with any interpreter; C extensions with the ABI and platform they were built for', () => {
    const pure = { pkg: 'six', sitePackages: '/s' };
    expect(matches(pure, CP314)).toBe(true);
    expect(matches({ ...pure, requires: { abi: 'none' } }, CP314)).toBe(true);
    expect(matches({ ...pure, requires: { abi: 'cp314', platform: 'wasix_wasm32' } }, CP314)).toBe(
      true
    );
    expect(matches({ ...pure, requires: { abi: 'cp313', platform: 'wasix_wasm32' } }, CP314)).toBe(
      false
    );
    expect(
      matches({ ...pure, requires: { abi: 'cp314', platform: 'emscripten_wasm32' } }, CP314)
    ).toBe(false);
  });

  it('the .pth adds each matching package as a site dir; the others are left out', () => {
    const { text, skipped } = pthFor(CP314, [
      {
        pkg: 'py-numpy',
        sitePackages: '/n/site',
        requires: { abi: 'cp314', platform: 'wasix_wasm32' },
      },
      { pkg: 'py-old', sitePackages: '/o/site', requires: { abi: 'cp312' } },
      { pkg: 'py-six', sitePackages: '/s/site' },
    ]);
    expect(text.split('\n').filter((l) => l.startsWith('import'))).toEqual([
      'import site; site.addsitedir("/n/site")',
      'import site; site.addsitedir("/s/site")',
    ]);
    expect(skipped.map((p) => p.pkg)).toEqual(['py-old']);
    expect(pthPath('/home/', '3.14')).toBe(
      '/home/.local/lib/python3.14/site-packages/_slicc_packages.pth'
    );
  });
});

describe('installed packages', () => {
  it('scans the manifests, and writes the .pth only when it changed', async () => {
    const vfs = await VirtualFS.create({ dbName: `py-packages-${Math.random()}`, wipe: true });
    const install = async (name: string, python: object) => {
      const dir = `${GLOBAL_NODE_MODULES}/${name}`;
      await vfs.mkdir(dir, { recursive: true });
      await vfs.writeFile(`${dir}/package.json`, JSON.stringify({ name, slicc: { python } }));
    };
    await install('@ai-ecoverse/py-cpython', {
      version: '3.14',
      abi: 'cp314',
      platform: 'wasix_wasm32',
      sitePackages: 'lib/python3.14/site-packages',
    });
    await install('@ai-ecoverse/py-numpy', {
      sitePackages: 'lib/python3.14/site-packages',
      requires: { abi: 'cp314', platform: 'wasix_wasm32' },
    });
    const fs = new VfsAdapter(vfs);
    const programFs = {
      exists: (p: string) => fs.exists(p),
      readDir: async (p: string) => (await fs.readdir(p)).map((name) => ({ name })),
      readFile: (p: string) => fs.readFile(p),
    };
    const { interpreters, packages } = await scanPythonPackages(programFs, GLOBAL_NODE_MODULES);
    const interp = interpreters.get('@ai-ecoverse/py-cpython') as PythonInterpreter;
    expect(interp).toEqual(CP314);
    expect(packages.map((p) => p.pkg)).toEqual([
      '@ai-ecoverse/py-cpython',
      '@ai-ecoverse/py-numpy',
    ]);
    expect(await ensurePth(fs, '/home', interp, packages)).toEqual([]);
    const path = pthPath('/home', '3.14');
    const first = await fs.readFile(path);
    expect(first).toContain(
      `site.addsitedir("${GLOBAL_NODE_MODULES}/@ai-ecoverse/py-numpy/lib/python3.14/site-packages")`
    );
    const written = (await vfs.stat(path)).mtime;
    await new Promise((r) => setTimeout(r, 5));
    await ensurePth(fs, '/home', interp, packages);
    expect((await vfs.stat(path)).mtime).toEqual(written);
  });
});
