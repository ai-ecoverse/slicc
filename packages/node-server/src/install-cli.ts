import { scanGithubReleases } from '@slicc/shared-ts';
import { accessSync, chmodSync, constants, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { delimiter, join } from 'path';

const USER_AGENT = 'sliccy-install-cli';
const API_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

export interface ResolvedCliAsset {
  version: string;
  assetName: string;
  downloadUrl: string;
}

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

function defaultIsWritableDir(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveInstallDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  isWritableDir: (dir: string) => boolean = defaultIsWritableDir
): string {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? join(env.USERPROFILE ?? '.', 'AppData', 'Local');
    return join(base, 'Programs', 'slicc');
  }
  const localBin = join(env.HOME ?? '.', '.local', 'bin');
  const pathDirs = (env.PATH ?? '').split(delimiter);
  if (pathDirs.includes(localBin)) {
    return localBin;
  }
  if (pathDirs.includes('/usr/local/bin') && isWritableDir('/usr/local/bin')) {
    return '/usr/local/bin';
  }
  return localBin;
}

export async function resolveLatestCliAsset(
  assetName: string,
  fetchImpl: typeof fetch = fetch
): Promise<ResolvedCliAsset | null> {
  const hit = await scanGithubReleases(fetchImpl, {
    userAgent: USER_AGENT,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    assetPredicate: (asset) =>
      asset.name === assetName && typeof asset.browser_download_url === 'string',
  });
  if (!hit || typeof hit.asset.browser_download_url !== 'string') {
    return null;
  }
  return {
    version: hit.release.tag_name ?? '',
    assetName,
    downloadUrl: hit.asset.browser_download_url,
  };
}

function isDirOnPath(dir: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? '').split(delimiter).includes(dir);
}

async function downloadTo(
  url: string,
  destination: string,
  fetchImpl: typeof fetch
): Promise<void> {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
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

  installDir?: string | null;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

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

  const installDir = options.installDir ?? resolveInstallDir(env, platform);
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
    for (const line of pathHintLines(platform, installDir)) {
      log(`[install-cli]   ${line}`);
    }
  }
  return 0;
}

function pathHintLines(platform: string, installDir: string): string[] {
  if (platform === 'win32') {
    return [
      `$env:Path += ";${installDir}"    (PowerShell, current session)`,
      `setx PATH "%PATH%;${installDir}"    (cmd, persistent)`,
    ];
  }
  return [`export PATH="${installDir}:$PATH"`];
}
