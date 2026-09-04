/**
 * `id` — the SLICC runtime's user and group identity.
 *
 * Advertised on the homepage and at `/man/id` but never implemented, so it
 * answered 127 (#2819). There is no uid in a browser sandbox, so the question
 * the issue asked first is what identity even means here. The answer the rest
 * of the codebase already gives: **home directories**.
 *
 * `shell/home-dir.ts` resolves `$HOME` from the `/home` tree (onboarding's
 * `/home/<slug>`) and `$USER` follows as its basename; a scoop's shell env
 * pins `HOME=/scoops/<folder>/home` and `USER=<folder>`
 * (`scoops/scoop-context/shell-env.ts`). So the shell already knows who it is
 * — `id` just reports it in id(1)'s shape.
 *
 * The numbers follow from the same split, which is the one identity
 * distinction the codebase treats as fundamental (cone and scoop are roles
 * over one WorkUnit):
 *
 *   - A **cone** is the human user. uid 1000, like the first account on any
 *     Linux install — and every cone shares it, because every cone shares the
 *     one `/home/<slug>`.
 *   - A **scoop** is a service identity. Its uid is derived from its folder
 *     name so it is stable across reloads and distinct per scoop, without a
 *     passwd file to keep in sync.
 *
 * Group membership is a user-private group (the useradd convention: same name
 * and number as the user) plus the role group, `cone` or `scoop`.
 */

import type { Command, IFileSystem, ResolvedCommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { readSliccVersion } from '../../base/slicc-version.js';
import { type HomeDirFS, resolveHomeDir, userFromHome } from '../home-dir.js';

type CmdResult = { stdout: string; stderr: string; exitCode: number };

/** The human user. One per runtime: every cone resolves to the same `/home`. */
export const CONE_UID = 1000;

/** Role groups. Low numbers — these are the runtime's own, not a user's. */
export const CONE_GID = 10;
export const SCOOP_GID = 20;

const USAGE = 'usage: id [-u|-g|-G] [-n] [-r] [USER]';

const HELP = `${USAGE}

Print the user and group identity of this SLICC runtime.

Options:
  -u, --user     Print only the user ID.
  -g, --group    Print only the primary group ID.
  -G, --groups   Print all group IDs.
  -n, --name     Print names instead of numbers (needs -u, -g, or -G).
  -r, --real     Print the real ID. SLICC has no setuid, so the real and
                 effective IDs are always the same; accepted for scripts.
  --help         This text.
  --version      Print the SLICC build.

Identity comes from the home directory, which is where the rest of the shell
gets it too. A cone is the human user (uid ${CONE_UID}, one per runtime, since every
cone shares one home); a scoop is a service identity whose uid is derived from
its folder name, so it is stable across reloads and distinct per scoop.
Every user is in a user-private group of the same name, plus the role group
\`cone\` (${CONE_GID}) or \`scoop\` (${SCOOP_GID}).
`;

/** Scoop uids live above the human's, in a range no cone can reach. */
const SCOOP_UID_BASE = 2000;
const SCOOP_UID_SPAN = 58_000;

/** The prefix a scoop's home always has (`scoops/scoop-context/shell-env.ts`). */
const SCOOP_HOME_PREFIX = '/scoops/';

export type IdentityRole = 'cone' | 'scoop';

export interface Identity {
  name: string;
  uid: number;
  role: IdentityRole;
}

/**
 * FNV-1a over the scoop folder, mapped into the scoop uid range.
 *
 * A scoop needs a number that is the same in every shell and after every
 * reload without a passwd file to keep in sync, and folders are already the
 * unique, stable name a scoop has. Collisions are possible and harmless: the
 * name in parentheses is the identity that matters, exactly as it is for a
 * uid collision on a real system.
 */
export function scoopUid(folder: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < folder.length; index++) {
    hash ^= folder.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return SCOOP_UID_BASE + (hash % SCOOP_UID_SPAN);
}

/** Build the identity for a name in a known role. */
export function identityFor(name: string, role: IdentityRole): Identity {
  return { name, uid: role === 'cone' ? CONE_UID : scoopUid(name), role };
}

/** `id`'s group list: the user-private group, then the role group. */
export function groupsOf(identity: Identity): Array<{ gid: number; name: string }> {
  return [
    { gid: identity.uid, name: identity.name },
    identity.role === 'cone' ? { gid: CONE_GID, name: 'cone' } : { gid: SCOOP_GID, name: 'scoop' },
  ];
}

/** `1234(alice)` — id(1)'s number-and-name pair. */
function pair(id: number, name: string): string {
  return `${id}(${name})`;
}

export function renderIdentity(identity: Identity): string {
  const groups = groupsOf(identity);
  const primary = groups[0];
  return (
    `uid=${pair(identity.uid, identity.name)} ` +
    `gid=${pair(primary.gid, primary.name)} ` +
    `groups=${groups.map((group) => pair(group.gid, group.name)).join(',')}\n`
  );
}

/**
 * Who this shell is, from its own environment.
 *
 * `$USER` and `$HOME` are set before the first command runs
 * (`initHomeAndProfile`), and a scoop's are pinned by `buildScoopShellEnv`, so
 * the env is authoritative. The `/home` scan is the fallback for a shell that
 * somehow has neither — the same resolver `$HOME` itself came from.
 */
export async function currentIdentity(ctx: ResolvedCommandContext): Promise<Identity> {
  const home = ctx.env.get('HOME') ?? '';
  const role: IdentityRole = home.startsWith(SCOOP_HOME_PREFIX) ? 'scoop' : 'cone';
  const fromEnv = ctx.env.get('USER') || (home ? userFromHome(home) : '');
  if (fromEnv) return identityFor(fromEnv, role);
  return identityFor(userFromHome(await resolveHomeDir(homeDirFsFor(ctx.fs))), 'cone');
}

/**
 * Adapt the shell's `IFileSystem` to the minimal surface `resolveHomeDir`
 * declares. A backend without `readdirWithFileTypes` yields no candidates and
 * the resolver falls back to its default home, which is the same answer this
 * defensive path would otherwise have to invent.
 */
function homeDirFsFor(fs: IFileSystem): HomeDirFS {
  return {
    readDir: async (path) => {
      const entries = (await fs.readdirWithFileTypes?.(path)) ?? [];
      return entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory ? 'directory' : 'file',
      }));
    },
    stat: async (path) => ({ mtime: (await fs.stat(path)).mtime.getTime() }),
  };
}

