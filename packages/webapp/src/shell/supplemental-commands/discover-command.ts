import { SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';
import type { Command, SecureFetch } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { DiscoveryResult } from '../../net/discover-links.js';
import { discoverLinks } from '../../net/discover-links.js';
import type { HandoffMatch } from '../../net/handoff-link.js';
import { extractHandoff } from '../../net/handoff-link.js';
import type { ParsedLink } from '../../net/link-header.js';
import { parseLinkHeader } from '../../net/link-header.js';
import { createProxiedFetch } from '../proxied-fetch.js';
import { normalizeHeadersInit } from '../proxy-headers.js';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest } from './subcommand-help.js';

interface DiscoverOutput {
  url: string;
  status: number;
  links: ParsedLink[];
  handoff: HandoffMatch | null;
  discovery?: Pick<
    DiscoveryResult,
    'catalog' | 'serviceDesc' | 'serviceMeta' | 'status' | 'llmsTxt' | 'failures'
  >;
}

const DISCOVER_BOOL_FLAGS = ['--follow'] as const;

export function asWebFetch(secureFetch: SecureFetch): typeof fetch {
  const adapter = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = normalizeHeadersInit(init?.headers);
    const result = await secureFetch(url, {
      method: init?.method ?? 'GET',
      ...(headers ? { headers } : {}),
    });
    return new Response(result.body as BodyInit, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  };
  return adapter as typeof fetch;
}

function helpText(): string {
  return `discover — fetch a URL and parse RFC 8288 Link headers

Usage:
  discover <url>           Print parsed links (and any SLICC handoff match)
  discover --follow <url>  Also fetch P0 capability docs (api-catalog,
                           service-desc, service-meta, status, llms.txt)
                           and include them in the output
  discover --help          Show this help

Output is always JSON.

Examples:
  discover ${SLICC_HOSTED_ORIGIN}/handoff?handoff=demo
  discover --follow ${SLICC_HOSTED_ORIGIN}/llms.txt
`;
}

export function createDiscoverCommand(): Command {
  return defineCommand('discover', async (args) => {
    if (args.length === 0 || isHelpRequest(args)) {
      return { stdout: helpText(), stderr: '', exitCode: 0 };
    }

    const parsed = parseKnownFlags(args, { bool: DISCOVER_BOOL_FLAGS });
    if ('error' in parsed) {
      return {
        stdout: '',
        stderr: `discover: ${parsed.error}\n`,
        exitCode: 1,
      };
    }

    const follow = parsed.bools.has('--follow');
    if (parsed.positionals.length !== 1) {
      return {
        stdout: '',
        stderr: 'discover: expected exactly one URL argument\n',
        exitCode: 2,
      };
    }
    const url = parsed.positionals[0];

    const fetchProxied = createProxiedFetch();
    let response: Awaited<ReturnType<typeof fetchProxied>>;
    try {
      response = await fetchProxied(url, { method: 'GET' });
    } catch (err) {
      return {
        stdout: '',
        stderr: `discover: fetch failed: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }

    const linkValues: string[] = [];
    for (const [name, value] of Object.entries(response.headers)) {
      if (name.toLowerCase() === 'link' && typeof value === 'string' && value.length > 0) {
        linkValues.push(value);
      }
    }
    const links = parseLinkHeader(linkValues, url);
    const handoff = extractHandoff(links);

    const result: DiscoverOutput = {
      url,
      status: response.status,
      links,
      handoff,
    };

    if (follow && links.length > 0) {
      const discovery = await discoverLinks(links, { fetchImpl: asWebFetch(fetchProxied) });
      result.discovery = {
        catalog: discovery.catalog,
        serviceDesc: discovery.serviceDesc,
        serviceMeta: discovery.serviceMeta,
        status: discovery.status,
        llmsTxt: discovery.llmsTxt,
        failures: discovery.failures,
      };
    }

    return {
      stdout: JSON.stringify(result, null, 2) + '\n',
      stderr: '',
      exitCode: 0,
    };
  });
}
