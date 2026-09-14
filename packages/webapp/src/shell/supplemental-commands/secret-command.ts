import { isAllowedDomain } from '@slicc/shared-ts';
import type { Command, CommandContext, ExecResult } from 'just-bash';
import { defineCommand } from 'just-bash';
import { isValidShellEnvName } from '../../base/shell-env-name.js';
import { commandGlobToRegExp } from '../../base/sudoers.js';
import { sudoRefusalMessage } from '../../sudo/approval-timeout.js';
import { createSudoBroker } from '../../sudo/index.js';
import type { SudoBroker, SudoDecision } from '../../sudo/types.js';
import { resolveFloatTopology } from '../float-topology.js';
import { type ByteString, stdinAsText } from '../just-bash-compat.js';
import { createDefaultSecretBackend, type SecretBackend } from './secret-backends.js';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest } from './subcommand-help.js';

const SECRET_VALUE_FLAGS = ['--domain'] as const;

const SECRET_SET_BOOL_FLAGS = ['--persist'] as const;

function helpText(): string {
  return `secret — manage secrets for the fetch proxy and mount backends

No approval (session-only, in-memory, never persisted):
  secret set <name> <value> --domain <pat>     Set a session secret. Free for a
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

The required --domain flag accepts a non-empty comma-separated list of patterns
(exact or wildcard, e.g. *.github.com). Choosing "Always" on a prompt skips future
prompts for the same operation this session.

Examples:
  secret set OPENAI_KEY sk-proj-… --domain "api.openai.com"      # session, no prompt
  secret get OPENAI_KEY
  secret peek OPENAI_KEY
  secret set GITHUB_TOKEN ghp_… --domain "api.github.com" --persist   # prompts
  secret scope GITHUB_TOKEN --domain "api.github.com,*.github.com"    # prompts
`;
}

function domainsFromFlag(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.startsWith('-')) return null;
  const domains = raw
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  return domains.length === 0 ? null : domains;
}

function flagError(message: string): ExecResult {
  return { stdout: '', stderr: `secret: ${message}\n`, exitCode: 1 };
}

type GatedOp = 'persist' | 'scope' | 'value';

const OP_LABEL: Record<GatedOp, string> = {
  persist: 'persist secret',
  scope: 'edit secret scope',
  value: 'change secret value',
};

const moduleGrants = new Set<string>();

function grantMatches(pattern: string, subject: string): boolean {
  if (pattern === subject) return true;
  try {
    return commandGlobToRegExp(pattern).test(subject);
  } catch {
    return false;
  }
}

function grantCovers(grants: Set<string>, subject: string): boolean {
  for (const grant of grants) {
    if (grantMatches(grant, subject)) return true;
  }
  return false;
}

export interface SecretCommandDeps {
  backend?: SecretBackend;
  broker?: SudoBroker;

  grants?: Set<string>;

  isExtension?: boolean;

  setEnv?: (name: string, value: string) => void;

  unsetEnv?: (name: string) => void;
}

type GateOutcome = 'ok' | SudoDecision;

interface SecretCmdEnv {
  backend: SecretBackend;
  inExtension: boolean;
  gate: (op: GatedOp, name: string) => Promise<GateOutcome>;
  injectMaskedEnv: (name: string) => Promise<void>;
  clearMaskedEnv: (name: string) => void;
}

function refused(decision: SudoDecision): ExecResult {
  return { stdout: '', stderr: `${sudoRefusalMessage('secret', decision)}\n`, exitCode: 1 };
}

