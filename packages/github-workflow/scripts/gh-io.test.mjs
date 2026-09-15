import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cliPath,
  exportEnv,
  homeDir,
  input,
  isAlive,
  joinUrl,
  logTail,
  readState,
  setOutput,
  statePath,
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
