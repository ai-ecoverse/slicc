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

interface BaseArgs {
  substrate: SubstrateId;
  name?: string;
  envFile?: string;
  template?: string;
  query?: string;
}

/** Subcommands that accept a positional query (sandbox ID or name). */
function takesQuery(sub: Sub): boolean {
  return sub === 'pause' || sub === 'resume' || sub === 'kill';
}

/**
 * Parse the flag list that follows `--cloud <subcommand>` into a flat
 * `BaseArgs` bag. The discriminated union is assembled later in
 * `buildParsedArgs`; keeping the two phases separate holds each function's
 * cognitive complexity under the biome cap.
 */
function parseBaseArgs(rest: string[], sub: Sub): BaseArgs {
  const baseArgs: BaseArgs = { substrate: 'e2b' };
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
    } else if (!a.startsWith('--') && !baseArgs.query && takesQuery(sub)) {
      baseArgs.query = a;
    } else {
      throw new Error(`unrecognized arg: ${a}`);
    }
    i++;
  }
  return baseArgs;
}

/** Require and return the positional query for the query-taking subcommands. */
function requireQuery(sub: Sub, query: string | undefined): string {
  if (!query) {
    throw new Error(`${sub} requires a query argument (sandbox ID or name)`);
  }
  return query;
}

/** Assemble the discriminated union from the parsed flag bag. */
function buildParsedArgs(sub: Sub, baseArgs: BaseArgs): ParsedCloudArgs {
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
      return {
        subcommand: sub,
        args: { substrate: baseArgs.substrate, query: requireQuery(sub, baseArgs.query) },
      };
    case 'resume':
      return {
        subcommand: 'resume',
        args: {
          substrate: baseArgs.substrate,
          query: requireQuery(sub, baseArgs.query),
          envFile: baseArgs.envFile,
        },
      };
  }
}

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

  const baseArgs = parseBaseArgs(argv.slice(cloudIdx + 2), sub as Sub);
  return buildParsedArgs(sub as Sub, baseArgs);
}