function buildEnv(deps: SecretCommandDeps): SecretCmdEnv {
  const topology = resolveFloatTopology();
  const inExtension =
    deps.isExtension ?? (topology === 'extension-direct' || topology === 'extension-delegate');
  const backend = deps.backend ?? createDefaultSecretBackend(topology);
  const grants = deps.grants ?? moduleGrants;
  let broker = deps.broker;
  const getBroker = (): SudoBroker => {
    broker ??= createSudoBroker(null);
    return broker;
  };

  const gate = async (op: GatedOp, name: string): Promise<GateOutcome> => {
    const pattern = `secret:${op}:${name}`;
    if (grantCovers(grants, pattern)) return 'ok';
    const decision = await getBroker().requestApproval({
      kind: 'secret',
      detail: `${OP_LABEL[op]}: ${name}`,
      suggestedPattern: pattern,
    });
    if (decision.decision === 'deny') return decision;
    if (decision.decision === 'always') {
      const accepted = decision.pattern?.trim();
      grants.add(accepted && grantMatches(accepted, pattern) ? accepted : pattern);
    }
    return 'ok';
  };

  const injectMaskedEnv = async (name: string): Promise<void> => {
    if (!deps.setEnv) return;
    if (!isValidShellEnvName(name)) return;
    try {
      const masked = await backend.getMasked(name);
      if (masked) deps.setEnv(name, masked.maskedValue);
    } catch {}
  };

  const clearMaskedEnv = (name: string): void => {
    if (!deps.unsetEnv) return;
    if (!isValidShellEnvName(name)) return;
    deps.unsetEnv(name);
  };

  return { backend, inExtension, gate, injectMaskedEnv, clearMaskedEnv };
}

function readStdinValue(stdin: ByteString): string | undefined {
  const raw = stdinAsText(stdin);
  if (raw.length === 0) return undefined;
  if (raw.endsWith('\r\n')) return raw.slice(0, -2);
  if (raw.endsWith('\n')) return raw.slice(0, -1);
  return raw;
}

async function handleSetPersisted(
  name: string,
  value: string,
  domains: string[],
  env: SecretCmdEnv
): Promise<ExecResult> {
  const persistGate = await env.gate('persist', name);
  if (persistGate !== 'ok') return refused(persistGate);
  await env.backend.setPersisted(name, value, domains);
  await env.injectMaskedEnv(name);
  return {
    stdout: `Persisted "${name}" (domains: ${domains.join(', ')})\n`,
    stderr: '',
    exitCode: 0,
  };
}

async function handleSetSession(
  name: string,
  value: string,
  domains: string[],
  env: SecretCmdEnv
): Promise<ExecResult> {
  const info = await env.backend.getInfo(name);
  if (info) {
    const valueGate = await env.gate('value', name);
    if (valueGate !== 'ok') return refused(valueGate);
  }
  await env.backend.setSession(name, value, domains);
  await env.injectMaskedEnv(name);
  return {
    stdout: `Set session secret "${name}" (domains: ${domains.join(', ')}) — in-memory only, not persisted.\n`,
    stderr: '',
    exitCode: 0,
  };
}

async function handleSet(
  args: string[],
  ctx: CommandContext,
  env: SecretCmdEnv
): Promise<ExecResult> {
  const parsed = parseKnownFlags(args.slice(1), {
    value: SECRET_VALUE_FLAGS,
    bool: SECRET_SET_BOOL_FLAGS,
  });
  if ('error' in parsed) return flagError(parsed.error);

  const name = parsed.positionals[0];
  if (!name || name.startsWith('-')) {
    return { stdout: '', stderr: 'secret: set requires a <name>\n', exitCode: 1 };
  }
  const argValue = parsed.positionals[1];
  const stdinValue = readStdinValue(ctx.stdin);

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
        'secret set <name> <value> --domain <patterns> [--persist]\n  ' +
        'or pipe the value on stdin: echo "$TOKEN" | secret set <name> --domain <patterns>\n',
      exitCode: 1,
    };
  }
  const domains = domainsFromFlag(parsed.values.get('--domain'));
  if (!domains) {
    return {
      stdout: '',
      stderr: 'secret: set requires --domain <patterns>\n',
      exitCode: 1,
    };
  }
  return parsed.bools.has('--persist')
    ? handleSetPersisted(name, value, domains, env)
    : handleSetSession(name, value, domains, env);
}

