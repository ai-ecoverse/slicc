/**
 * Native git's credentials through the realm (#3571 step 4): real `wasm-git`
 * clones from and pushes to a smart-HTTP remote that requires auth, over
 * HTTPS through the realm proxy (TLS terminated with the owner's CA) and the
 * CLI's real fetch-proxy route with its `SecretProxyManager`.
 *
 * Git asks its default helper, `git-credential-slicc` (a slicc shell command,
 * run here by the real command over an in-memory secret store), and gets the
 * masked token; the route unmasks it at egress, so the remote (the host's
 * `git http-backend`, standing in for github.com) sees the real one, and
 * nothing the program prints (`GIT_TRACE_CURL` included) carries it.
 *
 * `wasm-git` and GNU bash (git's `sh`) are not fixtures: point SLICC_WASM_GIT
 * at an unpacked `@ai-ecoverse/wasm-git` package directory and SLICC_WASM_BASH
 * at `@ai-ecoverse/wasm-bash`'s `bin/bash` to run this.
 */
import 'fake-indexeddb/auto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { CommandContext } from 'just-bash';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentActivityTracker } from '../../../../node-server/src/routes/agent-activity.js';
import { registerFetchProxyRoute } from '../../../../node-server/src/routes/fetch-proxy.js';
import { registerRawFetchProxyRoute } from '../../../../node-server/src/routes/fetch-proxy-raw.js';
import { EnvSecretStore } from '../../../../node-server/src/secrets/env-secret-store.js';
import { SecretProxyManager } from '../../../../node-server/src/secrets/proxy-manager.js';
import { readOrCreateSessionId } from '../../../../node-server/src/secrets/session-id-file.js';
import { VirtualFS } from '../../../src/fs/index.js';
import { type CaRecord, RealmCa } from '../../../src/kernel/wasm-realm/net/realm-ca.js';
import {
  enableRealmNetwork,
  realmCaEnv,
  realmProxy,
} from '../../../src/kernel/wasm-realm/net/realm-network.js';
import { loopbackNet } from '../../../src/kernel/wasm-realm/socket.js';
import type { WasmCommand } from '../../../src/shell/ipk/wasm-programs.js';
import { setLocalApiBaseUrl } from '../../../src/shell/proxied-fetch.js';
import { createGitCredentialCommand } from '../../../src/shell/supplemental-commands/git-credential-command.js';
import type { SecretBackend } from '../../../src/shell/supplemental-commands/secret-backends.js';
import { runWasmCommand } from '../../../src/shell/supplemental-commands/wasm/run.js';

type ExecOptions = Parameters<NonNullable<CommandContext['exec']>>[1];

import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';
import { mockCommandContext } from '../../shell/helpers/mock-command-context.js';
import { bundleProcessWorker, nodeWorker } from './helpers/node-wasm-process.js';
import { nodeTlsEngine } from './net/tls-helpers.js';

const GIT_PKG = process.env.SLICC_WASM_GIT;
const BASH = process.env.SLICC_WASM_BASH;
/** Where the packages sit on the shell's filesystem. */
const PKG = '/usr/local/lib/wasm-git';
const BASH_GLUE = '/usr/local/lib/wasm-bash/bash';

// The realm's processes run in `worker_threads` workers (the browser's
// DedicatedWorker otherwise).
const workerFile = vi.hoisted(() => ({ path: '' }));
vi.mock('../../../src/kernel/wasm-realm/host.js', async (importOriginal) => {
  const host = await importOriginal<typeof import('../../../src/kernel/wasm-realm/host.js')>();
  return {
    ...host,
    spawnWasmProcess: (opts: Parameters<typeof host.spawnWasmProcess>[0]) =>
      host.spawnWasmProcess({ createWorker: () => nodeWorker(workerFile.path), ...opts }),
  };
});

const REAL = 'ghp_realGitTokenValue0123456789abcdefXYZ';
/** The identity SLICC's own `git` commits with (the GitHub login's, say). */
const IDENTITY = { name: 'Octo Cat', email: 'octocat@users.noreply.github.com' };
const HOST = 'github.com';

let dir: string;
let server: Server;
let masked = '';
let worker: { file: string; dispose(): void } | undefined;
/** The shell's filesystem (the production adapter over a VirtualFS), packages installed. */
let fs: VfsAdapter;
/** What the remote saw: each request's path and the credential it carried. */
const remoteSaw: Array<{ url: string; authorization: string | null }> = [];

