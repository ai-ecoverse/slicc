import { describe, expect, it } from 'vitest';
import {
  buildConeConfigFiles,
  buildExportSessionCommand,
  buildFollowArgs,
  buildInjectCommand,
  buildLeaderArgs,
  buildLeaderEnv,
  buildReadCommand,
  buildWriteCommand,
  checkWatchedProcesses,
  cliAssetName,
  formatGithubOutput,
  MAX_DURATION_MS,
  parseBoolean,
  parseDuration,
  parseJoinFile,
  parseMountLines,
  parseMountMapping,
  parsePort,
  parseSecretsEnv,
  pickCliRelease,
  posixDirname,
  requireVfsPath,
  serializeSecretsEnv,
  shellQuote,
  tailLines,
  truncateForOutput,
  validateSecretEntry,
} from './lib.mjs';

describe('parseDuration', () => {
  it('parses units and compounds', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('2h')).toBe(2 * 3_600_000);
    expect(parseDuration('1h30m')).toBe(90 * 60_000);
    expect(parseDuration(' 500ms ')).toBe(500);
  });
  it('treats a bare number as minutes', () => {
    expect(parseDuration('15')).toBe(15 * 60_000);
    expect(parseDuration(15)).toBe(15 * 60_000);
  });
  it('rejects empty, zero, garbage, and over-cap values', () => {
    expect(() => parseDuration('')).toThrow(/required/);
    expect(() => parseDuration('0m')).toThrow(/positive/);
    expect(() => parseDuration('soon')).toThrow(/invalid duration/);
    expect(() => parseDuration('5m later')).toThrow(/invalid duration/);
    expect(() => parseDuration('6h')).toThrow(/ceiling/);
    expect(parseDuration(`${MAX_DURATION_MS}ms`)).toBe(MAX_DURATION_MS);
  });
});

describe('parsePort', () => {
  it('defaults and validates', () => {
    expect(parsePort('')).toBe(5710);
    expect(parsePort(undefined)).toBe(5710);
    expect(parsePort('5720')).toBe(5720);
    expect(() => parsePort('80')).toThrow(/between 1024/);
    expect(() => parsePort('abc')).toThrow(/between 1024/);
    expect(() => parsePort('70000')).toThrow(/between 1024/);
  });
});

describe('mount table parsing', () => {
  it('splits on the last colon and expands ~', () => {
    expect(parseMountMapping('/home/runner/work/repo:/mnt/repo')).toEqual({
      hostPath: '/home/runner/work/repo',
      path: '/mnt/repo',
    });
    expect(parseMountMapping('~/docs:/mnt/docs', '/home/runner')).toEqual({
      hostPath: '/home/runner/docs',
      path: '/mnt/docs',
    });
    expect(parseMountMapping('/with:colon:/mnt/x')).toEqual({
      hostPath: '/with:colon',
      path: '/mnt/x',
    });
  });
  it('rejects non-canonical mappings', () => {
    expect(parseMountMapping('relative:/mnt/x')).toBeNull();
    expect(parseMountMapping('/a:/')).toBeNull();
    expect(parseMountMapping('/a:/mnt/../x')).toBeNull();
    expect(parseMountMapping('/a:mnt')).toBeNull();
    expect(parseMountMapping('~/x:/mnt/x', '')).toBeNull();
    expect(parseMountMapping('nocolon')).toBeNull();
  });
  it('parses multiline input, skipping comments, and throws on bad lines', () => {
    const text = '# repo\n/w/repo:/mnt/repo\n\n/w/data/:/mnt/data/\n';
    expect(parseMountLines(text)).toEqual([
      { hostPath: '/w/repo', path: '/mnt/repo' },
      { hostPath: '/w/data', path: '/mnt/data' },
    ]);
    expect(() => parseMountLines('/w/repo:/mnt/repo\nbogus')).toThrow(/line 2/);
    expect(() => parseMountLines('/a:/mnt/x\n/b:/mnt/x')).toThrow(/duplicate/);
    expect(parseMountLines('')).toEqual([]);
    expect(parseMountLines(undefined)).toEqual([]);
  });
});