async function handleGet(args: string[], env: SecretCmdEnv): Promise<ExecResult> {
  const parsed = parseKnownFlags(args.slice(1), {});
  if ('error' in parsed) return flagError(parsed.error);
  const name = parsed.positionals[0];
  if (!name) {
    return { stdout: '', stderr: 'secret: get requires a <name>\n', exitCode: 1 };
  }
  const rec = await env.backend.getMasked(name);
  if (!rec) {
    return { stdout: '', stderr: `secret: no secret named "${name}"\n`, exitCode: 1 };
  }
  return {
    stdout: `${rec.name}=${rec.maskedValue}\n  domains: ${rec.domains.join(', ') || '(none)'}\n`,
    stderr: '',
    exitCode: 0,
  };
}

async function handlePeek(args: string[], env: SecretCmdEnv): Promise<ExecResult> {
  const parsed = parseKnownFlags(args.slice(1), {});
  if ('error' in parsed) return flagError(parsed.error);
  const name = parsed.positionals[0];
  if (!name) {
    return { stdout: '', stderr: 'secret: peek requires a <name>\n', exitCode: 1 };
  }
  const rec = await env.backend.peek(name);
  if (!rec) {
    return { stdout: '', stderr: `secret: no secret named "${name}"\n`, exitCode: 1 };
  }
  return {
    stdout: `${rec.name}: ${rec.preview}\n  domains: ${rec.domains.join(', ') || '(none)'}\n`,
    stderr: '',
    exitCode: 0,
  };
}

async function handleScope(args: string[], env: SecretCmdEnv): Promise<ExecResult> {
  const parsed = parseKnownFlags(args.slice(1), { value: SECRET_VALUE_FLAGS });
  if ('error' in parsed) return flagError(parsed.error);
  const name = parsed.positionals[0];
  if (!name || name.startsWith('-')) {
    return { stdout: '', stderr: 'secret: scope requires a <name>\n', exitCode: 1 };
  }
  const domains = domainsFromFlag(parsed.values.get('--domain'));
  if (!domains) {
    return {
      stdout: '',
      stderr: 'secret: scope requires --domain <patterns>\n',
      exitCode: 1,
    };
  }
  const scopeGate = await env.gate('scope', name);
  if (scopeGate !== 'ok') return refused(scopeGate);
  await env.backend.setScope(name, domains);
  return {
    stdout: `Updated scope for "${name}" (domains: ${domains.join(', ')})\n`,
    stderr: '',
    exitCode: 0,
  };
}

async function handleList(args: string[], env: SecretCmdEnv): Promise<ExecResult> {
  const parsed = parseKnownFlags(args.slice(1), {});
  if ('error' in parsed) return flagError(parsed.error);
  const { entries, warnings } = await env.backend.list();

  const stderr = warnings.map((warning) => `secret: ${warning}\n`).join('');
  const exitCode = warnings.length > 0 ? 1 : 0;
  if (entries.length === 0) {
    const stdout = warnings.length > 0 ? '' : 'No secrets stored\n';
    return { stdout, stderr, exitCode };
  }
  const nameWidth = Math.max(4, ...entries.map((e) => e.name.length));
  let output = `${'NAME'.padEnd(nameWidth)}  TYPE     DOMAINS\n`;
  for (const entry of entries) {
    const type = entry.persisted ? 'SAVED' : 'SESSION';
    output += `${entry.name.padEnd(nameWidth)}  ${type.padEnd(7)}  ${entry.domains.join(', ')}\n`;
  }
  return { stdout: output, stderr, exitCode };
}

