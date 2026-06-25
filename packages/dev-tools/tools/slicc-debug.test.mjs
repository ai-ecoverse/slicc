import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_CWD,
  parseArgv,
  pickPageTarget,
  readPayload,
  resolveCwd,
  resolvePayloadSource,
  resolveUrlFilter,
} from './slicc-debug.mjs';

describe('parseArgv', () => {
  it('splits known value-flags (space and = forms) from positionals', () => {
    expect(parseArgv(['--url', 'localhost:5710', 'shell', 'ls'])).toEqual({
      flags: { url: 'localhost:5710' },
      positional: ['shell', 'ls'],
    });
    expect(parseArgv(['eval', '--target=worker', '1+1'])).toEqual({
      flags: { target: 'worker' },
      positional: ['eval', '1+1'],
    });
  });

  it('preserves unknown --tokens as positionals so shell commands survive', () => {
    expect(parseArgv(['shell', 'git', '--version'])).toEqual({
      flags: {},
      positional: ['shell', 'git', '--version'],
    });
  });
});

describe('resolveUrlFilter', () => {
  it('uses --url over the env default', () => {
    const { flags } = parseArgv(['--url', 'localhost:5720', 'eval', '1']);
    expect(resolveUrlFilter(flags, { SLICC_TARGET_URL: 'localhost:5710' })).toEqual({
      value: 'localhost:5720',
      isRegex: false,
    });
  });

  it('falls back to SLICC_TARGET_URL when the flag is absent', () => {
    const { flags } = parseArgv(['eval', '1']);
    expect(resolveUrlFilter(flags, { SLICC_TARGET_URL: 'localhost:5710' })).toEqual({
      value: 'localhost:5710',
      isRegex: false,
    });
  });

  it('treats --url-pattern as a regex and outranks --url', () => {
    const { flags } = parseArgv(['--url-pattern', 'localhost:57\\d\\d', 'eval', '1']);
    expect(resolveUrlFilter(flags, {})).toEqual({ value: 'localhost:57\\d\\d', isRegex: true });
  });

  it('returns null when nothing is configured', () => {
    expect(resolveUrlFilter({}, {})).toBeNull();
  });
});

describe('pickPageTarget (dev-server heuristic)', () => {
  const targets = [
    { type: 'page', url: 'https://www.google.com/search' },
    { type: 'page', url: 'http://localhost:5710/?slicc=leader' },
    { type: 'worker', url: 'blob:http://localhost:5710/abc' },
  ];

  it('narrows to a single filtered match', () => {
    expect(pickPageTarget(targets, { value: 'google', isRegex: false }).url).toContain('google');
  });

  it('falls back to the dev-server port when no filter is given', () => {
    expect(pickPageTarget(targets, null).url).toContain('localhost:5710');
  });

  it('uses the dev-server port when the filter matches nothing', () => {
    expect(pickPageTarget(targets, { value: 'nope', isRegex: false }).url).toContain(
      'localhost:5710'
    );
  });

  it('falls back to the first page when neither filter nor heuristic matches', () => {
    const plain = [
      { type: 'page', url: 'https://a.example' },
      { type: 'page', url: 'https://b.example' },
    ];
    expect(pickPageTarget(plain, null).url).toBe('https://a.example');
  });
});

describe('resolveCwd', () => {
  it('honours --cwd > SLICC_CWD > default', () => {
    expect(resolveCwd(parseArgv(['--cwd', '/tmp/x']).flags, { SLICC_CWD: '/env' })).toBe('/tmp/x');
    expect(resolveCwd({}, { SLICC_CWD: '/env' })).toBe('/env');
    expect(resolveCwd({}, {})).toBe(DEFAULT_CWD);
    expect(DEFAULT_CWD).toBe('/workspace');
  });
});

describe('payload resolution (--file / stdin / inline)', () => {
  let dir;
  let file;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'slicc-debug-'));
    file = join(dir, 'payload.js');
    writeFileSync(file, 'JSON.stringify({ok: true})\n');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads file contents via --file', async () => {
    const { flags, positional } = parseArgv(['eval', '--file', file]);
    const src = resolvePayloadSource(flags, positional.slice(1));
    expect(await readPayload(src)).toBe('JSON.stringify({ok: true})\n');
  });

  it('reads stdin when --file is "-"', async () => {
    const { flags, positional } = parseArgv(['eval', '--file', '-']);
    const src = resolvePayloadSource(flags, positional.slice(1));
    const stdin = Readable.from(['hello ', 'stdin']);
    expect(await readPayload(src, { stdin })).toBe('hello stdin');
  });

  it('returns the inline positional payload when no --file is given', async () => {
    const { flags, positional } = parseArgv(['eval', '1', '+', '1']);
    const src = resolvePayloadSource(flags, positional.slice(1));
    expect(await readPayload(src)).toBe('1 + 1');
  });

  it('errors when --file and an inline payload are both supplied', () => {
    const { flags, positional } = parseArgv(['eval', '--file', file, '1+1']);
    expect(() => resolvePayloadSource(flags, positional.slice(1))).toThrow(
      /cannot combine --file/i
    );
  });
});
