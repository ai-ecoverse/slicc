import type { SubstrateId } from './substrate.js';

export interface ParsedCloudArgs {
  subcommand: 'start' | 'list' | 'pause' | 'resume' | 'kill';
  args: {
    substrate: SubstrateId;
    name?: string;
    envFile?: string;
    query?: string;
  };
}

const VALID_SUBCOMMANDS = ['start', 'list', 'pause', 'resume', 'kill'] as const;
type Sub = (typeof VALID_SUBCOMMANDS)[number];

export function parseCloudArgs(argv: string[]): ParsedCloudArgs | null {
  if (argv.includes('--hosted') && argv.includes('--cloud')) {
    throw new Error('--cloud and --hosted are mutually exclusive');
  }
  const cloudIdx = argv.indexOf('--cloud');
  if (cloudIdx === -1) return null;

  const sub = argv[cloudIdx + 1];
  if (!sub || !VALID_SUBCOMMANDS.includes(sub as Sub)) {
    throw new Error(
      `unknown subcommand: ${sub ?? '(none)'} (expected one of: ${VALID_SUBCOMMANDS.join(', ')})`
    );
  }
  const rest = argv.slice(cloudIdx + 2);

  const args: ParsedCloudArgs['args'] = { substrate: 'e2b' };
  let i = 0;
  while (i < rest.length) {
    const a = rest[i];
    if (a === '--name') {
      args.name = rest[++i];
    } else if (a === '--env-file') {
      args.envFile = rest[++i];
    } else if (a === '--substrate') {
      const v = rest[++i];
      if (v !== 'e2b') throw new Error(`unsupported substrate: ${v} (MVP only supports 'e2b')`);
      args.substrate = v;
    } else if (
      !a.startsWith('--') &&
      !args.query &&
      (sub === 'pause' || sub === 'resume' || sub === 'kill')
    ) {
      args.query = a;
    } else {
      throw new Error(`unrecognized arg: ${a}`);
    }
    i++;
  }

  return { subcommand: sub as Sub, args };
}