describe('leader argv and env', () => {
  it('builds hosted argv with mounts', () => {
    expect(buildLeaderArgs()).toEqual(['--hosted']);
    expect(buildLeaderArgs({ mounts: [{ hostPath: '/w', path: '/mnt/w' }] })).toEqual([
      '--hosted',
      '--mount=/w:/mnt/w',
    ]);
  });
  it('strips INPUT_* and preboot bundles, sets the hosted knobs', () => {
    const env = buildLeaderEnv({
      base: {
        PATH: '/usr/bin',
        INPUT_CONE_CONFIG: '{"secret":1}',
        SLICC_CONE_CONFIG_B64: 'x',
        SLICC_SECRETS_ENV_B64: 'y',
        WORKER_BASE_URL: 'https://stale.example',
        SLICC_TRAY_WORKER_BASE_URL: 'https://stale-tray.example',
        UNDEFINED: undefined,
      },
      port: 5720,
      secretsFile: '/tmp/s.env',
      profileDir: '/tmp/profile',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      PORT: '5720',
      SLICC_SECRETS_FILE: '/tmp/s.env',
      CHROME_USER_DATA_DIR: '/tmp/profile',
      SLICC_CDP_LAUNCH_TIMEOUT_MS: '60000',
    });
  });
  it('forwards ui origin and tray worker overrides without trailing slashes', () => {
    const env = buildLeaderEnv({
      base: {},
      port: 5710,
      secretsFile: '/s',
      profileDir: '/p',
      uiOrigin: 'http://localhost:8787/',
      trayWorkerBaseUrl: 'https://staging.example//',
      cdpLaunchTimeoutMs: 90_000,
    });
    expect(env.WORKER_BASE_URL).toBe('http://localhost:8787');
    expect(env.SLICC_TRAY_WORKER_BASE_URL).toBe('https://staging.example');
    expect(env.SLICC_CDP_LAUNCH_TIMEOUT_MS).toBe('90000');
  });
});

describe('secrets.env', () => {
  it('parses NAME=value + NAME_DOMAINS pairs in order', () => {
    const entries = parseSecretsEnv(
      '# comment\nGITHUB_TOKEN=ghp_x\nGITHUB_TOKEN_DOMAINS=github.com, *.github.com\n\ns3.r2.endpoint=https://a.example\ns3.r2.endpoint_DOMAINS=*.r2.example\n'
    );
    expect(entries).toEqual([
      { name: 'GITHUB_TOKEN', value: 'ghp_x', domains: ['github.com', '*.github.com'] },
      { name: 's3.r2.endpoint', value: 'https://a.example', domains: ['*.r2.example'] },
    ]);
  });
  it('keeps = inside values', () => {
    expect(parseSecretsEnv('K=a=b\nK_DOMAINS=x')).toEqual([
      { name: 'K', value: 'a=b', domains: ['x'] },
    ]);
  });
  it('rejects unscoped, orphaned, malformed, and reserved entries', () => {
    expect(() => parseSecretsEnv('TOKEN=x')).toThrow(/no TOKEN_DOMAINS/);
    expect(() => parseSecretsEnv('TOKEN_DOMAINS=x')).toThrow(/no matching secret/);
    expect(() => parseSecretsEnv('=x')).toThrow(/line 1/);
    expect(() => parseSecretsEnv('novalue')).toThrow(/line 1/);
    expect(() => parseSecretsEnv('oauth.github=x\noauth.github_DOMAINS=y')).toThrow(/reserved/);
    expect(() => parseSecretsEnv('T=x\nT_DOMAINS=')).toThrow(/non-empty/);
  });
  it('round-trips through serialize', () => {
    const entries = [{ name: 'A', value: '1', domains: ['a', 'b'] }];
    expect(serializeSecretsEnv(entries)).toBe('A=1\nA_DOMAINS=a,b\n');
    expect(parseSecretsEnv(serializeSecretsEnv(entries))).toEqual(entries);
    expect(serializeSecretsEnv([])).toBe('');
  });
  it('validateSecretEntry enforces the line-oriented schema', () => {
    expect(() => validateSecretEntry(null)).toThrow(/not an object/);
    expect(() => validateSecretEntry({ name: '9x', value: 'v', domains: ['d'] })).toThrow(/name/);
    expect(() => validateSecretEntry({ name: 'A', value: 'a\nb', domains: ['d'] })).toThrow(
      /single-line/
    );
    expect(() => validateSecretEntry({ name: 'A', value: 'v', domains: ['a,b'] })).toThrow(
      /comma-free/
    );
    expect(() => validateSecretEntry({ name: 'A', value: 'v', domains: [] })).toThrow(/non-empty/);
    expect(validateSecretEntry({ name: 'A', value: 'v', domains: [' d '] })).toEqual({
      name: 'A',
      value: 'v',
      domains: ['d'],
    });
  });
});