/** The host's `git http-backend` as a CGI, requiring Basic `x-access-token:<REAL>`. */
async function smartHttp(url: URL, init: RequestInit | undefined): Promise<Response> {
  const headers = new Headers(init?.headers);
  const authorization = headers.get('authorization');
  remoteSaw.push({ url: url.href, authorization });
  const expected = `Basic ${Buffer.from(`x-access-token:${REAL}`).toString('base64')}`;
  if (authorization !== expected) {
    return new Response('auth required\n', {
      status: 401,
      headers: { 'www-authenticate': 'Basic realm="test"' },
    });
  }
  const body = init?.body ? Buffer.from(await new Response(init.body).arrayBuffer()) : undefined;
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  const cgi = spawn(join(execPath, 'git-http-backend'), [], {
    env: {
      GIT_PROJECT_ROOT: join(dir, 'remotes'),
      GIT_HTTP_EXPORT_ALL: '1',
      REMOTE_USER: 'x-access-token',
      REQUEST_METHOD: init?.method ?? 'GET',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: headers.get('content-type') ?? '',
      HTTP_CONTENT_ENCODING: headers.get('content-encoding') ?? '',
      HTTP_GIT_PROTOCOL: headers.get('git-protocol') ?? '',
      ...(body ? { CONTENT_LENGTH: String(body.length) } : {}),
    },
  });
  cgi.stdin.end(body);
  const chunks: Buffer[] = [];
  for await (const chunk of cgi.stdout) chunks.push(chunk as Buffer);
  const out = Buffer.concat(chunks);
  const split = out.indexOf('\r\n\r\n');
  const head = out.subarray(0, split).toString('latin1');
  const res = new Headers();
  let status = 200;
  for (const line of head.split('\r\n')) {
    const colon = line.indexOf(':');
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
    else res.append(name, value);
  }
  return new Response(out.subarray(split + 4), { status, headers: res });
}

beforeAll(async () => {
  if (!GIT_PKG || !BASH) return;
  dir = mkdtempSync(join(tmpdir(), 'slicc-realm-git-'));
  // The remote: a bare repository with one commit, pushable.
  const seed = join(dir, 'seed');
  const bare = join(dir, 'remotes', 'o', 'r.git');
  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, HOME: dir } });
  git(dir, 'init', '-q', '-b', 'main', seed);
  writeFileSync(join(seed, 'README'), 'hello\n');
  git(seed, 'add', 'README');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed');
  git(dir, 'clone', '-q', '--bare', seed, bare);
  git(bare, 'config', 'http.receivepack', 'true');

  writeFileSync(join(dir, 'secrets.env'), `GITHUB_TOKEN=${REAL}\nGITHUB_TOKEN_DOMAINS=${HOST}\n`);
  const secretProxy = new SecretProxyManager(
    new EnvSecretStore(join(dir, 'secrets.env')),
    readOrCreateSessionId(dir)
  );
  await secretProxy.reload();
  masked = secretProxy.getMaskedEntries().find((e) => e.name === 'GITHUB_TOKEN')?.maskedValue ?? '';
  expect(masked).not.toBe('');

  const app = express();
  const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };
  const activityTracker = new AgentActivityTracker();
  registerRawFetchProxyRoute(app, { secretProxy, activityTracker, logger: silent });
  registerFetchProxyRoute(app, { secretProxy, activityTracker, logger: silent });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const bridge = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setLocalApiBaseUrl(bridge);
  // What the route sends out: https://github.com/… reaches the local remote.
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(bridge)) return realFetch(input, init);
    const target = new URL(url);
    if (target.hostname !== HOST) {
      remoteSaw.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      return new Response('auth required\n', {
        status: 401,
        headers: { 'www-authenticate': 'Basic realm="evil"' },
      });
    }
    return smartHttp(target, init);
  });

  // The owner's CA (in memory here), terminating the CONNECT tunnels.
  const records = new Map<string, CaRecord>();
  const ca = await RealmCa.open('local', {
    get: async (o) => records.get(o),
    put: async (o, r) => void records.set(o, r),
  });

  const vfs = await VirtualFS.create({ dbName: `realm-git-${Date.now()}`, wipe: true });
  for (const file of tree(GIT_PKG)) {
    await vfs.writeFile(`${PKG}/${file}`, readFileSync(join(GIT_PKG, file)));
  }
  await vfs.writeFile(BASH_GLUE, readFileSync(BASH));
  await vfs.writeFile(`${BASH_GLUE}.wasm`, readFileSync(`${BASH}.wasm`));
  await vfs.writeFile('/home/user/.config/slicc/ca.pem', ca.pem);
  await vfs.mkdir('/home/user/work', { recursive: true });
  fs = new VfsAdapter(vfs);
  // The command registry's `/usr/bin` names, as the shell synthesizes them.
  fs.setRegisteredCommandsFn(() => [
    'git',
    'git-remote-https',
    'bash',
    'sh',
    'git-credential-slicc',
  ]);
  enableRealmNetwork(loopbackNet('local'), {
    tls: { ca: async () => ca, engine: () => nodeTlsEngine() },
  });

  worker = await bundleProcessWorker();
  workerFile.path = worker.file;
}, 60_000);

