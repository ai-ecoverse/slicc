import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

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

export function createOAuthDomainCommand(): Command {
  return defineCommand('oauth-domain', async (args) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return { stdout: helpText(), stderr: '', exitCode: 0 };
    }

    const { getExtraOAuthDomains, setExtraOAuthDomains, getAllExtraOAuthDomains } =
      await import('../../ui/provider-settings.js');

    const [subcommand, providerId, domain] = args;

    try {
      switch (subcommand) {
        case 'list': {
          if (providerId) {
            const list = getExtraOAuthDomains(providerId);
            if (list.length === 0) {
              return {
                stdout: `(no extra domains configured for ${providerId})\n`,
                stderr: '',
                exitCode: 0,
              };
            }
            return { stdout: list.join('\n') + '\n', stderr: '', exitCode: 0 };
          }
          const all = getAllExtraOAuthDomains();
          const entries = Object.entries(all).filter(([, v]) => v.length > 0);
          if (entries.length === 0) {
            return { stdout: '(no extra OAuth domains configured)\n', stderr: '', exitCode: 0 };
          }
          const lines = entries.map(([k, v]) => `${k}: ${v.join(', ')}`);
          return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
        }

        case 'add': {
          if (!providerId || !domain) {
            return {
              stdout: '',
              stderr: 'oauth-domain add: requires <providerId> and <domain>\n',
              exitCode: 1,
            };
          }
          const current = getExtraOAuthDomains(providerId);
          const lower = domain.toLowerCase();
          if (current.some((d) => d.toLowerCase() === lower)) {
            return {
              stdout: `(${domain} already in ${providerId} extras)\n`,
              stderr: '',
              exitCode: 0,
            };
          }
          setExtraOAuthDomains(providerId, [...current, domain]);
          return {
            stdout: `Added ${domain} to ${providerId}. Reload the page to apply.\n`,
            stderr: '',
            exitCode: 0,
          };
        }

        case 'remove': {
          if (!providerId || !domain) {
            return {
              stdout: '',
              stderr: 'oauth-domain remove: requires <providerId> and <domain>\n',
              exitCode: 1,
            };
          }
          const current = getExtraOAuthDomains(providerId);
          const lower = domain.toLowerCase();
          const next = current.filter((d) => d.toLowerCase() !== lower);
          if (next.length === current.length) {
            return {
              stdout: `(${domain} not found in ${providerId} extras)\n`,
              stderr: '',
              exitCode: 0,
            };
          }
          setExtraOAuthDomains(providerId, next);
          return {
            stdout: `Removed ${domain} from ${providerId}. Reload the page to apply.\n`,
            stderr: '',
            exitCode: 0,
          };
        }

        case 'clear': {
          if (!providerId) {
            return {
              stdout: '',
              stderr: 'oauth-domain clear: requires <providerId>\n',
              exitCode: 1,
            };
          }
          setExtraOAuthDomains(providerId, []);
          return {
            stdout: `Cleared extra domains for ${providerId}. Reload the page to apply.\n`,
            stderr: '',
            exitCode: 0,
          };
        }

        default:
          return {
            stdout: '',
            stderr: `oauth-domain: unknown subcommand "${subcommand}"\n${helpText()}`,
            exitCode: 1,
          };
      }
    } catch (err) {
      return {
        stdout: '',
        stderr: `oauth-domain: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }
  });
}
