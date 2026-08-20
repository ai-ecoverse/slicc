import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FOLLOWER_STATUS_STORAGE_KEY,
  LEADER_STATUS_STORAGE_KEY,
} from '../../../src/base/tray-role.js';
import { readBundledVersion } from '../../../src/scoops/upgrade-detection.js';
import { createUnameCommand } from '../../../src/shell/supplemental-commands/uname-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const createMockCtx = () => mockCommandContext();

async function run(args: string[]) {
  return createUnameCommand().execute(args, createMockCtx());
}

/** Stub the page→worker tray-status shims `readTrayRole` reads. */
function stubTrayShims(entries: Record<string, unknown>): void {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key in entries ? JSON.stringify(entries[key]) : null),
  });
}

describe('uname command', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has correct name', () => {
    const cmd = createUnameCommand();
    expect(cmd.name).toBe('uname');
  });

  it('shows help with --help naming every supported flag', async () => {
    const result = await run(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: uname [-amnorsv]');
    for (const flag of ['-s', '-n', '-r', '-v', '-m', '-o', '-a']) {
      expect(result.stdout).toContain(`${flag}  `);
    }
    expect(result.stderr).toBe('');
  });

  it('prints the kernel name bare and with -s', async () => {
    for (const args of [[], ['-s']]) {
      const result = await run(args);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('SLICC\n');
      expect(result.stderr).toBe('');
    }
  });

  it('prints the running semantic version with -r', async () => {
    const result = await run(['-r']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${readBundledVersion().version}\n`);
  });

  it('prints the build stamp with -v', async () => {
    const result = await run(['-v']);

    expect(result.exitCode).toBe(0);
    // `__SLICC_BUILD_ID__` is `test-build` under vitest; no release date is baked.
    expect(result.stdout).toBe('test-build\n');
  });

  it('reports the tray role as the nodename with -n', async () => {
    stubTrayShims({});
    expect((await run(['-n'])).stdout).toBe('standalone\n');

    stubTrayShims({ [LEADER_STATUS_STORAGE_KEY]: { state: 'leader' } });
    expect((await run(['-n'])).stdout).toBe('leader\n');

    // A runtime following someone else's tray reports `follower` even if a
    // stale leader status is still mirrored.
    stubTrayShims({
      [LEADER_STATUS_STORAGE_KEY]: { state: 'leader' },
      [FOLLOWER_STATUS_STORAGE_KEY]: { state: 'connected' },
    });
    expect((await run(['-n'])).stdout).toBe('follower\n');

    // An inactive follower mirror is not a follower.
    stubTrayShims({ [FOLLOWER_STATUS_STORAGE_KEY]: { state: 'inactive' } });
    expect((await run(['-n'])).stdout).toBe('standalone\n');
  });

  it('prints the realm platform with -m and the user agent with -o', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Test Browser/1.0' });

    expect((await run(['-m'])).stdout).toBe('MacIntel\n');
    expect((await run(['-o'])).stdout).toBe('Test Browser/1.0\n');
  });

  it('prefers userAgentData.platform over the deprecated navigator.platform', async () => {
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgentData: { platform: 'macOS' },
      userAgent: 'Test Browser/1.0',
    });

    expect((await run(['-m'])).stdout).toBe('macOS\n');
  });

  it('reports unknown rather than failing when the realm exposes no navigator', async () => {
    vi.stubGlobal('navigator', {});

    expect((await run(['-m'])).stdout).toBe('unknown\n');
    expect((await run(['-o'])).stdout).toBe('unknown\n');
    expect((await run(['-m'])).exitCode).toBe(0);
  });

  it('supports combined short flags and emits them in uname order', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Test Browser/1.0' });
    const version = readBundledVersion().version;

    const combined = await run(['-sr']);
    expect(combined.exitCode).toBe(0);
    expect(combined.stdout).toBe(`SLICC ${version}\n`);

    // Flag order given must not change the output order.
    const reversed = await run(['-rs']);
    expect(reversed.stdout).toBe(`SLICC ${version}\n`);

    // Separate flags behave the same, and repeats collapse.
    const separate = await run(['-r', '-s', '-s']);
    expect(separate.stdout).toBe(`SLICC ${version}\n`);
  });

  it('prints every field in uname order with -a', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Test Browser/1.0' });

    const result = await run(['-a']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `SLICC standalone ${readBundledVersion().version} test-build MacIntel Test Browser/1.0\n`
    );
  });

  it('prints a usage line naming the supported flags for an unknown flag', async () => {
    const result = await run(['-z']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe("uname: unrecognized option '-z'\nusage: uname [-amnorsv]\n");
  });

  it('rejects an unknown long option and a stray operand with the same usage line', async () => {
    const long = await run(['--kernel-name']);
    expect(long.exitCode).toBe(1);
    expect(long.stderr).toBe(
      "uname: unrecognized option '--kernel-name'\nusage: uname [-amnorsv]\n"
    );

    const operand = await run(['host']);
    expect(operand.exitCode).toBe(1);
    expect(operand.stderr).toBe("uname: extra operand 'host'\nusage: uname [-amnorsv]\n");
  });

  it('rejects an unknown flag inside a combined group', async () => {
    const result = await run(['-sz']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("uname: unrecognized option '-z'\nusage: uname [-amnorsv]\n");
  });
});
