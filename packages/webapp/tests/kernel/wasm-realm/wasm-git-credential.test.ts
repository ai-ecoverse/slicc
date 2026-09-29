import 'fake-indexeddb/auto';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Bash, type CommandContext, getCommandNames, type IFileSystem } from 'just-bash';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentActivityTracker } from '../../../../node-server/src/routes/agent-activity.js';
import { registerFetchProxyRoute } from '../../../../node-server/src/routes/fetch-proxy.js';
import { registerRawFetchProxyRoute } from '../../../../node-server/src/routes/fetch-proxy-raw.js';
import { EnvSecretStore } from '../../../../node-server/src/secrets/env-secret-store.js';
import { SecretProxyManager } from '../../../../node-server/src/secrets/proxy-manager.js';
import { readOrCreateSessionId } from '../../../../node-server/src/secrets/session-id-file.js';
import { VirtualFS } from '../../../src/fs/index.js';
import { GitCommands } from '../../../src/git/git-commands.js';
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
import type { TerminalPort } from '../../../src/shell/terminal-port.js';

type ExecOptions = Parameters<NonNullable<CommandContext['exec']>>[1];

import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';
import { mockCommandContext } from '../../shell/helpers/mock-command-context.js';
import { bundleProcessWorker, nodeWorker } from './helpers/node-wasm-process.js';
import { nodeTlsEngine } from './net/tls-helpers.js';

const MODULES = process.env.SLICC_WASM_MODULES;

const REQUIRED = ['wasm-git', 'wasm-bash'];
const OPTIONAL = ['wasm-less', 'wasm-coreutils'];
const HAVE = Boolean(MODULES && REQUIRED.every((n) => existsSync(`${MODULES}/@ai-ecoverse/${n}`)));
const HAVE_COREUTILS = Boolean(MODULES && existsSync(`${MODULES}/@ai-ecoverse/wasm-coreutils`));
const HAVE_LESS = Boolean(MODULES && existsSync(`${MODULES}/@ai-ecoverse/wasm-less`));

const NM = '/usr/local/lib/node_modules/@ai-ecoverse';

const COMMANDS = new Map<string, WasmCommand>();

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

const IDENTITY = { name: 'Octo Cat', email: 'octocat@users.noreply.github.com' };
const HOST = 'github.com';

let dir: string;
let server: Server;
let masked = '';
let worker: { file: string; dispose(): void } | undefined;

let fs: VfsAdapter;
let vfs: VirtualFS;

