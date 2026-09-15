import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_NODE_SERVER, setup } from '../tests/helpers.mjs';
import { isAlive, readState, terminate } from './gh-io.mjs';
import {
  bootLeader,
  installNodeServer,
  main,
  pollJoinFile,
  readBootInputs,
  removeCredentialFiles,
  resolveNodeServer,
  writeCredentialFiles,
} from './start-leader.mjs';

describe('start-leader', () => {
  let t;
  beforeEach(() => {
    t = setup();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    const state = readState(t.home);
    if (state?.leader) await terminate(state.leader, 500);
    t.teardown();
    vi.restoreAllMocks();
  });

  it('boots the fake node-server, waits for the join file, records state and outputs', async () => {
    t.inputs({
      'node-server': FAKE_NODE_SERVER,
      duration: '5m',
      port: '5799',
      'boot-timeout': '10s',
      'mask-join-url': 'false',
      mounts: `${t.root}:/mnt/root`,
      model: 'anthropic:claude-opus-4-6',
      provider: 'anthropic',
      'provider-api-key': 'sk-test',
      'secrets-env': 'TOKEN=abc\nTOKEN_DOMAINS=api.example',
      'cone-config': '',
    });
    const result = await main({ pollMs: 50 });
    expect(result.joinUrl).toBe('https://www.sliccy.ai/join/fake.tray');
    expect(result.trayId).toBe('fake-tray');
    const state = readState(t.home);
    expect(state.leader).toBe(result.pid);
    expect(isAlive(state.leader)).toBe(true);
    expect(state.port).toBe(5799);
    expect(state.deadline - state.startedAt).toBe(5 * 60_000);
    expect(state.coneConfigPath).toBe(t.coneConfig);
    expect(JSON.parse(readFileSync(t.coneConfig, 'utf8'))).toEqual({
      model: 'anthropic:claude-opus-4-6',
      accounts: [{ providerId: 'anthropic', kind: 'apikey', apiKey: 'sk-test' }],
    });
    expect(readFileSync(state.secretsFile, 'utf8')).toBe('TOKEN=abc\nTOKEN_DOMAINS=api.example\n');
    const out = t.outputs();
    expect(out['join-url']).toBe('https://www.sliccy.ai/join/fake.tray');
    expect(out['tray-id']).toBe('fake-tray');
    expect(out['slicc-version']).toBe('0.0.0-fake');
    expect(out.port).toBe('5799');
    expect(out['state-path']).toBe(join(t.home, 'state.json'));
    // The child saw the hosted argv + mount, the env knobs, and no INPUT_* leak.
    const log = readFileSync(state.logPath, 'utf8');
    expect(log).toContain('"--hosted"');
    expect(log).toContain(`"--mount=${t.root}:/mnt/root"`);
    expect(log).toContain('PORT=5799');
    expect(log).toContain(`SECRETS=${state.secretsFile}`);
    expect(log).toContain('INPUTS=0');
  });

  it('masks the join url by default', async () => {
    t.inputs({ 'node-server': FAKE_NODE_SERVER, duration: '1m', 'boot-timeout': '10s' });
    await main({ pollMs: 50 });
    expect(console.log).toHaveBeenCalledWith('::add-mask::https://www.sliccy.ai/join/fake.tray');
  });

  it('fails fast when node-server exits before the join file, and removes credentials', async () => {
    process.env.FAKE_NODE_SERVER = 'exit';
    t.inputs({
      'node-server': FAKE_NODE_SERVER,
      duration: '1m',
      'boot-timeout': '10s',
      model: 'm',
      'secrets-env': 'A=1\nA_DOMAINS=x',
    });
    await expect(main({ pollMs: 50 })).rejects.toThrow(/exited before minting a join URL/);
    expect(existsSync(t.coneConfig)).toBe(false);
    expect(existsSync(join(t.home, 'secrets.env'))).toBe(false);
    expect(readState(t.home)).toBeNull();
  });

  it('times out when the join file never appears and kills the child', async () => {
    process.env.FAKE_NODE_SERVER = 'never';
    t.inputs({ 'node-server': FAKE_NODE_SERVER, duration: '1m', 'boot-timeout': '600ms' });
    await expect(main({ pollMs: 50 })).rejects.toThrow(/did not report a join URL within 1s/);
  });

  it('ignores a stale join file from an earlier leader', async () => {
    process.env.FAKE_NODE_SERVER = 'stale';
    t.inputs({ 'node-server': FAKE_NODE_SERVER, duration: '1m', 'boot-timeout': '600ms' });
    await expect(main({ pollMs: 50 })).rejects.toThrow(/did not report a join URL/);
  });

  it('rejects a missing node-server entry and bad inputs before spawning', async () => {
    t.inputs({ 'node-server': join(t.root, 'nope.js'), duration: '1m' });
    await expect(main()).rejects.toThrow(/node-server entry not found/);
    t.inputs({ 'node-server': FAKE_NODE_SERVER, duration: '9h' });
    await expect(main()).rejects.toThrow(/ceiling/);
    t.inputs({ duration: '1m', mounts: 'bogus' });
    expect(() => readBootInputs()).toThrow(/mounts line 1/);
  });

  it('installs sliccy through npm into a private prefix', () => {
    const exec = vi.fn((cmd, args) => {
      expect(cmd).toBe('npm');
      expect(args).toEqual([
        'install',
        '--prefix',
        join(t.home, 'leader'),
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        '--omit=dev',
        'sliccy@6.1.0',
      ]);
      const entry = join(t.home, 'leader', 'node_modules', 'sliccy', 'dist', 'node-server');
      mkdirSync(entry, { recursive: true });
      writeFileSync(join(entry, 'index.js'), '');
    });
    expect(installNodeServer(t.home, '6.1.0', exec)).toBe(
      join(t.home, 'leader', 'node_modules', 'sliccy', 'dist', 'node-server', 'index.js')
    );
    expect(() => installNodeServer(join(t.root, 'other'), 'latest', vi.fn())).toThrow(/is missing/);
    t.inputs({ 'node-server': '', 'slicc-version': '6.1.0' });
    expect(resolveNodeServer(t.home, exec)).toMatch(/index\.js$/);
  });

  it('writeCredentialFiles removes a stale cone-config when nothing is configured', () => {
    mkdirSync(join(t.root, 'slicc'), { recursive: true });
    writeFileSync(t.coneConfig, '{"stale":true}');
    t.inputs({ 'cone-config': '', 'secrets-env': '' });
    const r = writeCredentialFiles(t.home);
    expect(r.coneConfigWritten).toBe(false);
    expect(existsSync(t.coneConfig)).toBe(false);
    expect(readFileSync(r.secretsFile, 'utf8')).toBe('');
    removeCredentialFiles(r.secretsFile);
    expect(existsSync(r.secretsFile)).toBe(false);
  });

  it('explains an unwritable cone-config directory', () => {
    process.env.SLICC_GW_CONE_CONFIG_PATH = join(t.root, 'blocked', 'cone-config.json');
    writeFileSync(join(t.root, 'blocked'), 'a file, not a dir');
    t.inputs({ model: 'm' });
    expect(() => writeCredentialFiles(t.home)).toThrow(/cannot write .*sudo mkdir/);
  });

  it('pollJoinFile resolves once a fresh file appears', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)']);
    const logPath = join(t.root, 'l.log');
    writeFileSync(logPath, '');
    const p = pollJoinFile({
      child,
      logPath,
      startedAt: Date.now() - 1000,
      timeoutMs: 5000,
      pollMs: 20,
    });
    await new Promise((r) => setTimeout(r, 60));
    writeFileSync(
      t.joinFile,
      JSON.stringify({ joinUrl: 'https://x/join/a.b', updatedAt: new Date().toISOString() })
    );
    await expect(p).resolves.toMatchObject({ joinUrl: 'https://x/join/a.b' });
    child.kill();
  });

  it('bootLeader can be driven directly', async () => {
    t.inputs({ duration: '1m' });
    const r = await bootLeader({
      home: t.home,
      entry: FAKE_NODE_SERVER,
      ...readBootInputs(),
      pollMs: 50,
    });
    expect(r.trayId).toBe('fake-tray');
  });
});
