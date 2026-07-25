import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cliAssetName,
  defaultInstallDir,
  resolveLatestCliAsset,
  runInstallCli,
} from '../src/install-cli.js';

const ASSET_URL =
  'https://github.com/ai-ecoverse/slicc/releases/download/v5.71.1/slicc-darwin-arm64';

function release(tag: string, assetNames: string[]) {
  return {
    tag_name: tag,
    assets: assetNames.map((name) => ({
      name,
      browser_download_url: `https://github.com/ai-ecoverse/slicc/releases/download/${tag}/${name}`,
    })),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const tempDirs: string[] = [];
function makeInstallDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slicc-install-cli-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('cliAssetName', () => {
  it('maps Node platform/arch pairs to release asset names', () => {
    expect(cliAssetName('darwin', 'arm64')).toBe('slicc-darwin-arm64');
    expect(cliAssetName('darwin', 'x64')).toBe('slicc-darwin-amd64');
    expect(cliAssetName('linux', 'x64')).toBe('slicc-linux-amd64');
    expect(cliAssetName('linux', 'arm64')).toBe('slicc-linux-arm64');
    expect(cliAssetName('win32', 'x64')).toBe('slicc-windows-amd64.exe');
    expect(cliAssetName('win32', 'arm64')).toBe('slicc-windows-arm64.exe');
  });

  it('returns null for unreleased targets', () => {
    expect(cliAssetName('freebsd', 'x64')).toBeNull();
    expect(cliAssetName('linux', 'ia32')).toBeNull();
  });
});

describe('defaultInstallDir', () => {
  it('prefers HOME, then USERPROFILE, then cwd', () => {
    expect(defaultInstallDir({ HOME: '/home/me' })).toBe(join('/home/me', '.slicc', 'bin'));
    expect(defaultInstallDir({ USERPROFILE: 'C:\\Users\\me' })).toBe(
      join('C:\\Users\\me', '.slicc', 'bin')
    );
    expect(defaultInstallDir({})).toBe(join('.', '.slicc', 'bin'));
  });
});

describe('resolveLatestCliAsset', () => {
  it('skips releases without CLI assets (sparse releases) and picks the newest carrier', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse([
          release('v5.72.0', ['sliccy-5.72.0.tgz']),
          release('v5.71.1', ['slicc-darwin-arm64', 'slicc-linux-amd64']),
          release('v5.70.0', ['slicc-darwin-arm64']),
        ])
      );

    const resolved = await resolveLatestCliAsset('slicc-darwin-arm64', fetchImpl);
    expect(resolved).toEqual({
      version: 'v5.71.1',
      assetName: 'slicc-darwin-arm64',
      downloadUrl: ASSET_URL,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('paginates until it finds a carrier release', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([release('v5.72.0', [])]))
      .mockResolvedValueOnce(jsonResponse([release('v5.71.1', ['slicc-darwin-arm64'])]));

    const resolved = await resolveLatestCliAsset('slicc-darwin-arm64', fetchImpl);
    expect(resolved?.version).toBe('v5.71.1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('page=1');
    expect(fetchImpl.mock.calls[1]?.[0]).toContain('page=2');
  });

  it('returns null when the release list is exhausted', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([release('v5.72.0', [])]))
      .mockResolvedValueOnce(jsonResponse([]));

    expect(await resolveLatestCliAsset('slicc-darwin-arm64', fetchImpl)).toBeNull();
  });

  it('gives up after the page cap even when every page is full', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse([release('v5.0.0', ['sliccy-5.0.0.tgz'])]));

    expect(await resolveLatestCliAsset('slicc-darwin-arm64', fetchImpl)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('throws on a non-OK API response', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ message: 'rate limited' }, 403));
    await expect(resolveLatestCliAsset('slicc-darwin-arm64', fetchImpl)).rejects.toThrow('403');
  });
});

