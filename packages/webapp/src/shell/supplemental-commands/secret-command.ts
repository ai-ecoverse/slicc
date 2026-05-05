import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

function helpText(): string {
  return `secret — manage secrets for the fetch proxy and mount backends

CLI mode (node-server / swift-server):
  secret set <name> --domain <patterns>      Show instructions for editing
                                             ~/.slicc/secrets.env or Keychain
  secret list                                List stored secrets
  secret delete <name>                       Show removal instructions
  secret test <name> <url>                   Check URL matches secret's domains

Extension mode (Chrome MV3, no server):
  secret set <name> <value> --domain <pat>   Write to chrome.storage.local
  secret list                                List from chrome.storage.local
  secret delete <name>                       Remove from chrome.storage.local
  secret test <name> <url>                   Check URL matches secret's domains
  secret edit                                Open the Mount Secrets options page
                                             (form UI, no value typed in shell)

The --domain flag accepts a comma-separated list of domain patterns.
Patterns support exact matches and wildcards (e.g. *.github.com).

Examples:
  secret set GITHUB_TOKEN --domain "api.github.com,*.github.com"   # CLI: prints instructions
  secret set s3.r2.access_key_id <value> --domain "*.r2.cloudflarestorage.com"   # extension: stores
  secret edit                                                     # extension: open form UI
  secret list
  secret delete GITHUB_TOKEN
  secret test GITHUB_TOKEN https://api.github.com/repos
`;
}

interface SecretEntry {
  name: string;
  domains: string[];
}

function isExtensionContext(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
}

const DOMAINS_SUFFIX = '_DOMAINS';

// ---------------- Extension-mode chrome.storage.local backend ----------------

async function listFromStorage(): Promise<SecretEntry[]> {
  const all = (await chrome.storage.local.get(null)) as Record<string, unknown>;
  const entries: SecretEntry[] = [];
  for (const key of Object.keys(all)) {
    if (key.endsWith(DOMAINS_SUFFIX)) continue;
    if (typeof all[key] !== 'string') continue;
    const domainsKey = key + DOMAINS_SUFFIX;
    const raw = all[domainsKey];
    if (typeof raw !== 'string') continue;
    const domains = raw
      .split(',')
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
    if (domains.length === 0) continue;
    entries.push({ name: key, domains });
  }
  // Stable display order.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

async function setInStorage(name: string, value: string, domains: string[]): Promise<void> {
  await chrome.storage.local.set({
    [name]: value,
    [name + DOMAINS_SUFFIX]: domains.join(','),
  });
}

async function deleteFromStorage(name: string): Promise<void> {
  await chrome.storage.local.remove([name, name + DOMAINS_SUFFIX]);
}

async function listViaApi(): Promise<SecretEntry[] | null> {
  const { ok, data } = await apiCall('GET', '');
  if (!ok) return null;
  return data as SecretEntry[];
}

// ---------------- CLI-mode /api/secrets backend ----------------

async function apiCall(
  method: string,
  path: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (isExtensionContext()) {
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

    const inExtension = isExtensionContext();

    try {
      switch (subcommand) {
        case 'set': {
          const name = args[1];
          if (!name || name.startsWith('-')) {
            return { stdout: '', stderr: 'secret: set requires a <name>\n', exitCode: 1 };
          }

          const domains = parseDomainFlag(args);

          if (inExtension) {
            // Extension mode: write to chrome.storage.local. Requires
            // <value> as the second positional arg (anything before --domain).
            const value =
              args[2] && !args[2].startsWith('-') && args[2] !== name ? args[2] : undefined;
            if (!value) {
              return {
                stdout: '',
                stderr:
                  'secret: extension mode requires a <value>: ' +
                  'secret set <name> <value> --domain <patterns>\n',
                exitCode: 1,
              };
            }
            if (!domains || domains.length === 0) {
              return {
                stdout: '',
                stderr: 'secret: --domain is required (comma-separated patterns)\n',
                exitCode: 1,
              };
            }
            try {
              await setInStorage(name, value, domains);
            } catch (err) {
              // chrome.storage.local can throw QuotaExceededError (10 MB limit)
              // or fail if the storage permission was revoked. Surface as
              // actionable stderr instead of crashing the command, since the
              // user otherwise sees "secret stored" + downstream "profile
              // not configured" — a misleading combination.
              return {
                stdout: '',
                stderr: `secret: failed to write to chrome.storage.local: ${err instanceof Error ? err.message : String(err)}\n`,
                exitCode: 1,
              };
            }
            return {
              stdout: `Stored "${name}" in chrome.storage.local (domains: ${domains.join(', ')})\n`,
              stderr: '',
              exitCode: 0,
            };
          }

          // CLI mode: print server-side editing instructions (existing UX).
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
          const entries = inExtension ? await listFromStorage() : await listViaApi();
          if (!entries) {
            return { stdout: '', stderr: `secret: failed to list secrets\n`, exitCode: 1 };
          }
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

          if (inExtension) {
            try {
              await deleteFromStorage(name);
            } catch (err) {
              return {
                stdout: '',
                stderr: `secret: failed to remove from chrome.storage.local: ${err instanceof Error ? err.message : String(err)}\n`,
                exitCode: 1,
              };
            }
            return {
              stdout: `Removed "${name}" from chrome.storage.local\n`,
              stderr: '',
              exitCode: 0,
            };
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

          const entries = inExtension ? await listFromStorage() : await listViaApi();
          if (!entries) {
            return { stdout: '', stderr: 'secret: failed to fetch secrets\n', exitCode: 1 };
          }
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

        case 'edit': {
          if (!inExtension) {
            return {
              stdout:
                'secret: in CLI mode, edit ~/.slicc/secrets.env directly with your text editor.\n' +
                '          (changes are picked up on the next request — no restart needed)\n',
              stderr: '',
              exitCode: 0,
            };
          }
          // Open the extension's options page (`secrets.html`) in a new tab.
          // chrome.runtime.openOptionsPage() is the canonical way; falls back
          // to a tab if the user disabled the options page.
          try {
            await chrome.runtime.openOptionsPage();
            return {
              stdout: 'Opened Mount Secrets options page in a new tab.\n',
              stderr: '',
              exitCode: 0,
            };
          } catch (err) {
            // Fallback: open the URL directly via window.open (no permission needed
            // for extension pages; works from the side panel context).
            const url = chrome.runtime.getURL('secrets.html');
            window.open(url, '_blank');
            return {
              stdout: `Opened ${url}\n`,
              stderr: '',
              exitCode: 0,
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