describe('buildConeConfigFiles', () => {
  it('returns no cone-config and empty secrets when nothing is given', () => {
    expect(buildConeConfigFiles()).toEqual({
      coneConfigJson: null,
      secretsEnv: '',
      summary: { model: null, effortLevel: null, accountProviderIds: [], secretNames: [] },
    });
  });
  it('splits a ConeConfig bundle into cone-config.json and secrets.env', () => {
    const out = buildConeConfigFiles({
      coneConfigJson: JSON.stringify({
        model: 'anthropic:claude-opus-4-6',
        effortLevel: 'high',
        accounts: [
          { providerId: 'anthropic', kind: 'apikey', apiKey: 'sk-1', ignored: true },
          {
            providerId: 'github',
            kind: 'oauth',
            accessToken: 'gho',
            refreshToken: 'r',
            tokenExpiresAt: 5,
          },
        ],
        secrets: [{ name: 'API', value: 'v', domains: ['api.example'] }],
      }),
    });
    expect(JSON.parse(out.coneConfigJson)).toEqual({
      model: 'anthropic:claude-opus-4-6',
      effortLevel: 'high',
      accounts: [
        { providerId: 'anthropic', kind: 'apikey', apiKey: 'sk-1' },
        {
          providerId: 'github',
          kind: 'oauth',
          accessToken: 'gho',
          refreshToken: 'r',
          tokenExpiresAt: 5,
        },
      ],
    });
    expect(out.secretsEnv).toBe('API=v\nAPI_DOMAINS=api.example\n');
    expect(out.summary).toEqual({
      model: 'anthropic:claude-opus-4-6',
      effortLevel: 'high',
      accountProviderIds: ['anthropic', 'github'],
      secretNames: ['API'],
    });
    expect(JSON.stringify(out.summary)).not.toContain('sk-1');
  });
  it('lets explicit model/effort override the bundle and secrets-env win on collisions', () => {
    const out = buildConeConfigFiles({
      coneConfigJson: JSON.stringify({
        model: 'a',
        effortLevel: 'low',
        secrets: [{ name: 'T', value: 'bundle', domains: ['x'] }],
      }),
      secretsEnvText: 'T=env\nT_DOMAINS=y\nU=1\nU_DOMAINS=z',
      model: 'b',
      effortLevel: 'xhigh',
    });
    expect(JSON.parse(out.coneConfigJson)).toEqual({
      model: 'b',
      effortLevel: 'xhigh',
      accounts: [],
    });
    expect(out.secretsEnv).toBe('T=env\nT_DOMAINS=y\nU=1\nU_DOMAINS=z\n');
  });
  it('writes a cone-config for a bare model but not for secrets alone', () => {
    expect(buildConeConfigFiles({ model: 'm' }).coneConfigJson).toBe('{"model":"m","accounts":[]}');
    expect(buildConeConfigFiles({ secretsEnvText: 'A=1\nA_DOMAINS=d' }).coneConfigJson).toBeNull();
  });
  it('rejects malformed bundles', () => {
    expect(() => buildConeConfigFiles({ coneConfigJson: '{' })).toThrow(/not valid JSON/);
    expect(() => buildConeConfigFiles({ coneConfigJson: '[]' })).toThrow(/JSON object/);
    expect(() => buildConeConfigFiles({ coneConfigJson: '{"accounts":{}}' })).toThrow(/array/);
    expect(() => buildConeConfigFiles({ coneConfigJson: '{"secrets":1}' })).toThrow(/array/);
    expect(() =>
      buildConeConfigFiles({ coneConfigJson: '{"accounts":[{"providerId":"x","kind":"oauth"}]}' })
    ).toThrow(/accessToken/);
    expect(() =>
      buildConeConfigFiles({ coneConfigJson: '{"accounts":[{"providerId":"x","kind":"apikey"}]}' })
    ).toThrow(/apiKey/);
    expect(() =>
      buildConeConfigFiles({ coneConfigJson: '{"accounts":[{"providerId":"x","kind":"nope"}]}' })
    ).toThrow(/kind/);
    expect(() =>
      buildConeConfigFiles({ coneConfigJson: '{"accounts":[{"kind":"apikey","apiKey":"k"}]}' })
    ).toThrow(/providerId/);
    expect(() => buildConeConfigFiles({ coneConfigJson: '{"accounts":[null]}' })).toThrow(
      /not an object/
    );
    expect(() => buildConeConfigFiles({ effortLevel: 'max' })).toThrow(/effort-level/);
  });
});

