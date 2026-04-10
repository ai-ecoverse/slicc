import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

function helpText(): string {
  return `secret — manage secrets for the fetch proxy

Usage:
  secret set <name> --domain <patterns>   Show instructions for adding a secret
  secret list                             List stored secrets (names + domains)
  secret delete <name>                    Show instructions for removing a secret
  secret test <name> <url>                Check if a URL matches a secret's domains
  secret --help                           Show this help message

The --domain flag accepts a comma-separated list of domain patterns.
Patterns support exact matches and wildcards (e.g. *.github.com).

Examples:
  secret set GITHUB_TOKEN --domain "api.github.com,*.github.com"
  secret list
  secret delete GITHUB_TOKEN
  secret test GITHUB_TOKEN https://api.github.com/repos
`;
}

interface SecretEntry {
  name: string;
  domains: string[];
}

async function apiCall(
  method: string,
  path: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  if (isExtension) {
    throw new Error('Secrets CLI is only available in CLI mode');
  }

  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    init.body = JSON.stringify(body);
  }

  const resp = await fetch(`/api/secrets${path}`, init);
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

function parseDomainFlag(args: string[]): string[] | null {
  const idx = args.indexOf('--domain');
  if (idx === -1 || !args[idx + 1]) return null;
  return args[idx + 1]
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
}

export function createSecretCommand(): Command {
  return defineCommand('secret', async (args) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return { stdout: helpText(), stderr: '', exitCode: 0 };
    }

    const subcommand = args[0];

    try {
      switch (subcommand) {
        case 'set': {
          const name = args[1];
          if (!name || name.startsWith('-')) {
            return { stdout: '', stderr: 'secret: set requires a <name>\n', exitCode: 1 };
          }

          const domains = parseDomainFlag(args);
          const domainStr = domains && domains.length > 0 ? domains.join(',') : '<domain1,domain2>';

          let output = `To add the secret "${name}", use one of the following methods:\n\n`;
          output += `  macOS Keychain (swift-server):\n`;
          output += `    security add-generic-password -s ai.sliccy.slicc -a ${name} -w '<value>' -U -C note -j '${domainStr}'\n\n`;
          output += `  Environment file (node-server):\n`;
          output += `    Add to ~/.slicc/secrets.env:\n`;
          output += `      ${name}=<value>\n`;
          output += `      ${name}_DOMAINS=${domainStr}\n\n`;
          output += `Then restart the server to pick up changes.\n`;

          return { stdout: output, stderr: '', exitCode: 0 };
        }

        case 'list': {
          const { ok, data } = await apiCall('GET', '');
          if (!ok) {
            const err = (data as { error?: string }).error ?? 'unknown error';
            return { stdout: '', stderr: `secret: failed to list secrets: ${err}\n`, exitCode: 1 };
          }

          const entries = data as SecretEntry[];
          if (entries.length === 0) {
            return { stdout: 'No secrets stored\n', stderr: '', exitCode: 0 };
          }

          const nameWidth = Math.max(4, ...entries.map((e) => e.name.length));
          let output = `${'NAME'.padEnd(nameWidth)}  DOMAINS\n`;
          for (const entry of entries) {
            output += `${entry.name.padEnd(nameWidth)}  ${entry.domains.join(', ')}\n`;
          }
          return { stdout: output, stderr: '', exitCode: 0 };
        }

        case 'delete': {
          const name = args[1];
          if (!name) {
            return { stdout: '', stderr: 'secret: delete requires a <name>\n', exitCode: 1 };
          }

          let output = `To delete the secret "${name}", use one of the following methods:\n\n`;
          output += `  macOS Keychain (swift-server):\n`;
          output += `    security delete-generic-password -s ai.sliccy.slicc -a ${name}\n\n`;
          output += `  Environment file (node-server):\n`;
          output += `    Remove the ${name}= and ${name}_DOMAINS= lines from ~/.slicc/secrets.env\n\n`;
          output += `Then restart the server to pick up changes.\n`;

          return { stdout: output, stderr: '', exitCode: 0 };
        }

        case 'test': {
          const name = args[1];
          const url = args[2];
          if (!name || !url) {
            return { stdout: '', stderr: 'secret: test requires <name> <url>\n', exitCode: 1 };
          }

          let hostname: string;
          try {
            hostname = new URL(url).hostname;
          } catch {
            return { stdout: '', stderr: `secret: invalid URL "${url}"\n`, exitCode: 1 };
          }

          // Fetch the secret's domains from the list endpoint
          const { ok, data } = await apiCall('GET', '');
          if (!ok) {
            return { stdout: '', stderr: 'secret: failed to fetch secrets\n', exitCode: 1 };
          }

          const entries = data as SecretEntry[];
          const entry = entries.find((e) => e.name === name);
          if (!entry) {
            return { stdout: '', stderr: `secret: no secret named "${name}"\n`, exitCode: 1 };
          }

          // Client-side domain check using the same logic as the fetch proxy
          const { isAllowedDomain } = await import('../../core/secret-masking.js');
          const allowed = isAllowedDomain(entry.domains, hostname);

          if (allowed) {
            return {
              stdout: `✓ ${name} is allowed for ${hostname}\n`,
              stderr: '',
              exitCode: 0,
            };
          } else {
            return {
              stdout: `✗ ${name} is NOT allowed for ${hostname}\n  Allowed domains: ${entry.domains.join(', ')}\n`,
              stderr: '',
              exitCode: 1,
            };
          }
        }

        default:
          return {
            stdout: '',
            stderr: `secret: unknown command "${subcommand}"\n`,
            exitCode: 1,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { stdout: '', stderr: `secret: ${msg}\n`, exitCode: 1 };
    }
  });
}
