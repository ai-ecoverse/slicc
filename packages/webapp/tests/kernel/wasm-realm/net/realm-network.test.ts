import { describe, expect, it } from 'vitest';
import { ProcessManager } from '../../../../src/kernel/process-manager.js';
import type { RealmCa } from '../../../../src/kernel/wasm-realm/net/realm-ca.js';
import {
  type CaFileSystem,
  enableRealmNetwork,
  ensureRealmCaFile,
  ensureRealmGitConfig,
  isRealmDefault,
  realmCaPath,
  realmGitConfig,
  realmGitConfigPath,
  realmNetworkEnv,
  realmProxy,
} from '../../../../src/kernel/wasm-realm/net/realm-network.js';
import { LoopbackNet } from '../../../../src/kernel/wasm-realm/socket.js';
import { Client, reply, scripted, tick } from './proxy-helpers.js';

const owner = { kind: 'scoop' as const, scoopJid: 'scoop-a' };

describe('enableRealmNetwork', () => {
  it('starts the proxy on the first connection to 127.0.0.1:3128, not before', async () => {
    const net = new LoopbackNet();
    const t = scripted(() => reply(200, [], 'from outside'));
    enableRealmNetwork(net, { transport: () => t.transport });
    expect(realmProxy(net)).toBeUndefined();
    const c = Client.open(net);
    expect(realmProxy(net)?.port).toBe(3128);
    await c.send('GET http://example.com/ HTTP/1.1\r\nConnection: close\r\n\r\n');
    expect((await c.response()).body).toBe('from outside');

    expect(() => net.connect({ family: 'inet', host: '127.0.0.1', port: 3129 })).toThrow(
      'ECONNREFUSED'
    );
    realmProxy(net)?.close();
  });

  it('lets a program that bound 3128 first keep it', () => {
    const net = new LoopbackNet();
    enableRealmNetwork(net, { transport: () => scripted(() => reply(200, [])).transport });
    const own = net.listen({ family: 'inet', host: '127.0.0.1', port: 3128 });
    net.connect({ family: 'inet', host: '127.0.0.1', port: 3128 });
    expect(realmProxy(net)).toBeUndefined();
    own.close();
  });

  it('runs as a net process of its owner; a kill stops it and the next connection restarts it', async () => {
    const net = new LoopbackNet();
    const pm = new ProcessManager();
    const t = scripted(() => reply(200, [], 'ok'));
    enableRealmNetwork(net, {
      transport: () => t.transport,
      process: { processManager: pm, owner },
    });

    enableRealmNetwork(net, { transport: () => scripted(() => reply(500, [])).transport });
    Client.open(net).close();
    const first = pm.list().find((p) => p.kind === 'net');
    expect(first?.argv).toEqual(['http-proxy', '127.0.0.1:3128']);
    expect(first?.owner).toEqual(owner);
    expect(first?.status).toBe('running');

    const proxy = realmProxy(net);
    pm.signal(first?.pid ?? 0, 'SIGTERM');
    await proxy?.closed;
    await tick();
    expect(pm.get(first?.pid ?? 0)?.status).toBe('killed');
    expect(realmProxy(net)).toBeUndefined();

    const c = Client.open(net);
    await c.send('GET http://example.com/ HTTP/1.1\r\n\r\n');
    expect((await c.response()).body).toBe('ok');
    const again = pm.list().filter((p) => p.kind === 'net' && p.status === 'running');
    expect(again).toHaveLength(1);
    expect(again[0].pid).not.toBe(first?.pid);
    realmProxy(net)?.close();
  });
});

describe('realmNetworkEnv', () => {
  it('points every client at the proxy and keeps the realm loopback direct', () => {
    expect(realmNetworkEnv()).toEqual({
      http_proxy: 'http://127.0.0.1:3128',
      https_proxy: 'http://127.0.0.1:3128',
      HTTP_PROXY: 'http://127.0.0.1:3128',
      HTTPS_PROXY: 'http://127.0.0.1:3128',
      no_proxy: 'localhost,.localhost,127.0.0.1,127.0.0.0/8',
      NO_PROXY: 'localhost,.localhost,127.0.0.1,127.0.0.0/8',
    });
  });
});

