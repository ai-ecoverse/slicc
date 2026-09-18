#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  addPath,
  ensureDir,
  exportEnv,
  fail,
  homeDir,
  input,
  isMain,
  setOutput,
} from './gh-io.mjs';
import { cliAssetName, parseBoolean, pickCliRelease } from './lib.mjs';

export const RELEASES_URL = 'https://api.github.com/repos/ai-ecoverse/slicc/releases';
const PER_PAGE = 100;
const MAX_PAGES = 5;
const USER_AGENT = 'slicc-github-workflow';

function headers(token) {
  const h = { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function fetchJson(url, token, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: headers(token),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
  return res.json();
}

export async function resolveRelease(version, assetName, token, fetchImpl = fetch) {
  if (version && version !== 'latest') {
    const tag = version.startsWith('v') ? version : `v${version}`;
    const release = await fetchJson(
      `${RELEASES_URL}/tags/${encodeURIComponent(tag)}`,
      token,
      fetchImpl
    );
    const hit = pickCliRelease([{ ...release, draft: false, prerelease: false }], assetName);
    if (!hit) throw new Error(`release ${tag} carries no ${assetName} asset`);
    return hit;
  }
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const releases = await fetchJson(
      `${RELEASES_URL}?per_page=${PER_PAGE}&page=${page}`,
      token,
      fetchImpl
    );
    const hit = pickCliRelease(releases, assetName);
    if (hit) return hit;
    if (!Array.isArray(releases) || releases.length < PER_PAGE) break;
  }
  throw new Error(
    `no published release with a ${assetName} asset in the last ${MAX_PAGES * PER_PAGE} releases`
  );
}

export async function download(url, token, destination, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': USER_AGENT, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`download ${res.status} for ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const staging = `${destination}.download-${process.pid}`;
  writeFileSync(staging, bytes, { mode: 0o755 });
  chmodSync(staging, 0o755);
  renameSync(staging, destination);
  return bytes.length;
}

export function buildFromSource(buildDir, binary, exec = execFileSync) {
  const moduleDir = resolve(buildDir);
  if (!existsSync(join(moduleDir, 'go.mod'))) {
    throw new Error(
      `no Go module at ${moduleDir} (expected packages/slicc-cli of a slicc checkout)`
    );
  }
  const version = `gw-${(process.env.GITHUB_SHA ?? 'local').slice(0, 12)}`;
  exec('go', ['build', '-ldflags', `-s -w -X main.version=${version}`, '-o', binary, '.'], {
    cwd: moduleDir,
    stdio: 'inherit',
  });
  chmodSync(binary, 0o755);
  return version;
}

export async function main(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const exec = options.exec ?? execFileSync;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const assetName = cliAssetName(platform, arch);
  if (!assetName) throw new Error(`no slicc CLI build for ${platform}/${arch}`);
  const token = input('token');
  const version = input('version', { fallback: 'latest' });
  const source = input('source', { fallback: 'release' });
  const installDir = ensureDir(input('install-dir') || join(homeDir(), 'cli'));
  const binary = join(installDir, platform === 'win32' ? 'slicc.exe' : 'slicc');

  let hit;
  let bytes = 0;
  if (source === 'build') {
    const buildDir =
      input('build-dir') ||
      join(process.env.GITHUB_WORKSPACE ?? process.cwd(), 'packages/slicc-cli');
    hit = { version: buildFromSource(buildDir, binary, exec) };
    console.log(`[install-cli] built ${binary} from ${buildDir}`);
  } else if (source === 'release') {
    hit = await resolveRelease(version, assetName, token, fetchImpl);
    console.log(`[install-cli] ${assetName} from release ${hit.version}`);
    bytes = await download(hit.downloadUrl, token, binary, fetchImpl);
  } else {
    throw new Error(`source must be release|build, got "${source}"`);
  }
  const reported = exec(binary, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`[install-cli] installed ${binary} (${bytes} bytes): ${reported}`);

  addPath(installDir);
  exportEnv('SLICC_CLI', binary);
  exportEnv('SLICC_NO_UPDATE_CHECK', '1');
  if (!parseBoolean(input('telemetry'), false)) exportEnv('SLICC_NO_TELEMETRY', '1');
  setOutput('path', binary);
  setOutput('version', hit.version);
  return { binary, version: hit.version, bytes };
}

/* v8 ignore start */
if (isMain(import.meta.url)) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
/* v8 ignore stop */
