import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { delimiter, join } from 'path';

/**
 * Installer for the Go `slicc` follower CLI (`packages/slicc-cli`), invoked as
 * `npx sliccy --install-cli`.
 *
 * Release binaries are attached to GitHub releases as bare
 * `slicc-<os>-<arch>[.exe]` assets, but only on releases where
 * `packages/slicc-cli/` actually changed (see release-native.mjs) — so the
 * newest release does not necessarily carry them. The installer scans releases
 * newest→oldest for the first one with this platform's asset, mirroring the
 * cloudflare-worker's /download/slicc.dmg scan.
 */

const RELEASES_API = 'https://api.github.com/repos/ai-ecoverse/slicc/releases?per_page=30';
const MAX_RELEASE_PAGES = 5;
const USER_AGENT = 'sliccy-install-cli';

interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  assets?: GithubReleaseAsset[];
}

export interface ResolvedCliAsset {
  version: string;
  assetName: string;
  downloadUrl: string;
}

/**
 * Release-asset name for a Node platform/arch pair, or null when the release
 * pipeline does not build for it. Names mirror packages/slicc-cli/Makefile
 * (`PLATFORMS`, output `slicc-$os-$arch$ext`).
 */
const GO_OS: Record<string, string> = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
const GO_ARCH: Record<string, string> = { x64: 'amd64', arm64: 'arm64' };

export function cliAssetName(platform: string, arch: string): string | null {
  const os = GO_OS[platform];
  const goArch = GO_ARCH[arch];
  if (!os || !goArch) {
    return null;
  }
  return `slicc-${os}-${goArch}${os === 'windows' ? '.exe' : ''}`;
}

/** `~/.slicc/bin` — the same `~/.slicc` home the server uses for secrets and logs. */
export function defaultInstallDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? env.USERPROFILE ?? '.';
  return join(home, '.slicc', 'bin');
}

/**
 * Scan releases newest→oldest for the first one carrying `assetName`.
 * Returns null when no release within MAX_RELEASE_PAGES pages has it.
 */
export async function resolveLatestCliAsset(
  assetName: string,
  fetchImpl: typeof fetch = fetch
): Promise<ResolvedCliAsset | null> {
  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const res = await fetchImpl(`${RELEASES_API}&page=${page}`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) {
      throw new Error(`GitHub releases API responded ${res.status} for page ${page}`);
    }
    const releases = (await res.json()) as GithubRelease[];
    if (!Array.isArray(releases) || releases.length === 0) {
      return null;
    }
    for (const release of releases) {
      const asset = release.assets?.find((candidate) => candidate.name === assetName);
      if (asset) {
        return {
          version: release.tag_name,
          assetName,
          downloadUrl: asset.browser_download_url,
        };
      }
    }
  }
  return null;
}

function isDirOnPath(dir: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? '').split(delimiter).includes(dir);
}

async function downloadTo(
  url: string,
  destination: string,
  fetchImpl: typeof fetch
): Promise<void> {
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    throw new Error(`download failed with HTTP ${res.status} for ${url}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.byteLength === 0) {
    throw new Error(`download of ${url} produced an empty file`);
  }
  writeFileSync(destination, body);
}

export interface InstallCliOptions {
  fetchImpl?: typeof fetch;
  platform?: string;
  arch?: string;
  /** Overrides the `~/.slicc/bin` default (the `--install-dir` flag). */
  installDir?: string | null;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

/**
 * Download the newest released `slicc` CLI binary for this platform into the
 * install dir. Returns a process exit code.
 */
export async function runInstallCli(options: InstallCliOptions = {}): Promise<number> {
  const {
    fetchImpl = fetch,
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    log = console.log,
    logError = console.error,
  } = options;

  const assetName = cliAssetName(platform, arch);
  if (!assetName) {
    logError(
      `[install-cli] no slicc CLI build for ${platform}/${arch} — released targets are macOS/Linux/Windows on amd64/arm64`
    );
    return 1;
  }

  const installDir = options.installDir ?? defaultInstallDir(env);
  const binaryName = assetName.endsWith('.exe') ? 'slicc.exe' : 'slicc';
  const destination = join(installDir, binaryName);

  let resolved: ResolvedCliAsset | null;
  try {
    resolved = await resolveLatestCliAsset(assetName, fetchImpl);
  } catch (error) {
    logError(`[install-cli] could not query GitHub releases: ${(error as Error).message}`);
    return 1;
  }
  if (!resolved) {
    logError(
      `[install-cli] no recent release carries ${assetName} — CLI binaries only attach to releases where packages/slicc-cli changed`
    );
    return 1;
  }

  log(`[install-cli] installing slicc ${resolved.version} (${assetName}) to ${destination}`);
  const staging = join(installDir, `.${binaryName}.download-${process.pid}`);
  try {
    mkdirSync(installDir, { recursive: true });
    await downloadTo(resolved.downloadUrl, staging, fetchImpl);
    chmodSync(staging, 0o755);
    renameSync(staging, destination);
  } catch (error) {
    rmSync(staging, { force: true });
    logError(`[install-cli] install failed: ${(error as Error).message}`);
    return 1;
  }

  log(`[install-cli] installed ${destination}`);
  if (!isDirOnPath(installDir, env)) {
    log(`[install-cli] ${installDir} is not on your PATH — add it, e.g.:`);
    log(`[install-cli]   export PATH="${installDir}:$PATH"`);
  }
  return 0;
}
