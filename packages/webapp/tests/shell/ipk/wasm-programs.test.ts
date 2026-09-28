import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { GLOBAL_NODE_MODULES } from '../../../src/shell/ipk/global-prefix.js';
import {
  commandsFromManifest,
  isInstalledProgramPath,
  isProgramFs,
  scanWasmCommands,
} from '../../../src/shell/ipk/wasm-programs.js';

let dbCounter = 0;

async function install(fs: VirtualFS, name: string, pkg: object, files: string[] = []) {
  const dir = `${GLOBAL_NODE_MODULES}/${name}`;
  await fs.mkdir(`${dir}/bin`, { recursive: true });
  await fs.writeFile(`${dir}/package.json`, JSON.stringify({ name, ...pkg }));
  for (const file of files) await fs.writeFile(`${dir}/${file}`, 'x');
}

describe('commandsFromManifest', () => {
  const dir = '/m/pkg';

  it('gives commands the manifest’s env defaults, package paths resolved inside the package', () => {
    const [magick, convert] = commandsFromManifest(dir, {
      name: 'im',
      slicc: {
        env: { MAGICK_CONFIGURE_PATH: 'etc/ImageMagick-7', LANG: 'C.UTF-8', 'bad-name': 'x' },
        commands: {
          magick: { glue: 'bin/magick', wasm: 'bin/magick.wasm' },
          convert: {
            glue: 'bin/magick',
            wasm: 'bin/magick.wasm',
            argv0: 'convert',
            env: { LANG: 'POSIX', HOME_DIR: '${package}/share', ESCAPE: '../outside', N: 3 },
          },
        },
      },
    });
    expect(magick?.env).toEqual({
      MAGICK_CONFIGURE_PATH: `${dir}/etc/ImageMagick-7`,
      LANG: 'C.UTF-8',
    });

    expect(convert?.env).toEqual({
      MAGICK_CONFIGURE_PATH: `${dir}/etc/ImageMagick-7`,
      LANG: 'POSIX',
      HOME_DIR: `${dir}/share`,
    });
    const [plain] = commandsFromManifest(dir, {
      slicc: { commands: { x: { glue: 'bin/x', wasm: 'bin/x.wasm' } } },
    });
    expect(plain).not.toHaveProperty('env');
  });

  it('maps each declared command to absolute glue and module paths', () => {
    const commands = commandsFromManifest(dir, {
      name: 'pkg',
      slicc: {
        abi: 'emscripten',
        commands: {
          ls: { glue: 'bin/coreutils', wasm: './bin/coreutils.wasm', argv0: 'ls' },
          sed: { glue: 'bin/sed', wasm: 'bin/sed.wasm' },
        },
      },
    });
    expect(commands).toEqual([
      {
        name: 'ls',
        glue: `${dir}/bin/coreutils`,
        wasm: `${dir}/bin/coreutils.wasm`,
        argv0: 'ls',
        pkg: 'pkg',
      },
      {
        name: 'sed',
        glue: `${dir}/bin/sed`,
        wasm: `${dir}/bin/sed.wasm`,
        argv0: 'sed',
        pkg: 'pkg',
      },
    ]);
  });

  it('drops commands that escape the package, have bad names, or miss a path', () => {
    const commands = commandsFromManifest(dir, {
      slicc: {
        commands: {
          up: { glue: '../x', wasm: 'x.wasm' },
          abs: { glue: '/etc/x', wasm: 'x.wasm' },
          'a/b': { glue: 'x', wasm: 'x.wasm' },
          nowasm: { glue: 'x' },
          bad: 'x',
        },
      },
    });
    expect(commands).toEqual([]);
  });

  it('ignores an ABI the realm does not run', () => {
    const pkg = { slicc: { abi: 'wasi', commands: { x: { glue: 'x', wasm: 'x.wasm' } } } };
    expect(commandsFromManifest(dir, pkg)).toEqual([]);
  });
});

