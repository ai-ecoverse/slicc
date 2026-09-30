import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { LocalMountBackend } from '../../../src/fs/mount/backend-local.js';
import { GLOBAL_NODE_MODULES } from '../../../src/shell/ipk/global-prefix.js';
import { scanPythonPackages, scanWasmCommands } from '../../../src/shell/ipk/wasm-programs.js';
import { runGoCommand } from '../../../src/shell/supplemental-commands/go/go-driver.js';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';
import { createDirectoryHandle } from '../../fs/fsa-test-helpers.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

describe('a package linked in from a mount', () => {
  it('is found by the wasm-command, Python and Go scans', async () => {
    const vfs = await VirtualFS.create({ dbName: `linked-pkg-${Math.random()}`, wipe: true });
    await vfs.mkdir('/mnt/live', { recursive: true });
    await vfs.mount(
      '/mnt/live',
      LocalMountBackend.fromHandle(
        createDirectoryHandle({
          tool: {
            'package.json': JSON.stringify({
              name: '@ai-ecoverse/wasm-tool',
              slicc: {
                abi: 'wasi',
                commands: { tool: { wasm: 'bin/tool.wasm' } },
                python: { sitePackages: 'site' },
                go: { version: 'go1.26.5', goroot: 'goroot' },
              },
            }),
            bin: { 'tool.wasm': '\0asm' },
            site: { 'mod.py': '' },
            goroot: { VERSION: 'go1.26.5' },
          },
        }),
        { mountId: 'linked-pkg' }
      )
    );
    await vfs.mkdir(`${GLOBAL_NODE_MODULES}/@ai-ecoverse`, { recursive: true });
    const linked = `${GLOBAL_NODE_MODULES}/@ai-ecoverse/wasm-tool`;
    await vfs.symlink('/mnt/live/tool', linked);

    const fs = new VfsAdapter(vfs);
    const programFs = {
      exists: (p: string) => fs.exists(p),
      readDir: async (p: string) => (await fs.readdir(p)).map((name) => ({ name })),
      readFile: (p: string) => fs.readFile(p),
    };
    const commands = await scanWasmCommands(programFs, GLOBAL_NODE_MODULES);
    expect(commands.get('tool')).toMatchObject({ abi: 'wasi', wasm: `${linked}/bin/tool.wasm` });
    expect(await fs.exists(`${linked}/bin/tool.wasm`)).toBe(true);
    const { packages } = await scanPythonPackages(programFs, GLOBAL_NODE_MODULES);
    expect(packages).toEqual([{ pkg: '@ai-ecoverse/wasm-tool', sitePackages: `${linked}/site` }]);
    const r = await runGoCommand(['version'], mockCommandContext({ cwd: '/', overrides: { fs } }));
    expect(r.stdout).toBe('go version go1.26.5 wasip1/wasm\n');
  });
});
