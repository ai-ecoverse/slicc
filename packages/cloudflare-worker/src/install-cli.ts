/**
 * `GET /install-cli` — POSIX shell installer for the Go `slicc` follower CLI
 * (`packages/slicc-cli`), used as:
 *
 *   curl -fsSL https://www.sliccy.ai/install-cli | sh
 *
 * `GET /download/slicc-cli/:target` — 302 to the newest GitHub release asset
 * for that target (`darwin-arm64`, `linux-amd64`, …). Release binaries are
 * sparse: they only attach to releases where `packages/slicc-cli` changed, so
 * the scan walks releases newest→oldest for the first carrier (same bounded
 * pagination as `/download/slicc.dmg` in `index.ts`).
 *
 * Unlike the DMG route — which 302s to the releases *page* on failure, fine
 * for a human in a browser — failures here return real HTTP errors so the
 * installer script's `curl -f` aborts instead of saving an HTML page as the
 * binary.
 */

const RELEASES_PER_PAGE = 100;
const RELEASES_API = `https://api.github.com/repos/ai-ecoverse/slicc/releases?per_page=${RELEASES_PER_PAGE}`;
// Bounded pagination (5 × 100 releases ≈ months of sparse releases) mirroring
// the DMG route's guard against rate-limit exhaustion.
const MAX_RELEASE_PAGES = 5;

/** Targets cross-compiled by packages/slicc-cli/Makefile (`PLATFORMS`). */
export const CLI_TARGETS = [
  'darwin-amd64',
  'darwin-arm64',
  'linux-amd64',
  'linux-arm64',
  'windows-amd64',
  'windows-arm64',
] as const;

interface GithubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface GithubRelease {
  draft?: boolean;
  prerelease?: boolean;
  assets?: GithubReleaseAsset[];
}

