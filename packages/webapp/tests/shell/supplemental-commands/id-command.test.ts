/**
 * `id` was advertised on the homepage and at /man/id but answered 127 (#2819).
 * The open question the issue raised was what identity means in a browser
 * sandbox; these tests pin the answer the implementation gives — the home
 * directory the rest of the shell already uses.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../../src/shell/almost-bash-shell-headless.js';
import {
  CONE_GID,
  CONE_UID,
  createIdCommand,
  currentIdentity,
  groupsOf,
  identityFor,
  lookupIdentity,
  parseIdArgs,
  renderIdentity,
  SCOOP_GID,
  scoopUid,
} from '../../../src/shell/supplemental-commands/id-command.js';
import { createSupplementalCommands } from '../../../src/shell/supplemental-commands/index.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

let dbCounter = 0;
let vfs: VirtualFS;
let shell: AlmostBashShellHeadless;

function ctxWith(env: Record<string, string>, exists: (path: string) => boolean = () => false) {
  return mockCommandContext({
    env: new Map(Object.entries(env)),
    fs: { exists: async (path: string) => exists(path) },
  });
}

async function run(args: string[], env: Record<string, string> = { HOME: '/home/alice' }) {
  return createIdCommand().execute(args, ctxWith(env));
}

beforeEach(async () => {
  vfs = await VirtualFS.create({ dbName: `id-cmd-${dbCounter++}`, wipe: true });
  await vfs.mkdir('/home/alice', { recursive: true });
  shell = new AlmostBashShellHeadless({ fs: vfs });
});

describe('id registration', () => {
  it('is registered, so `id` is not "command not found"', () => {
    expect(createSupplementalCommands().map((command) => command.name)).toContain('id');
  });

  it('answers --version instead of 127', async () => {
    const result = await run(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^id \(SLICC\) \d/);
  });

  it('runs through the real shell and is listed by `commands` and `which`', async () => {
    const result = await shell.executeCommand('id');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^uid=\d+\(\S+\) gid=\d+\(\S+\) groups=/);
    expect((await shell.executeCommand('commands')).stdout).toContain('id');
    expect((await shell.executeCommand('which id')).exitCode).toBe(0);
  });

  it('reports the home directory the shell resolved', async () => {
    const identity = await shell.executeCommand('id -un');
    expect(identity.stdout.trim()).toBe('alice');
  });

  it('agrees with whoami, which upstream hardcodes to `user`', async () => {
    // just-bash's bundled `whoami` ignores the environment entirely. Shipping
    // `id` without shadowing it would put two commands in the same shell that
    // disagree about who is running it.
    const whoami = await shell.executeCommand('whoami');
    expect(whoami.exitCode).toBe(0);
    expect(whoami.stdout.trim()).toBe('alice');
  });

  it('leaves whoami answering `user` on a profile that never onboarded', async () => {
    const fresh = await VirtualFS.create({ dbName: `id-fresh-${dbCounter++}`, wipe: true });
    const freshShell = new AlmostBashShellHeadless({ fs: fresh });
    expect((await freshShell.executeCommand('whoami')).stdout.trim()).toBe('user');
  });
});

describe('id — the cone', () => {
  it('is uid 1000, the human user, in a user-private group plus `cone`', async () => {
    const result = await run([]);
    expect(result.stdout).toBe('uid=1000(alice) gid=1000(alice) groups=1000(alice),10(cone)\n');
  });

  it('takes the name from $USER when it differs from the home basename', async () => {
    const result = await run([], { HOME: '/home/alice', USER: 'pinned' });
    expect(result.stdout).toContain('uid=1000(pinned)');
  });

  it('falls back to the /home scan when the env carries neither', async () => {
    const identity = await currentIdentity(
      mockCommandContext({
        fs: {
          readdirWithFileTypes: async () => [
            { name: 'resolved', isFile: false, isDirectory: true, isSymbolicLink: false },
          ],
          stat: async () => ({ mtime: new Date(1) }) as never,
        },
      })
    );
    expect(identity).toEqual({ name: 'resolved', uid: CONE_UID, role: 'cone' });
  });
});

describe('id — a scoop', () => {
  const scoopEnv = { HOME: '/scoops/researcher/home', USER: 'researcher' };

  it('is a service identity in the scoop range, not the human uid', async () => {
    const result = await run([], scoopEnv);
    expect(result.stdout).toMatch(/^uid=\d+\(researcher\) /);
    expect(result.stdout).toContain(`,${SCOOP_GID}(scoop)`);
    expect(result.stdout).not.toContain(`uid=${CONE_UID}`);
  });

  it('names a scoop by its folder even when $USER is missing', async () => {
    // `/scoops/<folder>/home` is one level deeper than a cone's home, so a
    // plain basename would name every scoop `home` — an invented identity.
    const result = await run([], { HOME: '/scoops/researcher/home' });
    expect(result.stdout).toContain('(researcher)');
    expect(result.stdout).not.toContain('(home)');
  });

  it('derives a uid that is stable and distinct per folder', () => {
    expect(scoopUid('researcher')).toBe(scoopUid('researcher'));
    expect(scoopUid('researcher')).not.toBe(scoopUid('writer'));
    for (const folder of ['a', 'researcher', 'scoop-with-a-very-long-name', '']) {
      expect(scoopUid(folder)).toBeGreaterThanOrEqual(2000);
      expect(scoopUid(folder)).toBeLessThan(60_000);
    }
  });

  it('never collides with the cone uid', () => {
    for (const folder of ['a', 'b', 'cone', 'researcher', 'writer']) {
      expect(scoopUid(folder)).not.toBe(CONE_UID);
    }
  });
});

describe('id — selectors', () => {
  it('prints only the uid for -u, and the name for -un', async () => {
    expect((await run(['-u'])).stdout).toBe('1000\n');
    expect((await run(['-un'])).stdout).toBe('alice\n');
  });

  it('prints the primary group for -g', async () => {
    expect((await run(['-g'])).stdout).toBe('1000\n');
    expect((await run(['-gn'])).stdout).toBe('alice\n');
  });

  it('prints every group for -G', async () => {
    expect((await run(['-G'])).stdout).toBe(`1000 ${CONE_GID}\n`);
    expect((await run(['-Gn'])).stdout).toBe('alice cone\n');
  });

  it('accepts the long spellings', async () => {
    expect((await run(['--user', '--name'])).stdout).toBe('alice\n');
    expect((await run(['--groups'])).stdout).toBe(`1000 ${CONE_GID}\n`);
  });

  it('accepts -r without changing the answer — there is no setuid here', async () => {
    expect((await run(['-ur'])).stdout).toBe((await run(['-u'])).stdout);
  });

  it('refuses -n on its own, as id(1) does', async () => {
    const result = await run(['-n']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('cannot print only names');
  });

  it('refuses an unknown flag', async () => {
    const result = await run(['-Z']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unrecognized option '-Z'");
  });

  it('refuses a second operand', () => {
    expect(parseIdArgs(['alice', 'bob'])).toEqual({ error: "extra operand 'bob'" });
  });
});

describe('id USER', () => {
  it('resolves a cone from /home and a scoop from /scoops', async () => {
    const ctx = ctxWith({}, (path) => path === '/home/alice' || path === '/scoops/researcher');
    await expect(lookupIdentity(ctx, 'alice')).resolves.toEqual({
      name: 'alice',
      uid: CONE_UID,
      role: 'cone',
    });
    await expect(lookupIdentity(ctx, 'researcher')).resolves.toMatchObject({ role: 'scoop' });
  });

  it('says so rather than inventing an identity for an unknown name', async () => {
    const result = await createIdCommand().execute(['nobody'], ctxWith({}));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("id: 'nobody': no such user\n");
  });

  it('finds a real scoop home through the shell', async () => {
    await vfs.mkdir('/scoops/researcher/home', { recursive: true });
    const result = await shell.executeCommand('id researcher');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('(researcher)');
    expect(result.stdout).toContain(`${SCOOP_GID}(scoop)`);
  });
});

describe('identity helpers', () => {
  it('puts the user-private group first and the role group second', () => {
    expect(groupsOf(identityFor('alice', 'cone'))).toEqual([
      { gid: CONE_UID, name: 'alice' },
      { gid: CONE_GID, name: 'cone' },
    ]);
  });

  it('renders id(1)`s number(name) pairs', () => {
    expect(renderIdentity(identityFor('alice', 'cone'))).toBe(
      'uid=1000(alice) gid=1000(alice) groups=1000(alice),10(cone)\n'
    );
  });
});