describe('the realm CA file', () => {
  function memFs(
    files = new Map<string, string>()
  ): CaFileSystem & { files: Map<string, string>; writes: number } {
    const fs = {
      files,
      writes: 0,
      exists: async (p: string) => files.has(p),
      readFile: async (p: string) => files.get(p) ?? '',
      writeFile: async (p: string, c: string) => {
        fs.writes++;
        files.set(p, c);
      },
      mkdir: async () => undefined,
    };
    return fs;
  }
  const fakeCa = (pem: string) => async () => ({ pem }) as unknown as RealmCa;

  it('lives under the owner’s home, named for the owner', () => {
    expect(realmCaPath('/home/user/', 'cone:')).toBe('/home/user/.config/slicc/realm-ca-cone.pem');
    expect(realmCaPath('/scoops/a/home', 'scoop:a@b/c')).toBe(
      '/scoops/a/home/.config/slicc/realm-ca-scoop-a-b-c.pem'
    );
  });

  it('writes the public certificate once and points curl, OpenSSL and git at it', async () => {
    const fs = memFs();
    const path = '/home/user/.config/slicc/realm-ca-cone.pem';
    const env = await ensureRealmCaFile(fs, path, 'cone:', fakeCa('PEM-1'));
    expect(env).toEqual({ SSL_CERT_FILE: path, CURL_CA_BUNDLE: path, GIT_SSL_CAINFO: path });
    expect(fs.files.get(path)).toBe('PEM-1');
    await ensureRealmCaFile(fs, path, 'cone:', fakeCa('PEM-1'));
    expect(fs.writes).toBe(1);

    await ensureRealmCaFile(fs, path, 'cone:', fakeCa('PEM-2'));
    expect(fs.files.get(path)).toBe('PEM-2');
  });

  it('leaves the variables out when the CA or the file cannot be had', async () => {
    const failing = async () => {
      throw new Error('no IndexedDB');
    };
    expect(await ensureRealmCaFile(memFs(), '/x.pem', 'cone:', failing)).toEqual({});
    const readOnly = { ...memFs(), writeFile: async () => Promise.reject(new Error('EACCES')) };
    expect(await ensureRealmCaFile(readOnly, '/x.pem', 'cone:', fakeCa('P'))).toEqual({});
  });
});

describe('the realm’s system gitconfig', () => {
  function memFs(files = new Map<string, string>()) {
    return {
      files,
      exists: async (p: string) => files.has(p),
      readFile: async (p: string) => files.get(p) ?? '',
      writeFile: async (p: string, c: string) => void files.set(p, c),
      mkdir: async () => undefined,
    };
  }

  it('names the slicc credential helper and SLICC’s identity, quoted', () => {
    expect(realmGitConfig()).toBe('[credential]\n\thelper = slicc\n');
    expect(realmGitConfig({ name: 'A "B" \\ C\nD', email: 'a@b.c' })).toBe(
      '[credential]\n\thelper = slicc\n[user]\n\tname = "A \\"B\\" \\\\ C D"\n\temail = "a@b.c"\n'
    );
  });

  it('is written under the home when it changed, and counts as a realm default', async () => {
    const fs = memFs();
    const path = realmGitConfigPath('/home/user/');
    expect(path).toBe('/home/user/.config/slicc/gitconfig');
    expect(await ensureRealmGitConfig(fs, path)).toEqual({ GIT_CONFIG_SYSTEM: path });
    expect(fs.files.get(path)).toBe(realmGitConfig());
    await ensureRealmGitConfig(fs, path, { name: 'N', email: 'e@x' });
    expect(fs.files.get(path)).toContain('name = "N"');
    expect(isRealmDefault('GIT_CONFIG_SYSTEM', path)).toBe(true);
    expect(isRealmDefault('GIT_CONFIG_SYSTEM', '/etc/gitconfig')).toBe(false);
  });

  it('leaves the variable out when the file cannot be written', async () => {
    const readOnly = { ...memFs(), writeFile: async () => Promise.reject(new Error('EACCES')) };
    expect(await ensureRealmGitConfig(readOnly, '/x/gitconfig')).toEqual({});
  });
});

describe('CONNECT without TLS', () => {
  it('is 501 when the network has TLS turned off', async () => {
    const net = new LoopbackNet();
    enableRealmNetwork(net, {
      transport: () => scripted(() => reply(200, [])).transport,
      tls: false,
    });
    const c = Client.open(net);
    await c.send('CONNECT example.com:443 HTTP/1.1\r\n\r\n');
    expect((await c.response()).status).toBe(501);
    realmProxy(net)?.close();
  });
});
