/**
 * `discover` shell command — fetch a URL and surface RFC 8288 / RFC 9727
 * link-discovery results as JSON. The primary fetch and every `--follow`
 * capability fetch route through the proxied fetch the shell uses for
 * `curl` / `upskill`, so the command inherits CORS bypass, header
 * forbidden-list bridging, and origin parity.
 *
 * Output shape (JSON):
 *
 *   {
 *     "url": "https://example.com/foo",
 *     "status": 200,
 *     "links": [...],          // every parsed Link header
 *     "handoff": null | {...}, // SLICC handoff verb match, when present
 *     "discovery": {           // populated when --follow is set
 *       "catalog": ...,
 *       "serviceDesc": ...,
 *       "llmsTxt": ...,
 *       "failures": [...]
 *     }
 *   }
 *
 * Designed to be small and forward-compatible — the broader playwright-cli
 * integration in #476's acceptance criteria can lift this same module
 * once the navigation flow is plumbed for response headers.
 */

import { defineCommand } from 'just-bash';
import type { Command, SecureFetch } from 'just-bash';
import { discoverLinks } from '../../net/discover-links.js';
import { extractHandoff } from '../../net/handoff-link.js';
import { parseLinkHeader } from '../../net/link-header.js';
import { createProxiedFetch } from '../proxied-fetch.js';

/**
 * Wrap a `SecureFetch` so it can stand in for the Web Fetch API. Used to
 * give `discoverLinks` (which speaks Web Fetch) the same CORS bypass /
 * forbidden-header bridging the rest of the shell enjoys.
 *
 * The adapter doesn't thread `AbortSignal` into the underlying secure fetch
 * (the SecureFetch contract has no signal slot) — `discoverLinks` already
 * caps each call with its own timeout and tolerates non-aborting fetches.
 */
function asWebFetch(secureFetch: SecureFetch): typeof fetch {
  const adapter = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const result = await secureFetch(url, { method: init?.method ?? 'GET' });
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
  discover https://www.sliccy.ai/handoff?handoff=demo
  discover --follow https://www.sliccy.ai/llms.txt
`;
}

export function createDiscoverCommand(): Command {
  return defineCommand('discover', async (args) => {
    if (args.includes('--help') || args.includes('-h') || args.length === 0) {
      return { stdout: helpText(), stderr: '', exitCode: 0 };
    }

    const follow = args.includes('--follow');
    const positional = args.filter((a) => !a.startsWith('-'));
    if (positional.length !== 1) {
      return {
        stdout: '',
        stderr: 'discover: expected exactly one URL argument\n',
        exitCode: 2,
      };
    }
    const url = positional[0];

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

    const result: Record<string, unknown> = {
      url,
      status: response.status,
      links,
      handoff,
    };

    if (follow && links.length > 0) {
      // Route follow-up capability fetches through the same proxied fetch
      // the shell uses elsewhere — without this, browser CORS would block
      // most cross-origin discovery in CLI mode.
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