/**
 * Look a named user up the way the runtime stores them: a cone lives in
 * `/home/<name>`, a scoop in `/scoops/<name>`. Anything else is not a user
 * here, and saying so beats inventing an identity for it.
 */
export async function lookupIdentity(
  ctx: ResolvedCommandContext,
  name: string
): Promise<Identity | null> {
  if (await ctx.fs.exists(`/home/${name}`).catch(() => false)) return identityFor(name, 'cone');
  if (await ctx.fs.exists(`${SCOOP_HOME_PREFIX}${name}`).catch(() => false)) {
    return identityFor(name, 'scoop');
  }
  return null;
}

interface IdArgs {
  select: 'all' | 'user' | 'group' | 'groups';
  names: boolean;
  operand?: string;
  mode: 'run' | 'help' | 'version';
}

/**
 * Parse id(1)'s argv. Short flags bundle (`id -un`), and `-r` is accepted and
 * dropped: SLICC has no setuid, so the real and effective IDs never differ.
 */
export function parseIdArgs(args: readonly string[]): IdArgs | { error: string } {
  const out: IdArgs = { select: 'all', names: false, mode: 'run' };
  const operands: string[] = [];
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') return { ...out, mode: 'help' };
    if (arg === '--version') return { ...out, mode: 'version' };
    const long = LONG_FLAGS[arg];
    if (long) {
      long(out);
      continue;
    }
    if (arg.length > 1 && arg.startsWith('-')) {
      for (const letter of arg.slice(1)) {
        const short = SHORT_FLAGS[letter];
        if (!short) return { error: `unrecognized option '-${letter}'` };
        short(out);
      }
      continue;
    }
    operands.push(arg);
  }
  if (operands.length > 1) return { error: `extra operand '${operands[1]}'` };
  if (operands[0] !== undefined) out.operand = operands[0];
  if (out.names && out.select === 'all') {
    return { error: 'cannot print only names in default format' };
  }
  return out;
}

const SHORT_FLAGS: Record<string, ((out: IdArgs) => void) | undefined> = {
  u: (out) => {
    out.select = 'user';
  },
  g: (out) => {
    out.select = 'group';
  },
  G: (out) => {
    out.select = 'groups';
  },
  n: (out) => {
    out.names = true;
  },
  // No setuid in a browser: the real ID is the effective one.
  r: () => undefined,
};

const LONG_FLAGS: Record<string, ((out: IdArgs) => void) | undefined> = {
  '--user': SHORT_FLAGS.u,
  '--group': SHORT_FLAGS.g,
  '--groups': SHORT_FLAGS.G,
  '--name': SHORT_FLAGS.n,
  '--real': SHORT_FLAGS.r,
};

/** The selected field(s), as numbers or names. */
export function renderSelection(identity: Identity, args: IdArgs): string {
  const groups = groupsOf(identity);
  const show = (id: number, name: string): string => (args.names ? name : String(id));
  switch (args.select) {
    case 'user':
      return `${show(identity.uid, identity.name)}\n`;
    case 'group':
      return `${show(groups[0].gid, groups[0].name)}\n`;
    case 'groups':
      return `${groups.map((group) => show(group.gid, group.name)).join(' ')}\n`;
    case 'all':
      return renderIdentity(identity);
  }
}

export function createIdCommand(): Command {
  return defineCommand('id', async (args, ctx) => {
    const parsed = parseIdArgs(args);
    if ('error' in parsed) {
      return { stdout: '', stderr: `id: ${parsed.error}\n${USAGE}\n`, exitCode: 1 };
    }
    if (parsed.mode === 'help') return ok(HELP);
    if (parsed.mode === 'version') return ok(`id (SLICC) ${readSliccVersion().version}\n`);

    const identity =
      parsed.operand === undefined
        ? await currentIdentity(ctx)
        : await lookupIdentity(ctx, parsed.operand);
    if (!identity) {
      return { stdout: '', stderr: `id: '${parsed.operand}': no such user\n`, exitCode: 1 };
    }
    return ok(renderSelection(identity, parsed));
  });
}

/**
 * `whoami` — the same name `id -un` prints.
 *
 * just-bash's bundled `whoami` returns the literal `user` regardless of the
 * environment, so shipping `id` without this would put two commands in the
 * same shell that disagree about who is running it: `id -un` reads the home
 * directory onboarding created (or the scoop folder), `whoami` did not. A
 * bundled command can be shadowed the way `rm` / `stat` already are
 * (`symlink-aware-file-commands.ts`). On a profile that never onboarded both
 * still answer `user`; they only diverged where the old answer was wrong.
 */
export function createWhoamiCommand(): Command {
  return defineCommand('whoami', async (_args, ctx) =>
    ok(`${(await currentIdentity(ctx)).name}\n`)
  );
}

function ok(stdout: string): CmdResult {
  return { stdout, stderr: '', exitCode: 0 };
}