describe('runInstallCli', () => {
  function runOptions(installDir: string, fetchImpl: typeof fetch) {
    const lines: string[] = [];
    const errors: string[] = [];
    return {
      options: {
        fetchImpl,
        platform: 'darwin',
        arch: 'arm64',
        installDir,
        env: { HOME: '/home/me', PATH: `/usr/bin${delimiter}/bin` },
        log: (line: string) => lines.push(line),
        logError: (line: string) => errors.push(line),
      },
      lines,
      errors,
    };
  }

  it('downloads the binary, marks it executable, and hints about PATH', async () => {
    const installDir = makeInstallDir();
    const binary = Buffer.from('#!/bin/fake-binary');
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('api.github.com')) {
        return jsonResponse([
          release('v5.72.0', ['sliccy-5.72.0.tgz']),
          release('v5.71.1', ['slicc-darwin-arm64']),
        ]);
      }
      return new Response(binary);
    });
    const { options, lines, errors } = runOptions(installDir, fetchImpl);

    expect(await runInstallCli(options)).toBe(0);
    expect(errors).toEqual([]);

    const installed = join(installDir, 'slicc');
    expect(readFileSync(installed)).toEqual(binary);
    if (process.platform !== 'win32') {
      expect(statSync(installed).mode & 0o111).not.toBe(0);
    }
    // No leftover staging file
    expect(readdirSync(installDir)).toEqual(['slicc']);
    expect(lines.join('\n')).toContain('v5.71.1');
    expect(lines.join('\n')).toContain('not on your PATH');
  });

  it('skips the PATH hint when the install dir is already on PATH', async () => {
    const installDir = makeInstallDir();
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('api.github.com')) {
        return jsonResponse([release('v5.71.1', ['slicc-darwin-arm64'])]);
      }
      return new Response(Buffer.from('bin'));
    });
    const { options, lines } = runOptions(installDir, fetchImpl);
    options.env.PATH = `/usr/bin${delimiter}${installDir}`;

    expect(await runInstallCli(options)).toBe(0);
    expect(lines.join('\n')).not.toContain('not on your PATH');
  });

  it('fails cleanly on unsupported platforms', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { options, errors } = runOptions(makeInstallDir(), fetchImpl);
    options.platform = 'freebsd';

    expect(await runInstallCli(options)).toBe(1);
    expect(errors.join('\n')).toContain('freebsd/arm64');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails cleanly when no release carries the asset', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]));
    const { options, errors } = runOptions(makeInstallDir(), fetchImpl);

    expect(await runInstallCli(options)).toBe(1);
    expect(errors.join('\n')).toContain('no recent release carries slicc-darwin-arm64');
  });

  it('fails cleanly when the releases API errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('network down'));
    const { options, errors } = runOptions(makeInstallDir(), fetchImpl);

    expect(await runInstallCli(options)).toBe(1);
    expect(errors.join('\n')).toContain('network down');
  });

  it('cleans up the staging file when the download fails', async () => {
    const installDir = makeInstallDir();
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('api.github.com')) {
        return jsonResponse([release('v5.71.1', ['slicc-darwin-arm64'])]);
      }
      return new Response('missing', { status: 404 });
    });
    const { options, errors } = runOptions(installDir, fetchImpl);

    expect(await runInstallCli(options)).toBe(1);
    expect(errors.join('\n')).toContain('HTTP 404');
    expect(readdirSync(installDir)).toEqual([]);
    expect(existsSync(join(installDir, 'slicc'))).toBe(false);
  });

  it('rejects an empty download instead of installing a zero-byte binary', async () => {
    const installDir = makeInstallDir();
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('api.github.com')) {
        return jsonResponse([release('v5.71.1', ['slicc-darwin-arm64'])]);
      }
      return new Response(Buffer.alloc(0));
    });
    const { options, errors } = runOptions(installDir, fetchImpl);

    expect(await runInstallCli(options)).toBe(1);
    expect(errors.join('\n')).toContain('empty file');
    expect(readdirSync(installDir)).toEqual([]);
  });

  it('names the binary slicc.exe on Windows targets', async () => {
    const installDir = makeInstallDir();
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('api.github.com')) {
        return jsonResponse([release('v5.71.1', ['slicc-windows-amd64.exe'])]);
      }
      return new Response(Buffer.from('MZ'));
    });
    const { options } = runOptions(installDir, fetchImpl);
    options.platform = 'win32';
    options.arch = 'x64';

    expect(await runInstallCli(options)).toBe(0);
    expect(existsSync(join(installDir, 'slicc.exe'))).toBe(true);
  });
});
