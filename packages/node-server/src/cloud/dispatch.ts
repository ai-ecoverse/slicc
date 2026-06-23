import type { SubstrateId } from '@slicc/cloud-core';

export type ParsedCloudArgs =
  | {
      subcommand: 'start';
      args: { substrate: SubstrateId; name?: string; envFile?: string; template?: string };
    }
  | { subcommand: 'list'; args: { substrate: SubstrateId } }
  | { subcommand: 'pause'; args: { substrate: SubstrateId; query: string } }
  | { subcommand: 'resume'; args: { substrate: SubstrateId; query: string; envFile?: string } }
  | { subcommand: 'kill'; args: { substrate: SubstrateId; query: string } };

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

  const baseArgs: {
    substrate: SubstrateId;
    name?: string;
    envFile?: string;
    template?: string;
    query?: string;
  } = {
    substrate: 'e2b',
  };
  let i = 0;
  while (i < rest.length) {
    const a = rest[i];
    if (a === '--name') {
      baseArgs.name = rest[++i];
    } else if (a === '--env-file') {
      baseArgs.envFile = rest[++i];
    } else if (a === '--template') {
      // Substrate template alias to launch from (default 'slicc'). Lets
      // `--cloud start` boot an isolated test template (e.g. 'slicc-test')
      // built via SLICC_E2B_TEMPLATE_NAME without touching production.
      baseArgs.template = rest[++i];
    } else if (a === '--substrate') {
      const v = rest[++i];
      if (v !== 'e2b') throw new Error(`unsupported substrate: ${v} (MVP only supports 'e2b')`);
      baseArgs.substrate = v;
    } else if (
      !a.startsWith('--') &&
      !baseArgs.query &&
      (sub === 'pause' || sub === 'resume' || sub === 'kill')
    ) {
      baseArgs.query = a;
    } else {
      throw new Error(`unrecognized arg: ${a}`);
    }
    i++;
  }

  // Build discriminated union based on subcommand
  switch (sub) {
    case 'start':
      return {
        subcommand: 'start',
        args: {
          substrate: baseArgs.substrate,
          name: baseArgs.name,
          envFile: baseArgs.envFile,
          template: baseArgs.template,
        },
      };
    case 'list':
      return { subcommand: 'list', args: { substrate: baseArgs.substrate } };
    case 'pause':
    case 'kill':
      if (!baseArgs.query) {
        throw new Error(`${sub} requires a query argument (sandbox ID or name)`);
      }
      return {
        subcommand: sub,
        args: { substrate: baseArgs.substrate, query: baseArgs.query },
      };
    case 'resume':
      if (!baseArgs.query) {
        throw new Error(`${sub} requires a query argument (sandbox ID or name)`);
      }
      return {
        subcommand: 'resume',
        args: {
          substrate: baseArgs.substrate,
          query: baseArgs.query,
          envFile: baseArgs.envFile,
        },
      };
    default:
      throw new Error(`unknown subcommand: ${sub}`);
  }
}