describe('parseJoinFile', () => {
  const fresh = JSON.stringify({
    joinUrl: 'https://x/join/a.b',
    trayId: 't',
    updatedAt: '2026-09-15T10:00:00.000Z',
    sliccVersion: '6.1.0',
  });
  it('accepts a fresh file', () => {
    expect(parseJoinFile(fresh, Date.parse('2026-09-15T09:59:00Z'))).toEqual({
      joinUrl: 'https://x/join/a.b',
      trayId: 't',
      updatedAt: Date.parse('2026-09-15T10:00:00Z'),
      sliccVersion: '6.1.0',
    });
  });
  it('rejects stale, malformed, and url-less files', () => {
    expect(parseJoinFile(fresh, Date.parse('2026-09-15T10:00:01Z'))).toBeNull();
    expect(parseJoinFile('', 0)).toBeNull();
    expect(parseJoinFile(null, 0)).toBeNull();
    expect(parseJoinFile('{', 0)).toBeNull();
    expect(parseJoinFile('"str"', 0)).toBeNull();
    expect(parseJoinFile('{"joinUrl":""}', 0)).toBeNull();
    expect(parseJoinFile('{"joinUrl":"u"}', 0)).toBeNull();
    expect(
      parseJoinFile('{"joinUrl":"u","updatedAt":"2026-01-01T00:00:00Z","trayId":5}', 0)
    ).toEqual({
      joinUrl: 'u',
      trayId: null,
      updatedAt: Date.parse('2026-01-01T00:00:00Z'),
      sliccVersion: null,
    });
  });
});

describe('CLI release selection', () => {
  it('names assets like the Makefile', () => {
    expect(cliAssetName('linux', 'x64')).toBe('slicc-linux-amd64');
    expect(cliAssetName('darwin', 'arm64')).toBe('slicc-darwin-arm64');
    expect(cliAssetName('win32', 'x64')).toBe('slicc-windows-amd64.exe');
    expect(cliAssetName('freebsd', 'x64')).toBeNull();
    expect(cliAssetName('linux', 'ia32')).toBeNull();
  });
  it('picks the newest published carrier, skipping drafts and prereleases', () => {
    const releases = [
      {
        tag_name: 'v3',
        draft: true,
        assets: [{ name: 'slicc-linux-amd64', browser_download_url: 'd3' }],
      },
      {
        tag_name: 'v2',
        prerelease: true,
        assets: [{ name: 'slicc-linux-amd64', browser_download_url: 'd2' }],
      },
      { tag_name: 'v1', assets: [{ name: 'other' }] },
      null,
      { tag_name: 'v0', assets: [{ name: 'slicc-linux-amd64', browser_download_url: 'd0' }] },
    ];
    expect(pickCliRelease(releases, 'slicc-linux-amd64')).toEqual({
      version: 'v0',
      downloadUrl: 'd0',
    });
    expect(pickCliRelease(releases, 'slicc-darwin-arm64')).toBeNull();
    expect(pickCliRelease(undefined, 'x')).toBeNull();
  });
});

describe('GitHub output formatting', () => {
  it('uses the simple form for single lines and a heredoc otherwise', () => {
    expect(formatGithubOutput('a', 'b')).toBe('a=b\n');
    expect(formatGithubOutput('n', 42)).toBe('n=42\n');
    expect(formatGithubOutput('e', undefined)).toBe('e=\n');
    expect(formatGithubOutput('m', 'x\ny')).toBe('m<<ghadelim_slicc\nx\ny\nghadelim_slicc\n');
  });
  it('picks a delimiter absent from the value', () => {
    const out = formatGithubOutput('m', 'ghadelim_slicc\nghadelim_slicc_1\n');
    expect(out.startsWith('m<<ghadelim_slicc_2\n')).toBe(true);
  });
});