/** PURE: release-asset name for a target, or null for an unknown target. */
export function cliAssetNameForTarget(target: string): string | null {
  if (!(CLI_TARGETS as readonly string[]).includes(target)) {
    return null;
  }
  return `slicc-${target}${target.startsWith('windows-') ? '.exe' : ''}`;
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * Redirect to the newest published release that ships the target's CLI binary,
 * paginating newest→oldest past binary-less releases.
 */
export async function handleCliDownload(
  target: string,
  fetchImpl: typeof fetch
): Promise<Response> {
  const assetName = cliAssetNameForTarget(target);
  if (!assetName) {
    return textResponse(
      `Unknown slicc CLI target "${target}". Valid targets: ${CLI_TARGETS.join(', ')}\n`,
      404
    );
  }
  try {
    for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
      const res = await fetchImpl(`${RELEASES_API}&page=${page}`, {
        headers: { 'User-Agent': 'slicc-tray-hub' },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      if (!res.ok) {
        return textResponse(`GitHub releases API responded ${res.status}\n`, 502);
      }
      let releases: unknown;
      try {
        releases = await res.json();
      } catch {
        return textResponse('GitHub releases API returned unparseable JSON\n', 502);
      }
      if (!Array.isArray(releases) || releases.length === 0) {
        break;
      }
      for (const release of releases as GithubRelease[]) {
        if (release.draft || release.prerelease) {
          continue;
        }
        const asset = release.assets?.find((candidate) => candidate.name === assetName);
        if (asset?.browser_download_url) {
          return Response.redirect(asset.browser_download_url, 302);
        }
      }
      // Fewer than a full page means we've reached the last page — stop early.
      if (releases.length < RELEASES_PER_PAGE) {
        break;
      }
    }
    return textResponse(
      `No recent release carries ${assetName} — CLI binaries only attach to releases where packages/slicc-cli changed.\n`,
      404
    );
  } catch (error) {
    return textResponse(`Could not reach the GitHub releases API: ${String(error)}\n`, 502);
  }
}

/** The installer script, with download URLs pinned to the serving origin. */
export function buildInstallCliScriptResponse(request: Request): Response {
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  // Lock curl to https for real deployments; an http origin only occurs in
  // local dev (`wrangler dev`), where `--proto '=https'` would reject the
  // download URL outright.
  const protoFlag = origin.startsWith('https://') ? "--proto '=https' " : '';
  const body = `#!/bin/sh
# slicc CLI installer — the headless SLICC follower CLI.
#
# Usage:
#   curl -fsSL ${origin}/install-cli | sh
#
# Environment overrides:
#   SLICC_INSTALL_DIR   install directory (default: ~/.local/bin when on
#                       PATH, else /usr/local/bin when writable, else
#                       ~/.local/bin with a PATH hint; ~/bin under Git Bash)
#
# Works on macOS, Linux, WSL, and Git Bash/MSYS. Native Windows PowerShell:
#   irm ${origin}/install-cli.ps1 | iex
set -eu

# WSL reports Linux and gets the linux binary — that is the right answer
# there. Git Bash / MSYS / Cygwin get the windows .exe.
os="$(uname -s)"
bin_name="slicc"
case "$os" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  MINGW* | MSYS* | CYGWIN*)
    os="windows"
    bin_name="slicc.exe"
    ;;
  *)
    echo "install-cli: unsupported OS $os (native Windows: irm ${origin}/install-cli.ps1 | iex)" >&2
    exit 1
    ;;
esac

# OS-idiomatic install dir: prefer the XDG user-binaries dir when the shell
# already resolves it, fall back to a writable /usr/local/bin, else create
# ~/.local/bin and print a PATH hint at the end. Git Bash uses ~/bin, which
# its /etc/profile puts on PATH once it exists.
if [ -n "\${SLICC_INSTALL_DIR:-}" ]; then
  install_dir="$SLICC_INSTALL_DIR"
elif [ "$os" = "windows" ]; then
  install_dir="$HOME/bin"
else
  install_dir="$HOME/.local/bin"
  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *)
      if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
        install_dir=/usr/local/bin
      fi
      ;;
  esac
fi

arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64) arch="amd64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *)
    echo "install-cli: unsupported architecture $arch (need amd64 or arm64)" >&2
    exit 1
    ;;
esac

url="${origin}/download/slicc-cli/$os-$arch"
tmp="$install_dir/.slicc.download.$$"

mkdir -p "$install_dir"
trap 'rm -f "$tmp"' EXIT

echo "Downloading slicc ($os-$arch) from $url ..."
curl -fSL ${protoFlag}-o "$tmp" "$url"
chmod 0755 "$tmp"

# End-to-end sanity check before the binary lands on PATH: the CLI must be
# able to print its version. This also catches a server error page saved as
# the download.
if ! version="$("$tmp" --version 2>/dev/null)"; then
  echo "install-cli: the downloaded file does not run on this system ($url)" >&2
  exit 1
fi

mv "$tmp" "$install_dir/$bin_name"
trap - EXIT

echo "Installed $install_dir/$bin_name ($version)"

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *)
    echo ""
    echo "$install_dir is not on your PATH. Add it with:"
    echo "  export PATH=\\"$install_dir:\\$PATH\\""
    ;;
esac
`;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/x-shellscript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

/**
 * The native-Windows installer (`irm …/install-cli.ps1 | iex`), mirroring the
 * POSIX script: arch detection, download via the resolver route, a --version
 * sanity gate before the binary lands, install to %LOCALAPPDATA%\Programs\slicc
 * (the per-user programs idiom), and a persistent user-scope PATH update.
 */
export function buildInstallCliPowershellResponse(request: Request): Response {
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const body = `# slicc CLI installer — the headless SLICC follower CLI (native Windows).
#
# Usage:
#   irm ${origin}/install-cli.ps1 | iex
#
# Environment overrides:
#   SLICC_INSTALL_DIR   install directory (default: %LOCALAPPDATA%\\Programs\\slicc)
#
# WSL and Git Bash users: curl -fsSL ${origin}/install-cli | sh
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 defaults to TLS 1.0 — force 1.2 for the download.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$arch = 'amd64'
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64) {
  $arch = 'arm64'
}

$installDir = $env:SLICC_INSTALL_DIR
if (-not $installDir) {
  $installDir = Join-Path $env:LOCALAPPDATA 'Programs\\slicc'
}
$null = New-Item -ItemType Directory -Force -Path $installDir

$url = "${origin}/download/slicc-cli/windows-$arch"
$tmp = Join-Path $installDir ".slicc.download.$PID.exe"
$exe = Join-Path $installDir 'slicc.exe'

Write-Host "Downloading slicc (windows-$arch) from $url ..."
try {
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
  # Sanity gate before the binary lands on PATH: it must print its version.
  $version = & $tmp --version
  if ($LASTEXITCODE -ne 0) {
    throw "the downloaded file does not run on this system ($url)"
  }
  Move-Item -Force $tmp $exe
} catch {
  Remove-Item -Force -ErrorAction SilentlyContinue $tmp
  throw
}

Write-Host "Installed $exe ($version)"

# Persist the install dir on the user PATH (new terminals pick it up).
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $installDir) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$installDir", 'User')
  $env:Path = "$env:Path;$installDir"
  Write-Host "Added $installDir to your user PATH."
}
`;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/x-powershell; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
