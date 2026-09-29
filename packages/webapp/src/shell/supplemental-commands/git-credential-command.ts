import { isAllowedDomain } from '@slicc/shared-ts';
import type { Command, ExecResult } from 'just-bash';
import { defineCommand } from 'just-bash';
import { resolveFloatTopology } from '../float-topology.js';
import { stdinAsText } from '../just-bash-compat.js';
import { createDefaultSecretBackend, type SecretBackend } from './secret-backends.js';

export const GIT_CREDENTIAL_HELPER = 'git-credential-slicc';

export const PLUMBING: ReadonlyMap<string, string> = new Map([
  [GIT_CREDENTIAL_HELPER, 'git'],
  ['git-upload-pack', 'git'],
  ['git-receive-pack', 'git'],
  ['git-upload-archive', 'git'],
  ['git-remote-http', 'git'],
  ['git-remote-https', 'git'],
]);

export const GITHUB_DOMAINS = ['github.com', '*.github.com'];

const TOKEN_USERNAME = 'x-access-token';

const TOKEN_NAME = /(_TOKEN|_PAT)$/;

export interface GitCredentialDeps {
  githubToken?: (
    env: Readonly<Record<string, string>>,
    opts?: { force?: boolean }
  ) => Promise<string | undefined>;

  githubDomains?: () => string[];

  backend?: () => SecretBackend;
}

type Request = Map<string, string>;

function parseRequest(text: string): Request {
  const req: Request = new Map();
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) req.set(line.slice(0, eq), line.slice(eq + 1).replace(/\r$/, ''));
  }
  return req;
}

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

  if (req.get('protocol') !== 'https' || !host) return { stdout: '', stderr: '', exitCode: 0 };
  const backend = (deps.backend ?? (() => createDefaultSecretBackend(resolveFloatTopology())))();
  const github = await githubCandidate(env, deps, backend);
  const found =
    github && isAllowedDomain(github.domains, host) ? github : await secretCandidate(host, backend);
  if (!found) return { stdout: '', stderr: '', exitCode: 0 };
  const username = req.get('username') || TOKEN_USERNAME;
  return { stdout: `username=${username}\npassword=${found.token}\n`, stderr: '', exitCode: 0 };
}

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

    return { stdout: '', stderr: '', exitCode: 0 };
  });
}
