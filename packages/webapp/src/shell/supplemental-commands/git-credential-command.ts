/**
 * `git-credential-slicc` — the git credential helper native git (`wasm-git`)
 * is configured with in the wasm realm (#3571): `credential.helper=slicc`.
 *
 * It answers `get` with a credential SLICC already holds, and only ever in its
 * masked form: the GitHub token SLICC's own `git` uses (the OAuth mask, or a
 * `$GH_TOKEN` / `$GITHUB_TOKEN`), or a `*_TOKEN` / `*_PAT` secret scoped to the
 * host. The fetch path unmasks it at egress like any header, so the real value
 * never enters the realm. A credential is offered only to a host its domains
 * cover, and only over HTTPS.
 */
import { isAllowedDomain } from '@slicc/shared-ts';
import type { Command, ExecResult } from 'just-bash';
import { defineCommand } from 'just-bash';
import { GITHUB_DOMAINS } from '../../git/github-domains.js';
import { resolveFloatTopology } from '../float-topology.js';
import { stdinAsText } from '../just-bash-compat.js';
import { createDefaultSecretBackend, type SecretBackend } from './secret-backends.js';

/** The helper's command name (`credential.helper=slicc`). */
export const GIT_CREDENTIAL_HELPER = 'git-credential-slicc';

/**
 * Commands that are another command's plumbing, by the command whose policy
 * they share: allowed exactly when that command is, and never asking for an
 * approval of their own (the call that runs them went through the gate).
 * Native git runs `git-credential-slicc` for every authenticated request (it
 * only ever prints masks the agent can already see, each only to a host its
 * domains cover), `git-upload-pack` / `git-receive-pack` for a local clone,
 * fetch or push, and `git-remote-http(s)` for an HTTP(S) remote: each serves
 * that git call and nothing else. (`git-shell`, and the `ext::` transport's
 * commands, are no plumbing: they run what they are told to.)
 */
export const PLUMBING: ReadonlyMap<string, string> = new Map([
  [GIT_CREDENTIAL_HELPER, 'git'],
  ['git-upload-pack', 'git'],
  ['git-receive-pack', 'git'],
  ['git-upload-archive', 'git'],
  ['git-remote-http', 'git'],
  ['git-remote-https', 'git'],
]);

/** The username a token authenticates with when the URL names none. */
const TOKEN_USERNAME = 'x-access-token';

/** Secret names that read as a credential for a git host. */
const TOKEN_NAME = /(_TOKEN|_PAT)$/;

export interface GitCredentialDeps {
  /**
   * The GitHub token SLICC's `git` would use with `env`, freshened first
   * (`force`: renewed after the host rejected it).
   */
  githubToken?: (
    env: Readonly<Record<string, string>>,
    opts?: { force?: boolean }
  ) => Promise<string | undefined>;
  /** The domains the GitHub OAuth token is unmasked for. */
  githubDomains?: () => string[];
  /** The secret store (masked values and scopes); the float's by default. */
  backend?: () => SecretBackend;
}

/** One credential request: git's `key=value` lines. */
type Request = Map<string, string>;

function parseRequest(text: string): Request {
  const req: Request = new Map();
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) req.set(line.slice(0, eq), line.slice(eq + 1).replace(/\r$/, ''));
  }
  return req;
}

/** The request's host name: `host` may carry a port. */
function hostName(req: Request): string {
  const host = req.get('host') ?? '';
  try {
    return new URL(`https://${host}`).hostname;
  } catch {
    return '';
  }
}

interface Candidate {
  token: string;
  domains: string[];
}

/** The scope of a GitHub-chain token: the secret's own when it is one. */
async function scopeOf(
  token: string,
  names: string[],
  backend: SecretBackend,
  fallback: string[]
): Promise<string[]> {
  for (const name of names) {
    const rec = await backend.getMasked(name).catch(() => null);
    if (rec && rec.maskedValue === token) return rec.domains;
  }
  return fallback;
}

