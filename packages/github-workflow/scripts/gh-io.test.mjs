import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setup, sleep } from '../tests/helpers.mjs';
import {
  addPath,
  cliPath,
  coneConfigPath,
  execOnLeader,
  exportEnv,
  fail,
  group,
  homeDir,
  input,
  isAlive,
  isConnectFailure,
  isMain,
  joinFilePath,
  joinUrl,
  logTail,
  notice,
  readState,
  setOutput,
  sleepSync,
  statePath,
  terminate,
  waitForExit,
  warning,
  writeState,
} from './gh-io.mjs';

describe('gh-io', () => {
  let dir;
  const saved = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slicc-gw-'));
    process.env.SLICC_GW_HOME = dir;
    process.env.GITHUB_OUTPUT = join(dir, 'out');
    process.env.GITHUB_ENV = join(dir, 'env');
    writeFileSync(process.env.GITHUB_OUTPUT, '');
    writeFileSync(process.env.GITHUB_ENV, '');
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reads kebab-case inputs from INPUT_* env', () => {
    process.env.INPUT_SLICC_VERSION = ' 6.1.0 ';
    expect(input('slicc-version')).toBe('6.1.0');
    process.env.INPUT_PROMPT = '  a\n';
    expect(input('prompt', { raw: true })).toBe('  a\n');
    expect(input('missing', { fallback: 'x' })).toBe('x');
    expect(() => input('missing', { required: true })).toThrow(/required/);
  });

  it('honours SLICC_GW_HOME and round-trips the state file', () => {
    expect(homeDir()).toBe(dir);
    expect(readState()).toBeNull();
    writeState({ leader: 1, followers: [] });
    expect(readState()).toEqual({ leader: 1, followers: [] });
    expect(statePath()).toBe(join(dir, 'state.json'));
  });

  it('appends outputs and env exports to the command files', () => {
    setOutput('a', 'b');
    setOutput('m', 'x\ny');
    exportEnv('SLICC_CLI', '/bin/slicc');
    expect(readFileSync(process.env.GITHUB_OUTPUT, 'utf8')).toBe(
      'a=b\nm<<ghadelim_slicc\nx\ny\nghadelim_slicc\n'
    );
    expect(readFileSync(process.env.GITHUB_ENV, 'utf8')).toBe('SLICC_CLI=/bin/slicc\n');
  });

  it('falls back to stdout when no command file is set', () => {
    delete process.env.GITHUB_OUTPUT;
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    setOutput('a', 'b');
    expect(write).toHaveBeenCalledWith('[GITHUB_OUTPUT] a=b\n');
  });

  it('checks liveness by signal 0', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(0)).toBe(false);
    expect(isAlive('x')).toBe(false);
    expect(isAlive(2 ** 22 - 1)).toBe(false);
  });

  it('tails logs and tolerates missing files', () => {
    const log = join(dir, 'l.log');
    writeFileSync(log, 'a\nb\nc\n');
    expect(logTail(log, 2)).toBe('b\nc');
    expect(logTail(join(dir, 'nope'), 2)).toBe('');
    expect(logTail('', 2)).toBe('');
  });

  it('resolves the CLI path and validates the join url', () => {
    delete process.env.SLICC_CLI;
    expect(cliPath()).toBe('slicc');
    process.env.SLICC_CLI = '/opt/slicc';
    expect(cliPath()).toBe('/opt/slicc');
    delete process.env.SLICC_JOIN_URL;
    expect(() => joinUrl()).toThrow(/required/);
    process.env.SLICC_JOIN_URL = 'ftp://x';
    expect(() => joinUrl()).toThrow(/https/);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.SLICC_JOIN_URL = 'https://www.sliccy.ai/join/a.b';
    expect(joinUrl()).toBe('https://www.sliccy.ai/join/a.b');
    expect(log).toHaveBeenCalledWith('::add-mask::https://www.sliccy.ai/join/a.b');
  });
});

describe('gh-io process + leader helpers', () => {
  let t;
  beforeEach(() => {
    t = setup();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    t.teardown();
    vi.restoreAllMocks();
  });

  it('isMain recognises the entry script', () => {
    expect(isMain(pathToFileURL(process.argv[1]).href)).toBe(true);
    expect(isMain('file:///nowhere.mjs')).toBe(false);
  });

  it('path seams fall back to the node-server constants', () => {
    delete process.env.SLICC_GW_JOIN_FILE;
    delete process.env.SLICC_GW_CONE_CONFIG_PATH;
    expect(joinFilePath()).toBe('/tmp/slicc-join.json');
    expect(coneConfigPath()).toBe('/slicc/cone-config.json');
  });

  it('terminate escalates from SIGTERM to SIGKILL and tolerates gone pids', async () => {
    const stubborn = spawn(process.execPath, [
      '-e',
      'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)',
    ]);
    await sleep(150);
    expect(isAlive(stubborn.pid)).toBe(true);
    await terminate(stubborn.pid, 200);
    expect(isAlive(stubborn.pid)).toBe(false);
    await terminate(stubborn.pid, 10);
    expect(await waitForExit(stubborn.pid, 10)).toBe(true);
  });

  it('execOnLeader returns stdout, forwards stderr, retries dials, and throws on failure', () => {
    writeFileSync(join(t.fake, 'dial-failures'), '1');
    const out = execOnLeader('u', 'dial-fail x', { timeoutMs: 5000, retryDelayMs: 5 });
    expect(out.toString()).toBe('ok after retry\n');
    expect(console.log).toHaveBeenCalledWith(
      '::warning::leader dial failed (attempt 1/3); retrying in 0.005s'
    );
    expect(() => execOnLeader('u', 'fail 4', { timeoutMs: 5000 })).toThrow(/status 4/);
    expect(process.stderr.write).toHaveBeenCalledWith('boom\n');
    writeFileSync(join(t.fake, 'dial-failures'), '5');
    expect(() =>
      execOnLeader('u', 'dial-fail y', { timeoutMs: 5000, retries: 2, retryDelayMs: 5 })
    ).toThrow(/status 1/);
    process.env.SLICC_CLI = join(t.root, 'missing-cli');
    expect(() => execOnLeader('u', 'x', { timeoutMs: 1000 })).toThrow(/ENOENT/);
  });

  it('isConnectFailure only matches dial errors on non-zero status', () => {
    expect(isConnectFailure(1, 'slicc exec: tray connect timed out after 30s')).toBe(true);
    expect(isConnectFailure(0, 'tray connect timed out')).toBe(false);
    expect(isConnectFailure(1, 'command not found')).toBe(false);
    expect(isConnectFailure(1, undefined)).toBe(false);
  });

  it('annotations, path export, and fail', () => {
    notice('n');
    warning('w');
    group('title', 'body');
    expect(console.log.mock.calls.map(([m]) => m)).toEqual([
      '::notice::n',
      '::warning::w',
      '::group::title',
      'body',
      '::endgroup::',
    ]);
    addPath('/opt/bin');
    expect(readFileSync(process.env.GITHUB_PATH, 'utf8')).toBe('/opt/bin\n');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fail('bad');
    expect(error).toHaveBeenCalledWith('::error::bad');
    expect(exit).toHaveBeenCalledWith(1);
    const started = Date.now();
    sleepSync(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    sleepSync(0);
  });
});
