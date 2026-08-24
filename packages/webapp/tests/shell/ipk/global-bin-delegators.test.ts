import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import {
  GlobalBinCollisionError,
  reconcileGlobalBinDelegators,
} from '../../../src/shell/ipk/global-bin-delegators.js';
import {
  GLOBAL_BIN_DELEGATOR_MARKER,
  GLOBAL_BIN_DIR,
} from '../../../src/shell/ipk/global-prefix.js';

let dbCounter = 0;
async function newFs(): Promise<VirtualFS> {
  return VirtualFS.create({ dbName: `test-global-bin-delegators-${dbCounter++}`, wipe: true });
}

describe('reconcileGlobalBinDelegators', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await newFs();
    await fs.mkdir(GLOBAL_BIN_DIR, { recursive: true });
  });

  it('writes a delegator that awaits exec.start and relays stdout/stderr/stdin', async () => {
    await reconcileGlobalBinDelegators(fs, new Set(['say']));
    const source = (await fs.readFile(`${GLOBAL_BIN_DIR}/say.jsh`)) as string;
    expect(source).toContain(GLOBAL_BIN_DELEGATOR_MARKER);
    expect(source).toContain("require('sliccy:exec')");
    expect(source).toContain('const { start }');
    expect(source).toContain('await __h.done');
    expect(source).toContain("'ipx', '--global', __bin");
    expect(source).toContain('process.stdout.write(__r.stdout)');
    expect(source).toContain('process.stderr.write(__r.stderr)');
    expect(source).toContain('process.exit(__r.exitCode)');
    expect(source).toContain('__stdin');
    expect(source).not.toContain('.then(');
    expect(source).not.toContain('(async');
  });

  it('refreshes an existing ipk-managed delegator', async () => {
    await reconcileGlobalBinDelegators(fs, new Set(['say']));
    await fs.writeFile(
      `${GLOBAL_BIN_DIR}/say.jsh`,
      `// ${GLOBAL_BIN_DELEGATOR_MARKER}\n// stale\n`
    );
    await reconcileGlobalBinDelegators(fs, new Set(['say']));
    const source = (await fs.readFile(`${GLOBAL_BIN_DIR}/say.jsh`)) as string;
    expect(source).toContain('await __h.done');
    expect(source).not.toContain('// stale');
  });

  it('refuses to overwrite a user-authored script', async () => {
    const path = `${GLOBAL_BIN_DIR}/say.jsh`;
    await fs.writeFile(path, '// user script\n');
    await expect(reconcileGlobalBinDelegators(fs, new Set(['say']))).rejects.toThrow(
      GlobalBinCollisionError
    );
    expect((await fs.readFile(path)) as string).toBe('// user script\n');
  });

  it('removes stale ipk delegators but leaves user scripts', async () => {
    await reconcileGlobalBinDelegators(fs, new Set(['keep']));
    await fs.writeFile(`${GLOBAL_BIN_DIR}/user.jsh`, '// user\n');
    await reconcileGlobalBinDelegators(fs, new Set(['keep']));
    expect(await fs.exists(`${GLOBAL_BIN_DIR}/keep.jsh`)).toBe(true);
    expect(await fs.exists(`${GLOBAL_BIN_DIR}/user.jsh`)).toBe(true);
  });
});