describe('leader-shell command builders', () => {
  it('single-quotes safely', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('plain')).toBe(`'plain'`);
  });
  it('validates VFS paths', () => {
    expect(requireVfsPath('/a/b/')).toBe('/a/b');
    expect(requireVfsPath('/')).toBe('/');
    expect(() => requireVfsPath('rel')).toThrow(/absolute/);
    expect(() => requireVfsPath('/a/../b')).toThrow(/\.\./);
    expect(() => requireVfsPath('/a\nb')).toThrow(/single line/);
    expect(posixDirname('/a/b/c')).toBe('/a/b');
    expect(posixDirname('/c')).toBe('/');
  });
  it('builds read, write, inject, and export commands', () => {
    expect(buildReadCommand('/workspace/out.txt')).toBe(`base64 '/workspace/out.txt'`);
    expect(buildWriteCommand("/workspace/it's.txt")).toBe(
      `mkdir -p '/workspace' && base64 -d > '/workspace/it'\\''s.txt'`
    );
    expect(buildInjectCommand('/')).toBe(
      `mkdir -p '/' && base64 -d > '/tmp/slicc-inject.tgz' && tar -xzf '/tmp/slicc-inject.tgz' -C '/' && rm -f '/tmp/slicc-inject.tgz'`
    );
    expect(buildExportSessionCommand('/tmp/s.zip')).toBe(`session export --output '/tmp/s.zip'`);
    expect(buildExportSessionCommand('/tmp/s.zip', ' abc ')).toBe(
      `session export --id 'abc' --output '/tmp/s.zip'`
    );
  });
});

describe('buildFollowArgs', () => {
  it('defaults to bash -c and supports eval mode', () => {
    expect(buildFollowArgs({ joinUrl: 'u' })).toEqual([
      'u',
      'follow',
      '--plain',
      '--no-banner',
      'bash',
      '-c',
    ]);
    expect(buildFollowArgs({ joinUrl: 'u', runner: 'docker exec -i box sh -c' })).toEqual([
      'u',
      'follow',
      '--plain',
      '--no-banner',
      'docker',
      'exec',
      '-i',
      'box',
      'sh',
      '-c',
    ]);
    expect(
      buildFollowArgs({ joinUrl: 'u', runner: 'python -i', evalMode: true, evalQuiet: '2s' })
    ).toEqual([
      'u',
      'follow',
      '--plain',
      '--no-banner',
      '--eval',
      '--eval-quiet',
      '2s',
      'python',
      '-i',
    ]);
  });
});

describe('small helpers', () => {
  it('truncateForOutput caps by bytes', () => {
    expect(truncateForOutput('abc', 10)).toEqual({ text: 'abc', truncated: false });
    const big = truncateForOutput('x'.repeat(20), 5);
    expect(big.truncated).toBe(true);
    expect(big.text.startsWith('xxxxx')).toBe(true);
  });
  it('tailLines returns the last n lines', () => {
    expect(tailLines('a\nb\nc\n', 2)).toBe('b\nc');
    expect(tailLines('', 2)).toBe('');
  });
  it('parseBoolean handles the usual spellings', () => {
    expect(parseBoolean('true')).toBe(true);
    expect(parseBoolean('No')).toBe(false);
    expect(parseBoolean('', true)).toBe(true);
    expect(() => parseBoolean('maybe')).toThrow(/boolean/);
  });
  it('checkWatchedProcesses reports dead pids per role', () => {
    const alive = new Set([1, 3]);
    const state = { leader: 1, followers: [2, 3] };
    expect(checkWatchedProcesses(state, (pid) => alive.has(pid), 'all')).toEqual({
      ok: false,
      dead: [{ role: 'follower', pid: 2 }],
    });
    expect(checkWatchedProcesses(state, (pid) => alive.has(pid), 'leader').ok).toBe(true);
    expect(checkWatchedProcesses({ leader: 9 }, () => false, 'followers').ok).toBe(true);
    expect(checkWatchedProcesses({ leader: 9 }, () => false, 'leader')).toEqual({
      ok: false,
      dead: [{ role: 'leader', pid: 9 }],
    });
  });
});