afterAll(async () => {
  realmProxy(loopbackNet('local'))?.close();
  vi.restoreAllMocks();
  setLocalApiBaseUrl(null);
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  worker?.dispose();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Every file under `root` on disk, by path relative to it. */
function tree(root: string, rel = ''): string[] {
  return readdirSync(join(root, rel)).flatMap((name) => {
    const path = join(rel, name);
    return statSync(join(root, path)).isDirectory() ? tree(root, path) : [path];
  });
}

/** The store `git-credential-slicc` reads: the masked GITHUB_TOKEN, scoped to github.com. */
function secretStore(): SecretBackend {
  const rec = { name: 'GITHUB_TOKEN', maskedValue: masked, domains: [HOST] };
  return {
    list: async () => ({ entries: [{ ...rec, persisted: true }], warnings: [] }),
    getMasked: async (name: string) => (name === rec.name ? rec : null),
  } as unknown as SecretBackend;
}

/** The shell's commands: what a program runs that is no wasm program is the helper alone. */
function shellContext(helperCalls: string[]) {
  const helper = createGitCredentialCommand({
    githubToken: async (env) => env.GITHUB_TOKEN,
    backend: secretStore,
  });
  const exec = async (command: string, opts: ExecOptions) => {
    if (!command.endsWith('git-credential-slicc')) {
      return { stdout: '', stderr: `${command}: not found\n`, exitCode: 127 };
    }
    const stdin = typeof opts.stdin === 'string' ? opts.stdin : '';
    helperCalls.push(`${opts.args?.[0]} ${/host=(.*)/.exec(stdin)?.[1]}`);
    return helper.execute(
      opts.args ?? [],
      mockCommandContext({ stdin, env: new Map(Object.entries(opts.env ?? {})) })
    );
  };
  const commands = new Map<string, WasmCommand>(
    [
      ['git', `${PKG}/bin/git`, { GIT_EXEC_PATH: `${PKG}/libexec/git-core` }],
      ['git-remote-https', `${PKG}/bin/git-remote-https`, undefined],
      ['bash', BASH_GLUE, undefined],
    ].map(([name, glue, env]) => [
      name as string,
      {
        name: name as string,
        glue: glue as string,
        wasm: `${glue}.wasm`,
        argv0: name as string,
        pkg: name as string,
        ...(env ? { env: env as Record<string, string> } : {}),
      },
    ])
  );
  return { exec, commands };
}

/** Run `git args…` in the realm with the shell's `env` (GITHUB_TOKEN holds the mask). */
async function realmGit(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; helperCalls?: string[] } = {}
) {
  const { exec, commands } = shellContext(opts.helperCalls ?? []);
  const env = {
    HOME: '/home/user',
    PATH: '/usr/bin',
    GITHUB_TOKEN: masked,
    ...realmCaEnv('/home/user/.config/slicc/ca.pem'),
    ...opts.env,
  };
  const ctx = mockCommandContext({
    cwd: opts.cwd ?? '/home/user/work',
    env: new Map(Object.entries(env)),
    exportedEnv: env,
    // (Not `fs:`, which spreads the instance and loses its methods.)
    overrides: { exec, fs },
  });
  return runWasmCommand([`${PKG}/bin/git`, ...args], ctx, {
    commands: async () => commands,
    defaults: { GIT_EXEC_PATH: `${PKG}/libexec/git-core` },
    gitIdentity: async () => IDENTITY,
  });
}

describe.skipIf(!GIT_PKG || !BASH)('native git credentials through the realm (real git)', () => {
  it('ls-remote asks git-credential-slicc and authenticates with the token unmasked only at egress', async () => {
    const helperCalls: string[] = [];
    remoteSaw.length = 0;
    const r = await realmGit(['ls-remote', `https://${HOST}/o/r.git`], {
      cwd: '/home/user',
      helperCalls,
    });
    expect(r.stderr).not.toContain(REAL);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^[0-9a-f]{40}\tHEAD$/m);
    expect(helperCalls[0]).toBe(`get ${HOST}`);
    // The first request went without credentials (401); the retry carried the real token.
    expect(remoteSaw.at(-1)?.authorization).toBe(
      `Basic ${Buffer.from(`x-access-token:${REAL}`).toString('base64')}`
    );
  }, 120_000);

  it('git credential fill hands the agent the mask, never the real token', async () => {
    const { exec, commands } = shellContext([]);
    const env = { HOME: '/home/user', PATH: '/usr/bin', GITHUB_TOKEN: masked };
    const ctx = mockCommandContext({
      cwd: '/home/user',
      env: new Map(Object.entries(env)),
      exportedEnv: env,
      stdin: `protocol=https\nhost=${HOST}\n\n`,
      overrides: { exec, fs },
    });
    const r = await runWasmCommand([`${PKG}/bin/git`, 'credential', 'fill'], ctx, {
      commands: async () => commands,
      defaults: { GIT_EXEC_PATH: `${PKG}/libexec/git-core` },
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain(`password=${masked}`);
    expect(r.stdout).not.toContain(REAL);
  }, 120_000);

  it('GIT_TRACE_CURL output and errors stay masked', async () => {
    const r = await realmGit(['ls-remote', `https://${HOST}/o/missing.git`], {
      cwd: '/home/user',
      env: { GIT_TRACE_CURL: '1', GIT_TRACE_REDACT: '0' },
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('Authorization: Basic');
    expect(`${r.stdout}${r.stderr}`).not.toContain(REAL);
    expect(`${r.stdout}${r.stderr}`).not.toContain(
      Buffer.from(`x-access-token:${REAL}`).toString('base64')
    );
  }, 120_000);

  it('never offers the github.com credential to another host', async () => {
    const helperCalls: string[] = [];
    remoteSaw.length = 0;
    const r = await realmGit(['ls-remote', 'https://evil.example/o/r.git'], {
      cwd: '/home/user',
      helperCalls,
      env: { GIT_TERMINAL_PROMPT: '0' },
    });
    expect(r.exitCode).not.toBe(0);
    expect(helperCalls).toContain('get evil.example');
    expect(remoteSaw.every((s) => s.authorization === null)).toBe(true);
  }, 120_000);

  it('clones, commits with SLICC’s identity and pushes over HTTPS: the remote gets the commit', async () => {
    const url = `https://${HOST}/o/r.git`;
    const clone = await realmGit(['clone', '-q', url, 'r']);
    expect(clone.stderr).not.toContain(REAL);
    expect(clone.exitCode, clone.stderr).toBe(0);
    await fs.writeFile('/home/user/work/r/pushed.txt', 'from the realm\n');
    const cwd = '/home/user/work/r';
    const add = await realmGit(['add', 'pushed.txt'], { cwd });
    expect(add.exitCode, add.stderr).toBe(0);
    // No user.name / user.email anywhere but the realm's system config.
    const commit = await realmGit(['commit', '-q', '-m', 'from the realm'], { cwd });
    expect(commit.exitCode, commit.stderr).toBe(0);
    const push = await realmGit(['push', '-q', 'origin', 'main'], { cwd });
    expect(push.stderr).not.toContain(REAL);
    expect(push.exitCode, push.stderr).toBe(0);
    const log = spawnSync('git', ['log', '--format=%s|%an <%ae>|%cn <%ce>', '-1', 'main'], {
      cwd: join(dir, 'remotes', 'o', 'r.git'),
      encoding: 'utf8',
    });
    const who = `${IDENTITY.name} <${IDENTITY.email}>`;
    expect(log.stdout.trim()).toBe(`from the realm|${who}|${who}`);
  }, 240_000);

  it('lets the user’s ~/.gitconfig identity win over SLICC’s', async () => {
    const cwd = '/home/user/own';
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(
      '/home/user/.gitconfig',
      '[user]\n\tname = Mine\n\temail = mine@example.com\n'
    );
    try {
      expect((await realmGit(['init', '-q'], { cwd })).exitCode).toBe(0);
      const commit = await realmGit(['commit', '-q', '--allow-empty', '-m', 'mine'], { cwd });
      expect(commit.exitCode, commit.stderr).toBe(0);
      const log = await realmGit(['log', '-1', '--format=%an <%ae>'], { cwd });
      expect(log.stdout.trim()).toBe('Mine <mine@example.com>');
    } finally {
      await fs.rm('/home/user/.gitconfig');
    }
  }, 120_000);
});
