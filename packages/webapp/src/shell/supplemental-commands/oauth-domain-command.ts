import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest } from './subcommand-help.js';

type CommandResult = { stdout: string; stderr: string; exitCode: number };
type DomainSettings = typeof import('../../providers/account-store.js');

function helpText(): string {
  return `oauth-domain — manage extra allowed domains for OAuth-issued tokens

Usage:
  oauth-domain list                       List extra domains for every provider
  oauth-domain list <providerId>          List extra domains for one provider
  oauth-domain add <providerId> <domain>  Add an extra domain (e.g. admin.da.live)
  oauth-domain remove <providerId> <domain>  Remove an extra domain
  oauth-domain clear <providerId>         Drop all extras for a provider
  oauth-domain --help                     Show this help

Provider hardcoded \`oauthTokenDomains\` are immutable safe defaults; this
command lets you LAYER additional allow-listed domains on top, per-provider.
Newly added domains apply on the next page reload — \`oauth-bootstrap\`
re-pushes the merged list to the proxy/SW at page-load time. (Re-running
\`oauth-token <providerId>\` only re-saves the token if it's actually
expired; for a fresh-token-but-updated-domains case, reload.)

Wildcards behave as elsewhere in the secret pipeline (\`*.example.com\` matches
\`api.example.com\` and \`uploads.example.com\`, NOT \`example.com\` itself).

Examples:
  oauth-domain add adobe admin.da.live
  oauth-domain add adobe '*.da.live'
  oauth-domain list adobe
  oauth-domain remove adobe admin.da.live
`;
}

function fail(message: string): CommandResult {
  return { stdout: '', stderr: `oauth-domain: ${message}\n`, exitCode: 1 };
}

function listDomains(settings: DomainSettings, providerId: string | undefined): CommandResult {
  if (providerId) {
    const list = settings.getExtraOAuthDomains(providerId);
    if (list.length === 0) {
      return {
        stdout: `(no extra domains configured for ${providerId})\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: `${list.join('\n')}\n`, stderr: '', exitCode: 0 };
  }

  const entries = Object.entries(settings.getAllExtraOAuthDomains()).filter(
    ([, domains]) => domains.length > 0
  );
  if (entries.length === 0) {
    return { stdout: '(no extra OAuth domains configured)\n', stderr: '', exitCode: 0 };
  }
  const lines = entries.map(([provider, domains]) => `${provider}: ${domains.join(', ')}`);
  return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0 };
}

async function addDomain(
  settings: DomainSettings,
  providerId: string | undefined,
  domain: string | undefined
): Promise<CommandResult> {
  if (!providerId || !domain) {
    return {
      stdout: '',
      stderr: 'oauth-domain add: requires <providerId> and <domain>\n',
      exitCode: 1,
    };
  }
  const current = settings.getExtraOAuthDomains(providerId);
  const lower = domain.toLowerCase();
  if (current.some((entry) => entry.toLowerCase() === lower)) {
    return {
      stdout: `(${domain} already in ${providerId} extras)\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  await settings.setExtraOAuthDomainsAsync(providerId, [...current, domain]);
  return {
    stdout: `Added ${domain} to ${providerId}. Reload the page to apply.\n`,
    stderr: '',
    exitCode: 0,
  };
}

async function removeDomain(
  settings: DomainSettings,
  providerId: string | undefined,
  domain: string | undefined
): Promise<CommandResult> {
  if (!providerId || !domain) {
    return {
      stdout: '',
      stderr: 'oauth-domain remove: requires <providerId> and <domain>\n',
      exitCode: 1,
    };
  }
  const current = settings.getExtraOAuthDomains(providerId);
  const lower = domain.toLowerCase();
  const next = current.filter((entry) => entry.toLowerCase() !== lower);
  if (next.length === current.length) {
    return {
      stdout: `(${domain} not found in ${providerId} extras)\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  await settings.setExtraOAuthDomainsAsync(providerId, next);
  return {
    stdout: `Removed ${domain} from ${providerId}. Reload the page to apply.\n`,
    stderr: '',
    exitCode: 0,
  };
}

async function clearDomains(
  settings: DomainSettings,
  providerId: string | undefined
): Promise<CommandResult> {
  if (!providerId) {
    return {
      stdout: '',
      stderr: 'oauth-domain clear: requires <providerId>\n',
      exitCode: 1,
    };
  }
  await settings.setExtraOAuthDomainsAsync(providerId, []);
  return {
    stdout: `Cleared extra domains for ${providerId}. Reload the page to apply.\n`,
    stderr: '',
    exitCode: 0,
  };
}

async function runSubcommand(
  settings: DomainSettings,
  subcommand: string | undefined,
  providerId: string | undefined,
  domain: string | undefined
): Promise<CommandResult> {
  switch (subcommand) {
    case 'list':
      return listDomains(settings, providerId);
    case 'add':
      return addDomain(settings, providerId, domain);
    case 'remove':
      return removeDomain(settings, providerId, domain);
    case 'clear':
      return clearDomains(settings, providerId);
    default:
      return {
        stdout: '',
        stderr: `oauth-domain: unknown subcommand "${subcommand}"\n${helpText()}`,
        exitCode: 1,
      };
  }
}

export function createOAuthDomainCommand(): Command {
  return defineCommand('oauth-domain', async (args) => {
    if (args.length === 0 || isHelpRequest(args)) {
      return { stdout: helpText(), stderr: '', exitCode: 0 };
    }

    // No value/bool flags today — any dash token is unknown (issue #2255).
    const parsed = parseKnownFlags(args);
    if ('error' in parsed) {
      return fail(parsed.error);
    }

    const [subcommand, providerId, domain] = parsed.positionals;
    const settings = await import('../../providers/account-store.js');

    try {
      return await runSubcommand(settings, subcommand, providerId, domain);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}