/** SLICC's GitHub token for `env`, with the domains it may go to. */
async function githubCandidate(
  env: Readonly<Record<string, string>>,
  deps: GitCredentialDeps,
  backend: SecretBackend
): Promise<Candidate | undefined> {
  const token = await deps.githubToken?.(env).catch(() => undefined);
  if (!token) return undefined;
  const oauth = deps.githubDomains?.() ?? GITHUB_DOMAINS;
  const fromEnv = token === env.GH_TOKEN || token === env.GITHUB_TOKEN;
  const domains = fromEnv
    ? await scopeOf(token, ['GH_TOKEN', 'GITHUB_TOKEN'], backend, GITHUB_DOMAINS)
    : oauth;
  return { token, domains };
}

/**
 * A token secret scoped to `host`: one whose domains name it outright before
 * one a wildcard covers, by name within each. A `*` scope is no host's: such
 * a secret would go to whichever host asked.
 */
async function secretCandidate(
  host: string,
  backend: SecretBackend
): Promise<Candidate | undefined> {
  const { entries } = await backend.list().catch(() => ({ entries: [] }));
  const scoped = entries
    .filter((e) => TOKEN_NAME.test(e.name) && !e.domains.includes('*'))
    .filter((e) => isAllowedDomain(e.domains, host))
    .sort(
      (a, b) =>
        Number(!a.domains.includes(host)) - Number(!b.domains.includes(host)) ||
        a.name.localeCompare(b.name)
    );
  for (const entry of scoped) {
    const rec = await backend.getMasked(entry.name).catch(() => null);
    if (rec) return { token: rec.maskedValue, domains: rec.domains };
  }
  return undefined;
}

async function get(
  req: Request,
  env: Readonly<Record<string, string>>,
  deps: GitCredentialDeps
): Promise<ExecResult> {
  const host = hostName(req);
  // Never over cleartext, and never to a host SLICC cannot name.
  if (req.get('protocol') !== 'https' || !host) return { stdout: '', stderr: '', exitCode: 0 };
  const backend = (deps.backend ?? (() => createDefaultSecretBackend(resolveFloatTopology())))();
  const github = await githubCandidate(env, deps, backend);
  const found =
    github && isAllowedDomain(github.domains, host) ? github : await secretCandidate(host, backend);
  if (!found) return { stdout: '', stderr: '', exitCode: 0 };
  const username = req.get('username') || TOKEN_USERNAME;
  return { stdout: `username=${username}\npassword=${found.token}\n`, stderr: '', exitCode: 0 };
}

/**
 * `erase`: the host rejected the credential. When it was SLICC's GitHub token,
 * renew it, so the next `get` hands out a fresh one.
 */
async function erase(
  req: Request,
  env: Readonly<Record<string, string>>,
  deps: GitCredentialDeps
): Promise<ExecResult> {
  const rejected = req.get('password');
  const current = await deps.githubToken?.(env).catch(() => undefined);
  if (rejected && current === rejected) {
    await deps.githubToken?.(env, { force: true }).catch(() => undefined);
  }
  return { stdout: '', stderr: '', exitCode: 0 };
}

const HELP = `usage: git-credential-slicc <get|store|erase>

The git credential helper for native git in the wasm realm, configured by
default (credential.helper=slicc). Reads git's key=value request on stdin.

  get     Answer with SLICC's GitHub token (the OAuth login, else $GH_TOKEN or
          $GITHUB_TOKEN) or a *_TOKEN / *_PAT secret whose domains cover the
          host: always the masked value, unmasked only at egress. Nothing for
          a host outside the credential's domains, or for plain http.
  store   Nothing to do: SLICC keeps its own credentials.
  erase   Renews SLICC's GitHub token when it was the one rejected.
`;

export function createGitCredentialCommand(deps: GitCredentialDeps = {}): Command {
  return defineCommand(GIT_CREDENTIAL_HELPER, async (args, ctx) => {
    const op = args[0];
    if (op === undefined || op === '-h' || op === '--help') {
      return { stdout: HELP, stderr: '', exitCode: op === undefined ? 1 : 0 };
    }
    const env = Object.fromEntries(ctx.env);
    const req = parseRequest(stdinAsText(ctx.stdin));
    if (op === 'get') return get(req, env, deps);
    if (op === 'erase') return erase(req, env, deps);
    // `store` and any operation a later git defines: nothing to do (git ignores it).
    return { stdout: '', stderr: '', exitCode: 0 };
  });
}
