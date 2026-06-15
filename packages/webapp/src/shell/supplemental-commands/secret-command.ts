import { isAllowedDomain } from '@slicc/shared-ts';
import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { isValidShellEnvName } from '../../core/secret-env.js';
import { createSudoBroker } from '../../sudo/index.js';
import type { SudoBroker } from '../../sudo/types.js';
import { stdinAsText } from '../just-bash-compat.js';
import { commandGlobToRegExp } from '../sudo/sudoers.js';
import { createDefaultSecretBackend, type SecretBackend } from './secret-backends.js';

function helpText(): string {
  return `secret — manage secrets for the fetch proxy and mount backends

No approval (session-only, in-memory, never persisted):
  secret set <name> <value> [--domain <pat>]   Set a session secret. Free for a
                                               new name; changing the value of an
                                               existing secret requires approval.
  secret get <name>                            Show the masked value + scope.
  secret read <name>                           Alias of get.
  secret peek <name>                           Show first/last chars of the
                                               unmasked value (middle elided).
  secret list                                  List secrets (SESSION vs SAVED).
  secret test <name> <url>                     Check URL matches secret's domains.

Requires approval (native prompt; deny blocks the change):
  secret set <name> <value> --domain <pat> --persist   Persist to
                                               secrets.env / Keychain /
                                               chrome.storage.local.
  secret scope <name> --domain <pat>           Edit allowed host/domain scope.

Other:
  secret delete <name>                         Remove a secret (session or
  secret rm <name>                             persisted) and its _DOMAINS
                                               entry; reloads the masking
                                               pipeline.
  secret edit                                  Open the Mount Secrets options page
                                               (extension) or print the env path.

The --domain flag accepts a comma-separated list of patterns (exact or wildcard,
e.g. *.github.com). Choosing "Always" on a prompt skips future prompts for the
same operation this session.

Examples:
  secret set OPENAI_KEY sk-proj-… --domain "api.openai.com"      # session, no prompt
  secret get OPENAI_KEY
  secret peek OPENAI_KEY
  secret set GITHUB_TOKEN ghp_… --domain "api.github.com" --persist   # prompts
  secret scope GITHUB_TOKEN --domain "api.github.com,*.github.com"    # prompts
`;
}

function isExtensionContext(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
}

function parseDomainFlag(args: string[]): string[] | null {
  const idx = args.indexOf('--domain');
  if (idx === -1 || !args[idx + 1]) return null;
  return args[idx + 1]
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
}

/** Operations gated behind an intrinsic sudo prompt. */
type GatedOp = 'persist' | 'scope' | 'value';

const OP_LABEL: Record<GatedOp, string> = {
  persist: 'persist secret',
  scope: 'edit secret scope',
  value: 'change secret value',
};

/** Process-lifetime "Always" grants (intrinsic, independent of /etc/sudoers). */
const moduleGrants = new Set<string>();

/**
 * Whether a single grant `pattern` matches `subject` (`secret:<op>:<name>`).
 * Patterns are glob-matched (so `secret:scope:*` matches every scope op); a
 * malformed pattern that fails to compile is treated as non-matching.
 */
function grantMatches(pattern: string, subject: string): boolean {
  if (pattern === subject) return true;
  try {
    return commandGlobToRegExp(pattern).test(subject);
  } catch {
    return false;
  }
}

/**
 * Whether any stored grant covers `subject` (`secret:<op>:<name>`). Glob
 * matching keeps a wildcard-edited "Always" pattern effective instead of
 * silently never matching an exact-string lookup.
 */
function grantCovers(grants: Set<string>, subject: string): boolean {
  for (const grant of grants) {
    if (grantMatches(grant, subject)) return true;
  }
  return false;
}

/** Dependencies — injectable for tests; production defaults wire the live realm. */
export interface SecretCommandDeps {
  backend?: SecretBackend;
  broker?: SudoBroker;
  /** "Always" grant set; shared process-wide by default. */
  grants?: Set<string>;
  /** Override extension detection (tests). */
  isExtension?: boolean;
  /**
   * Optional hook that writes a `name=value` pair into the owning shell's live
   * env. When supplied, `secret set` calls this with the masked value after a
   * successful session/persisted set so the LLM context only sees the masked
   * token (parity with container-loaded secrets injected via
   * `fetchSecretEnvVars`). Names that fail the POSIX-identifier filter are
   * skipped; a null `getMasked` lookup is also skipped silently.
   */
  setEnv?: (name: string, value: string) => void;
}