const remoteSaw: Array<{ url: string; authorization: string | null }> = [];

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
  if (!HAVE) return;
  dir = mkdtempSync(join(tmpdir(), 'slicc-realm-git-'));

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

  const records = new Map<string, CaRecord>();
  const ca = await RealmCa.open('local', {
    get: async (o) => records.get(o),
    put: async (o, r) => void records.set(o, r),
  });

  vfs = await VirtualFS.create({ dbName: `realm-git-${Date.now()}`, wipe: true });
  for (const name of [...REQUIRED, ...OPTIONAL]) {
    if (existsSync(`${MODULES}/@ai-ecoverse/${name}`)) await install(vfs, name);
  }

  const execPath = `${NM}/wasm-git/libexec/git-core`;
  const hostExec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  for (const script of ['git-submodule', 'git-sh-setup', 'git-sh-i18n']) {
    if (await vfs.exists(`${execPath}/${script}`)) continue;
    await vfs.writeFile(`${execPath}/${script}`, readFileSync(join(hostExec, script)));
    await vfs.chmod(`${execPath}/${script}`, 0o755);
  }
  await vfs.writeFile('/home/user/.config/slicc/ca.pem', ca.pem);
  await vfs.mkdir('/home/user/work', { recursive: true });
  fs = new VfsAdapter(vfs);

  fs.setRegisteredCommandsFn(() => [
    ...getCommandNames(),
    ...COMMANDS.keys(),
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

async function install(vfs: VirtualFS, name: string): Promise<void> {
  const src = `${MODULES}/@ai-ecoverse/${name}`;
  const dest = `${NM}/${name}`;
  for (const file of tree(src))
    await vfs.writeFile(`${dest}/${file}`, readFileSync(join(src, file)));
  const manifest = JSON.parse(readFileSync(`${src}/package.json`, 'utf8')) as {
    slicc: {
      env?: Record<string, string>;
      commands: Record<
        string,
        { glue: string; wasm: string; argv0?: string; env?: Record<string, string> }
      >;
    };
  };
  for (const [command, spec] of Object.entries(manifest.slicc.commands)) {
    if (!existsSync(`${src}/${spec.glue}`)) continue;
    const env = Object.fromEntries(
      Object.entries({ ...manifest.slicc.env, ...spec.env }).map(([k, v]) => [
        k,
        existsSync(`${src}/${v}`) ? `${dest}/${v}` : v,
      ])
    );
    COMMANDS.set(command, {
      name: command,
      glue: `${dest}/${spec.glue}`,
      wasm: `${dest}/${spec.wasm}`,
      argv0: spec.argv0 ?? command,
      pkg: `@ai-ecoverse/${name}`,
      env,
    });
  }
}

function tree(root: string, rel = ''): string[] {
  return readdirSync(join(root, rel)).flatMap((name) => {
    const path = join(rel, name);
    return statSync(join(root, path)).isDirectory() ? tree(root, path) : [path];
  });
}

function secretStore(): SecretBackend {
  const rec = { name: 'GITHUB_TOKEN', maskedValue: masked, domains: [HOST] };
  return {
    list: async () => ({ entries: [{ ...rec, persisted: true }], warnings: [] }),
    getMasked: async (name: string) => (name === rec.name ? rec : null),
  } as unknown as SecretBackend;
}

let shell: Bash | undefined;

const shellCalls: string[] = [];

const justBash = (): Bash => {
  shell ??= new Bash({ fs: fs as unknown as IFileSystem, cwd: '/home/user' });
  return shell;
};

function shellContext(helperCalls: string[]) {
  const helper = createGitCredentialCommand({
    githubToken: async (env) => env.GITHUB_TOKEN,
    backend: secretStore,
  });
  const exec = async (command: string, opts: ExecOptions) => {
    if (!command.endsWith('git-credential-slicc')) {
      shellCalls.push(command);
      return justBash().exec(command, opts);
    }
    const stdin = typeof opts.stdin === 'string' ? opts.stdin : '';
    helperCalls.push(`${opts.args?.[0]} ${/host=(.*)/.exec(stdin)?.[1]}`);
    return helper.execute(
      opts.args ?? [],
      mockCommandContext({ stdin, env: new Map(Object.entries(opts.env ?? {})) })
    );
  };
  const commands = COMMANDS;
  return { exec, commands };
}

interface RealmOptions {
  cwd?: string;
  env?: Record<string, string>;
  helperCalls?: string[];
  stdin?: string;

  terminal?: TerminalPort;
}

async function realm(name: string, args: string[], opts: RealmOptions = {}) {
  const { exec, commands } = shellContext(opts.helperCalls ?? []);
  const cmd = commands.get(name) as WasmCommand;
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
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),

    overrides: { exec, fs },
  });
  const argv = ['--argv0', cmd.argv0, '--module', cmd.wasm, cmd.glue, ...args];
  return runWasmCommand(opts.terminal ? ['-t', ...argv] : argv, ctx, {
    commands: async () => commands,
    defaults: cmd.env,
    gitIdentity: async () => IDENTITY,
    ...(opts.terminal ? { terminal: opts.terminal } : {}),
  });
}

const realmGit = (args: string[], opts: RealmOptions = {}) => realm('git', args, opts);

const realmSh = (script: string, opts: RealmOptions = {}) => realm('bash', ['-c', script], opts);

