import type { Command, IFileSystem, ResolvedCommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { readSliccVersion } from '../../base/slicc-version.js';
import { type HomeDirFS, resolveHomeDir, userFromHome } from '../home-dir.js';

type CmdResult = { stdout: string; stderr: string; exitCode: number };

export const CONE_UID = 1000;

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

const SCOOP_UID_BASE = 2000;
const SCOOP_UID_SPAN = 58_000;

const SCOOP_HOME_PREFIX = '/scoops/';

export type IdentityRole = 'cone' | 'scoop';

export interface Identity {
  name: string;
  uid: number;
  role: IdentityRole;
}

export function scoopUid(folder: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < folder.length; index++) {
    hash ^= folder.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return SCOOP_UID_BASE + (hash % SCOOP_UID_SPAN);
}

export function identityFor(name: string, role: IdentityRole): Identity {
  return { name, uid: role === 'cone' ? CONE_UID : scoopUid(name), role };
}

export function groupsOf(identity: Identity): Array<{ gid: number; name: string }> {
  return [
    { gid: identity.uid, name: identity.name },
    identity.role === 'cone' ? { gid: CONE_GID, name: 'cone' } : { gid: SCOOP_GID, name: 'scoop' },
  ];
}

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

export async function currentIdentity(ctx: ResolvedCommandContext): Promise<Identity> {
  const home = ctx.env.get('HOME') ?? '';
  const role: IdentityRole = home.startsWith(SCOOP_HOME_PREFIX) ? 'scoop' : 'cone';
  const fromEnv = ctx.env.get('USER') || nameFromHome(home, role);
  if (fromEnv) return identityFor(fromEnv, role);
  return identityFor(userFromHome(await resolveHomeDir(homeDirFsFor(ctx.fs))), 'cone');
}

function nameFromHome(home: string, role: IdentityRole): string {
  if (home === '') return '';
  if (role === 'cone') return userFromHome(home);
  return home.slice(SCOOP_HOME_PREFIX.length).split('/')[0] ?? '';
}

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

  r: () => undefined,
};

const LONG_FLAGS: Record<string, ((out: IdArgs) => void) | undefined> = {
  '--user': SHORT_FLAGS.u,
  '--group': SHORT_FLAGS.g,
  '--groups': SHORT_FLAGS.G,
  '--name': SHORT_FLAGS.n,
  '--real': SHORT_FLAGS.r,
};

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

export function createWhoamiCommand(): Command {
  return defineCommand('whoami', async (_args, ctx) =>
    ok(`${(await currentIdentity(ctx)).name}\n`)
  );
}

function ok(stdout: string): CmdResult {
  return { stdout, stderr: '', exitCode: 0 };
}