export function createSecretCommand(deps: SecretCommandDeps = {}): Command {
  const inExtension = deps.isExtension ?? isExtensionContext();
  const backend = deps.backend ?? createDefaultSecretBackend(inExtension);
  const grants = deps.grants ?? moduleGrants;
  let broker = deps.broker;
  const getBroker = (): SudoBroker => {
    broker ??= createSudoBroker();
    return broker;
  };

  // Intrinsic gate: prompt unless an "Always" grant already covers the op.
  // Returns true to proceed, false when denied.
  const gate = async (op: GatedOp, name: string): Promise<boolean> => {
    const pattern = `secret:${op}:${name}`;
    if (grantCovers(grants, pattern)) return true;
    const decision = await getBroker().requestApproval({
      kind: 'secret',
      detail: `${OP_LABEL[op]}: ${name}`,
      suggestedPattern: pattern,
    });
    if (decision.decision === 'deny') return false;
    if (decision.decision === 'always') {
      // Only store an edited pattern when it actually matches this subject;
      // otherwise fall back to the exact pattern so we never persist a silent
      // never-match grant that would re-prompt for this op forever.
      const accepted = decision.pattern?.trim();
      grants.add(accepted && grantMatches(accepted, pattern) ? accepted : pattern);
    }
    return true;
  };

  const denied = () => ({ stdout: '', stderr: 'secret: approval denied\n', exitCode: 1 });

  // Best-effort masked-value injection into the owning shell's live env, called
  // after a successful session/persisted set. The agent's $K then reads the same
  // masked token the fetch proxy will unmask — LLM context parity with
  // container-loaded secrets. Skipped silently on non-POSIX names, missing
  // masked record, or backend error: env injection must never fail a set the
  // user already approved.
  const injectMaskedEnv = async (name: string): Promise<void> => {
    if (!deps.setEnv) return;
    if (!isValidShellEnvName(name)) return;
    try {
      const masked = await backend.getMasked(name);
      if (masked) deps.setEnv(name, masked.maskedValue);
    } catch {
      /* best-effort */
    }
  };

  return defineCommand('secret', async (args, ctx) => {
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
          const argValue = args[2] && !args[2].startsWith('-') ? args[2] : undefined;

          // Pipeline-friendly: `echo $TOKEN | secret set NAME` keeps the literal
          // value out of the agent's tool-call argv (and thus out of the LLM
          // transcript). Trim exactly one trailing newline so `echo` and
          // `printf '%s\n'` both work; preserve any embedded newlines verbatim
          // since some token formats carry them.
          const rawStdin = stdinAsText(ctx.stdin);
          const trimmedStdin = rawStdin.endsWith('\r\n')
            ? rawStdin.slice(0, -2)
            : rawStdin.endsWith('\n')
              ? rawStdin.slice(0, -1)
              : rawStdin;
          const stdinValue = rawStdin.length > 0 ? trimmedStdin : undefined;

          if (argValue !== undefined && stdinValue !== undefined) {
            return {
              stdout: '',
              stderr: 'secret: provide <value> as an argument OR via stdin, not both\n',
              exitCode: 1,
            };
          }

          const value = argValue ?? stdinValue;
          if (value === undefined) {
            return {
              stdout: '',
              stderr:
                'secret: set requires a <value>: ' +
                'secret set <name> <value> [--domain <patterns>] [--persist]\n  ' +
                'or pipe the value on stdin: echo "$TOKEN" | secret set <name> [--domain ...]\n',
              exitCode: 1,
            };
          }
          const domains = parseDomainFlag(args) ?? [];
          const persist = args.includes('--persist');

          if (persist) {
            // Persisted set writes to secrets.env / Keychain / chrome.storage —
            // a sensitive, durable mutation, so it's gated.
            if (domains.length === 0) {
              return {
                stdout: '',
                stderr: 'secret: --domain is required to persist a secret\n',
                exitCode: 1,
              };
            }
            if (!(await gate('persist', name))) return denied();
            await backend.setPersisted(name, value, domains);
            await injectMaskedEnv(name);
            return {
              stdout: `Persisted "${name}" (domains: ${domains.join(', ')})\n`,
              stderr: '',
              exitCode: 0,
            };
          }

          // Session set: free for a new name; changing the value of an existing
          // secret is gated (an agent must not silently overwrite a real one).
          const info = await backend.getInfo(name);
          if (info && !(await gate('value', name))) return denied();
          await backend.setSession(name, value, domains);
          await injectMaskedEnv(name);
          const scope = domains.length > 0 ? ` (domains: ${domains.join(', ')})` : '';
          return {
            stdout: `Set session secret "${name}"${scope} — in-memory only, not persisted.\n`,
            stderr: '',
            exitCode: 0,
          };
        }

        case 'get':
        case 'read': {
          const name = args[1];
          if (!name) {
            return { stdout: '', stderr: 'secret: get requires a <name>\n', exitCode: 1 };
          }
          const rec = await backend.getMasked(name);
          if (!rec) {
            return { stdout: '', stderr: `secret: no secret named "${name}"\n`, exitCode: 1 };
          }
          return {
            stdout: `${rec.name}=${rec.maskedValue}\n  domains: ${rec.domains.join(', ') || '(none)'}\n`,
            stderr: '',
            exitCode: 0,
          };
        }

        case 'peek': {
          const name = args[1];
          if (!name) {
            return { stdout: '', stderr: 'secret: peek requires a <name>\n', exitCode: 1 };
          }
          const rec = await backend.peek(name);
          if (!rec) {
            return { stdout: '', stderr: `secret: no secret named "${name}"\n`, exitCode: 1 };
          }
          return {
            stdout: `${rec.name}: ${rec.preview}\n  domains: ${rec.domains.join(', ') || '(none)'}\n`,
            stderr: '',
            exitCode: 0,
          };
        }

        case 'scope': {
          const name = args[1];
          if (!name || name.startsWith('-')) {
            return { stdout: '', stderr: 'secret: scope requires a <name>\n', exitCode: 1 };
          }
          const domains = parseDomainFlag(args) ?? [];
          if (domains.length === 0) {
            return {
              stdout: '',
              stderr: 'secret: scope requires --domain <patterns>\n',
              exitCode: 1,
            };
          }
          if (!(await gate('scope', name))) return denied();
          await backend.setScope(name, domains);
          return {
            stdout: `Updated scope for "${name}" (domains: ${domains.join(', ')})\n`,
            stderr: '',
            exitCode: 0,
          };
        }

        case 'list': {
          const entries = await backend.list();
          if (entries.length === 0) {
            return { stdout: 'No secrets stored\n', stderr: '', exitCode: 0 };
          }
          const nameWidth = Math.max(4, ...entries.map((e) => e.name.length));
          let output = `${'NAME'.padEnd(nameWidth)}  TYPE     DOMAINS\n`;
          for (const entry of entries) {
            const type = entry.persisted ? 'SAVED' : 'SESSION';
            output += `${entry.name.padEnd(nameWidth)}  ${type.padEnd(7)}  ${entry.domains.join(', ')}\n`;
          }
          return { stdout: output, stderr: '', exitCode: 0 };
        }

        case 'delete':
        case 'rm': {
          const name = args[1];
          if (!name) {
            return {
              stdout: '',
              stderr: `secret: ${subcommand} requires a <name>\n`,
              exitCode: 1,
            };
          }
          const result = await backend.delete(name);
          if (!result.removed) {
            return {
              stdout: '',
              stderr: `secret: no secret named "${name}"\n`,
              exitCode: 1,
            };
          }
          const scope = result.fromSession === true ? 'session' : 'persisted';
          return {
            stdout: `Removed ${scope} secret "${name}"\n`,
            stderr: '',
            exitCode: 0,
          };
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

          const entries = await backend.list();
          const entry = entries.find((e) => e.name === name);
          if (!entry) {
            return { stdout: '', stderr: `secret: no secret named "${name}"\n`, exitCode: 1 };
          }

          // Client-side domain check using the same logic as the fetch proxy
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
          } catch (_err) {
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