async function handleDelete(
  args: string[],
  subcommand: string,
  env: SecretCmdEnv
): Promise<ExecResult> {
  const parsed = parseKnownFlags(args.slice(1), {});
  if ('error' in parsed) return flagError(parsed.error);
  const name = parsed.positionals[0];
  if (!name) {
    return {
      stdout: '',
      stderr: `secret: ${subcommand} requires a <name>\n`,
      exitCode: 1,
    };
  }
  const result = await env.backend.delete(name);
  if (!result.removed) {
    return { stdout: '', stderr: `secret: no secret named "${name}"\n`, exitCode: 1 };
  }
  env.clearMaskedEnv(name);
  const scope = result.fromSession === true ? 'session' : 'persisted';
  return { stdout: `Removed ${scope} secret "${name}"\n`, stderr: '', exitCode: 0 };
}

async function handleTest(args: string[], env: SecretCmdEnv): Promise<ExecResult> {
  const parsed = parseKnownFlags(args.slice(1), {});
  if ('error' in parsed) return flagError(parsed.error);
  const name = parsed.positionals[0];
  const url = parsed.positionals[1];
  if (!name || !url) {
    return { stdout: '', stderr: 'secret: test requires <name> <url>\n', exitCode: 1 };
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { stdout: '', stderr: `secret: invalid URL "${url}"\n`, exitCode: 1 };
  }

  const { entries, warnings } = await env.backend.list();
  const entry = entries.find((e) => e.name === name);
  if (!entry) {
    const reason =
      warnings.length > 0
        ? warnings.map((warning) => `secret: ${warning}\n`).join('')
        : `secret: no secret named "${name}"\n`;
    return { stdout: '', stderr: reason, exitCode: 1 };
  }

  if (isAllowedDomain(entry.domains, hostname)) {
    return { stdout: `✓ ${name} is allowed for ${hostname}\n`, stderr: '', exitCode: 0 };
  }
  return {
    stdout: `✗ ${name} is NOT allowed for ${hostname}\n  Allowed domains: ${entry.domains.join(', ')}\n`,
    stderr: '',
    exitCode: 1,
  };
}

async function handleEdit(args: string[], env: SecretCmdEnv): Promise<ExecResult> {
  const parsed = parseKnownFlags(args.slice(1), {});
  if ('error' in parsed) return flagError(parsed.error);
  if (!env.inExtension) {
    return {
      stdout:
        'secret: in CLI mode, edit ~/.slicc/secrets.env directly with your text editor.\n' +
        '          (changes are picked up on the next request — no restart needed)\n',
      stderr: '',
      exitCode: 0,
    };
  }

  try {
    await chrome.runtime.openOptionsPage();
    return {
      stdout: 'Opened Mount Secrets options page in a new tab.\n',
      stderr: '',
      exitCode: 0,
    };
  } catch (_err) {
    const url = chrome.runtime.getURL('secrets.html');
    window.open(url, '_blank');
    return { stdout: `Opened ${url}\n`, stderr: '', exitCode: 0 };
  }
}

async function dispatch(
  args: string[],
  ctx: CommandContext,
  env: SecretCmdEnv
): Promise<ExecResult> {
  const subcommand = args[0];
  switch (subcommand) {
    case 'set':
      return handleSet(args, ctx, env);
    case 'get':
    case 'read':
      return handleGet(args, env);
    case 'peek':
      return handlePeek(args, env);
    case 'scope':
      return handleScope(args, env);
    case 'list':
      return handleList(args, env);
    case 'delete':
    case 'rm':
      return handleDelete(args, subcommand, env);
    case 'test':
      return handleTest(args, env);
    case 'edit':
      return handleEdit(args, env);
    default:
      return {
        stdout: '',
        stderr: `secret: unknown command "${subcommand}"\n`,
        exitCode: 1,
      };
  }
}

export function createSecretCommand(deps: SecretCommandDeps = {}): Command {
  const env = buildEnv(deps);
  return defineCommand('secret', async (args, ctx) => {
    if (args.length === 0 || isHelpRequest(args, { valueFlags: SECRET_VALUE_FLAGS })) {
      return { stdout: helpText(), stderr: '', exitCode: 0 };
    }
    try {
      return await dispatch(args, ctx, env);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { stdout: '', stderr: `secret: ${msg}\n`, exitCode: 1 };
    }
  });
}