describe('scanWasmCommands', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-wasm-programs-${dbCounter++}`, wipe: true });
  });

  it('is empty without a global node_modules', async () => {
    expect((await scanWasmCommands(fs, GLOBAL_NODE_MODULES)).size).toBe(0);
  });

  it('reads manifests of plain and scoped packages', async () => {
    await install(fs, 'tools', {
      slicc: { commands: { tool: { glue: 'bin/tool', wasm: 'bin/tool.wasm' } } },
    });
    await install(fs, '@x/more', {
      slicc: { commands: { more: { glue: 'more.js', wasm: 'more.wasm' } } },
    });
    await install(fs, 'left-pad', { main: 'index.js' });
    const commands = await scanWasmCommands(fs, GLOBAL_NODE_MODULES);
    expect([...commands.keys()].sort()).toEqual(['more', 'tool']);
    expect(commands.get('more')?.glue).toBe(`${GLOBAL_NODE_MODULES}/@x/more/more.js`);
    expect(commands.get('tool')?.pkg).toBe('tools');
  });

  it('offers bin pairs of @ai-ecoverse/wasm-* packages without a manifest', async () => {
    await install(fs, '@ai-ecoverse/wasm-sed', {}, ['bin/sed', 'bin/sed.wasm', 'bin/README']);
    await install(fs, '@ai-ecoverse/other', {}, ['bin/nope', 'bin/nope.wasm']);
    const commands = await scanWasmCommands(fs, GLOBAL_NODE_MODULES);
    expect([...commands.keys()]).toEqual(['sed']);
    expect(commands.get('sed')).toEqual({
      name: 'sed',
      glue: `${GLOBAL_NODE_MODULES}/@ai-ecoverse/wasm-sed/bin/sed`,
      wasm: `${GLOBAL_NODE_MODULES}/@ai-ecoverse/wasm-sed/bin/sed.wasm`,
      argv0: 'sed',
      pkg: '@ai-ecoverse/wasm-sed',
    });
  });

  it('lets a manifest override the bin-pair fallback, even an empty one', async () => {
    await install(fs, '@ai-ecoverse/wasm-gnu', { slicc: { commands: {} } }, [
      'bin/gnu',
      'bin/gnu.wasm',
    ]);
    expect((await scanWasmCommands(fs, GLOBAL_NODE_MODULES)).size).toBe(0);
  });

  it('keeps the first package in order when two claim a name', async () => {
    const decl = (glue: string) => ({
      slicc: { commands: { dup: { glue, wasm: `${glue}.wasm` } } },
    });
    await install(fs, 'b-pkg', decl('b'));
    await install(fs, 'a-pkg', decl('a'));
    expect((await scanWasmCommands(fs, GLOBAL_NODE_MODULES)).get('dup')?.pkg).toBe('a-pkg');
  });

  it('skips a package with an unreadable package.json', async () => {
    await fs.mkdir(`${GLOBAL_NODE_MODULES}/broken`, { recursive: true });
    await fs.writeFile(`${GLOBAL_NODE_MODULES}/broken/package.json`, '{nope');
    expect((await scanWasmCommands(fs, GLOBAL_NODE_MODULES)).size).toBe(0);
  });
});

describe('helpers', () => {
  it('isProgramFs needs exists, readDir and readFile', () => {
    const fn = async () => undefined;
    expect(isProgramFs({ exists: fn, readDir: fn, readFile: fn })).toBe(true);
    expect(isProgramFs({ exists: fn, readFile: fn })).toBe(false);
    expect(isProgramFs(null)).toBe(false);
  });

  it('isInstalledProgramPath matches manifests and modules under the global prefix', () => {
    expect(isInstalledProgramPath(`${GLOBAL_NODE_MODULES}/x/package.json`)).toBe(true);
    expect(isInstalledProgramPath(`${GLOBAL_NODE_MODULES}/@a/b/bin/b.wasm`)).toBe(true);
    expect(isInstalledProgramPath(`${GLOBAL_NODE_MODULES}/x/index.js`)).toBe(false);
    expect(isInstalledProgramPath('/workspace/package.json')).toBe(false);
  });
});