describe.skipIf(!HAVE)('native git credentials through the realm (real git)', () => {
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

    expect(remoteSaw.at(-1)?.authorization).toBe(
      `Basic ${Buffer.from(`x-access-token:${REAL}`).toString('base64')}`
    );
  }, 120_000);

  it('git credential fill hands the agent the mask, never the real token', async () => {
    const r = await realmGit(['credential', 'fill'], {
      cwd: '/home/user',
      stdin: `protocol=https\nhost=${HOST}\n\n`,
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

function hostGit(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=Upstream', '-c', 'user.email=up@x', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (r.status !== 0) throw new Error(`host git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function hostRemote(name: string, files: Record<string, string>): string {
  const work = mkdtempSync(join(dir, `${name}-`));
  hostGit(work, 'init', '-q', '-b', 'main');
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(work, file), content);
    hostGit(work, 'add', file);
    hostGit(work, 'commit', '-q', '-m', `add ${file}`);
  }
  const bare = join(dir, 'remotes', 'o', `${name}.git`);
  hostGit(dir, 'clone', '-q', '--bare', work, bare);
  hostGit(bare, 'config', 'http.receivepack', 'true');
  return bare;
}

function hostPush(bare: string, file: string, content: string): void {
  const work = mkdtempSync(join(dir, 'push-'));
  hostGit(dir, 'clone', '-q', bare, work);
  writeFileSync(join(work, file), content);
  hostGit(work, 'add', file);
  hostGit(work, 'commit', '-q', '-m', `upstream ${file}`);
  hostGit(work, 'push', '-q', 'origin', 'main');
}

describe.skipIf(!HAVE)('native git as the everyday git (real git)', () => {
  it('fetches, and pulls with a merge and with a rebase, over HTTPS', async () => {
    const bare = hostRemote('pull', { 'a.txt': 'a\n' });
    const url = `https://${HOST}/o/pull.git`;
    const cwd = '/home/user/work/pull';
    const setup = await realmSh(`git clone -q ${url} pull`);
    expect(setup.exitCode, setup.stderr).toBe(0);

    hostPush(bare, 'up1.txt', 'up1\n');
    const merge = await realmSh(
      'echo mine > mine1.txt && git add mine1.txt && git commit -qm mine1 && ' +
        'git fetch -q && git log --format=%s -1 origin/main && ' +
        'git pull -q --no-rebase --no-edit && git log --merges --format=%s | wc -l && ls',
      { cwd }
    );
    expect(merge.exitCode, merge.stderr).toBe(0);
    expect(merge.stdout).toMatch(/^upstream up1\.txt\n\s*1\n/);
    expect(merge.stdout).toContain('up1.txt');

    hostPush(bare, 'up2.txt', 'up2\n');
    const rebase = await realmSh(
      'echo mine > mine2.txt && git add mine2.txt && git commit -qm mine2 && ' +
        'git pull -q --rebase && git log --format=%s -3 && git log --merges --oneline | wc -l',
      { cwd }
    );
    expect(rebase.exitCode, rebase.stderr).toBe(0);

    expect(rebase.stdout).toMatch(/^mine2\nmine1\nupstream up2\.txt\n\s*0\n$/);
    expect(`${merge.stderr}${rebase.stderr}`).not.toContain(REAL);
  }, 240_000);

  const REPO = (name: string) =>
    `mkdir -p /home/user/work/${name} && cd /home/user/work/${name} && git init -q -b main && ` +
    'echo one > f && git add f && git commit -qm one';

  it('runs a pre-commit hook through /bin/sh (GNU bash): it passes, and it blocks', async () => {
    const init = await realmSh(REPO('hook'));
    expect(init.exitCode, init.stderr).toBe(0);

    const hook = '/home/user/work/hook/.git/hooks/pre-commit';
    await fs.mkdir('/home/user/work/hook/.git/hooks', { recursive: true });
    await fs.writeFile(
      hook,
      '#!/bin/sh\necho "hook ran as $0 in ${BASH_VERSION%%.*}" > hook.log\n' +
        'case $(cat f) in *BLOCK*) echo "blocked by hook" >&2; exit 1;; esac\n'
    );
    await fs.chmod(hook, 0o755);
    const r = await realmSh(
      'echo two >> f && git commit -qam two && cat hook.log && ' +
        'echo BLOCK >> f && { git commit -qam blocked; echo "blocked=$?"; } && git log --format=%s -1',
      { cwd: '/home/user/work/hook' }
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe('hook ran as .git/hooks/pre-commit in 5\nblocked=1\ntwo\n');

    expect(shellCalls.filter((c) => c.includes('hooks/'))).toEqual([]);
    expect(r.stderr).toContain('blocked by hook');
  }, 120_000);

  it('stashes and pops, and lists the stash', async () => {
    const r = await realmSh(
      `${REPO('stash')} && echo two >> f && echo new > g && git add g && ` +
        'git stash -q && git status --short | wc -l && git stash list && ' +
        'git stash pop -q && git status --short && cat f'
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(
      /^\s*0\nstash@\{0\}: WIP on main: [0-9a-f]+ one\n M f\nA {2}g\none\ntwo\n$/
    );
  }, 120_000);

  it('garbage-collects into a pack that fsck accepts', async () => {
    const r = await realmSh(
      `${REPO('gc')} && for i in 2 3 4 5; do echo $i >> f; git commit -qam c$i; done && ` +
        'git gc -q && git count-objects -v | while read -r k v; do ' +
        '[[ $k == count: || $k == packs: ]] && echo "$k $v"; done; ' +
        'git fsck --no-progress && git log --oneline | wc -l'
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^count: 0\npacks: 1\n\s*5\n$/);
  }, 120_000);

  it('clones a superproject with its submodule, both over HTTPS with the helper', async () => {
    const sub = hostRemote('sub', { 'lib.txt': 'from the submodule\n' });
    const work = mkdtempSync(join(dir, 'super-'));
    hostGit(work, 'init', '-q', '-b', 'main');
    writeFileSync(join(work, 'README'), 'super\n');
    hostGit(work, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub');

    writeFileSync(
      join(work, '.gitmodules'),
      `[submodule "sub"]\n\tpath = sub\n\turl = https://${HOST}/o/sub.git\n`
    );
    hostGit(work, 'add', '.');
    hostGit(work, 'commit', '-q', '-m', 'super with sub');
    hostGit(dir, 'clone', '-q', '--bare', work, join(dir, 'remotes', 'o', 'super.git'));

    const helperCalls: string[] = [];
    const r = await realmSh(
      `git clone -q --recurse-submodules https://${HOST}/o/super.git sup && ` +
        'cat sup/sub/lib.txt && git -C sup submodule status | while read -r oid path rest; do echo "$path"; done',
      { helperCalls }
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe('from the submodule\nsub\n');
    expect(shellCalls.filter((c) => c.includes('git-submodule'))).toEqual([]);
    expect(r.stderr).not.toContain(REAL);

    expect(helperCalls.filter((c) => c === `get ${HOST}`).length).toBeGreaterThanOrEqual(2);
  }, 240_000);

  it.skipIf(!HAVE_LESS)(
    'pages `git log -p` through less on a terminal; q ends it',
    async () => {
      const setup = await realmSh(
        `${REPO('pager')} && for i in $(seq 2 40); do echo "line $i" >> f; git commit -qam "c$i"; done`
      );
      expect(setup.exitCode, setup.stderr).toBe(0);
      let screen = '';
      const keys: Array<(bytes: Uint8Array) => void> = [];
      const terminal: TerminalPort = {
        lease: () => ({
          cols: 80,
          rows: 24,
          write: (bytes) => void (screen += new TextDecoder().decode(bytes)),
          onInput: (listener) => void keys.push(listener),
          onResize: () => {},
          release: () => {},
        }),
      };
      let done = false;
      const run = realmGit(['log', '-p'], { cwd: '/home/user/work/pager', terminal }).finally(
        () => {
          done = true;
        }
      );
      const plain = () => screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      const deadline = Date.now() + 60_000;
      while (!/\+line 40/.test(plain())) {
        if (Date.now() > deadline) throw new Error(`nothing paged: ${plain().slice(-400)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(plain()).toMatch(/diff --git a\/f b\/f/);

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(done).toBe(false);
      for (const key of keys) key(new TextEncoder().encode('q'));
      const r = await run;
      expect(r.exitCode, r.stderr).toBe(0);
    },
    180_000
  );

  it('handles a repository of a few thousand files (timed against the built-in git)', async () => {
    const FILES = 3000;
    const write = async (root: string) => {
      for (let i = 0; i < FILES; i++) {
        await vfs.writeFile(`${root}/d${i % 30}/file${i}.txt`, `content of file ${i}\n`);
      }
    };
    await write('/home/user/work/big-native');
    await write('/home/user/work/big-builtin');
    const timings: Record<string, Record<string, number>> = { native: {}, builtin: {} };
    const time = async <T>(side: 'native' | 'builtin', step: string, run: () => Promise<T>) => {
      const start = performance.now();
      const out = await run();
      timings[side][step] = Math.round(performance.now() - start);
      return out;
    };

    const cwd = '/home/user/work/big-native';
    const native = async (script: string) => {
      const r = await realmSh(script, { cwd });
      expect(r.exitCode, r.stderr).toBe(0);
      return r.stdout;
    };
    await time('native', 'init + add', () => native('git init -q -b main && git add -A'));
    await time('native', 'commit', () => native('git commit -qm big'));
    await time('native', 'status (clean)', () => native('git status --short'));
    await vfs.writeFile(`${cwd}/d7/file7.txt`, 'changed\n');
    const changed = await time('native', 'status (1 change)', () => native('git status --short'));
    expect(changed).toBe(' M d7/file7.txt\n');
    const count = await native('git ls-files | wc -l');
    expect(count.trim()).toBe(String(FILES));

    const builtin = new GitCommands({ fs: vfs, globalDbName: `realm-git-global-${Date.now()}` });
    const bcwd = '/home/user/work/big-builtin';
    const run = async (args: string[]) => {
      const r = await builtin.execute(args, bcwd);
      expect(r.exitCode, r.stderr).toBe(0);
      return r.stdout;
    };
    await time('builtin', 'init + add', async () => {
      await run(['init']);
      await run(['add', '.']);
    });
    await time('builtin', 'commit', () => run(['commit', '-m', 'big']));
    await time('builtin', 'status (clean)', () => run(['status', '--short']));
    await vfs.writeFile(`${bcwd}/d7/file7.txt`, 'changed\n');
    await time('builtin', 'status (1 change)', () => run(['status', '--short']));

    console.log(`git on ${FILES} files (ms):`, JSON.stringify(timings));
  }, 900_000);
});
