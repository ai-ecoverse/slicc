#!/usr/bin/env bash















set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"








if [ -n "${SLICC_RELEASE_VERSION:-}" ]; then
  VERSION="v${SLICC_RELEASE_VERSION#v}"
elif pkgver="$(node -p "require('./package.json').version" 2>/dev/null)" && [ -n "$pkgver" ]; then
  VERSION="v${pkgver#v}"
else
  VERSION="$(git describe --tags --always --dirty 2>/dev/null || echo dev)"
fi

DIST="packages/slicc-cli/dist"
echo "[slicc-cli] cross-compiling all targets (version $VERSION)"
make -C packages/slicc-cli dist VERSION="$VERSION"

if [ -n "${KEYCHAIN_PATH:-}" ]; then
  identity="$(security find-identity -v -p codesigning "$KEYCHAIN_PATH" | grep 'Developer ID Application' | head -1 | awk '{print $2}')"
  if [ -z "$identity" ]; then
    echo "::error::[slicc-cli] no Developer ID Application identity in $KEYCHAIN_PATH"
    exit 1
  fi
  for bin in slicc-darwin-arm64 slicc-darwin-amd64; do
    echo "[slicc-cli] signing $bin"
    codesign --force --timestamp --options runtime \
      --keychain "$KEYCHAIN_PATH" -s "$identity" "$DIST/$bin"
    codesign --verify --strict --verbose=2 "$DIST/$bin"
  done

  if [ -n "${APPLE_API_KEY_P8_BASE64:-}" ]; then
    key_p8="$(mktemp "${RUNNER_TEMP:-/tmp}/asc_key.XXXXXX")"
    trap 'rm -f "$key_p8"' EXIT
    printf '%s' "$APPLE_API_KEY_P8_BASE64" | base64 --decode > "$key_p8"

    ( cd "$DIST" && zip -q notarize.zip slicc-darwin-arm64 slicc-darwin-amd64 )
    echo "[slicc-cli] submitting darwin binaries to notarytool"
    xcrun notarytool submit "$DIST/notarize.zip" \
      --key "$key_p8" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_KEY_ISSUER_ID" \
      --wait
    rm -f "$DIST/notarize.zip"
  else
    echo "::warning::[slicc-cli] notarytool creds absent — darwin binaries signed but not notarized"
  fi
else
  echo "::warning::[slicc-cli] no signing keychain (\$KEYCHAIN_PATH) — shipping unsigned binaries"
fi

mkdir -p artifacts/release
cp "$DIST"/slicc-* artifacts/release/
echo "[slicc-cli] staged $(find artifacts/release -name 'slicc-*' | wc -l | tr -d ' ') binaries into artifacts/release/"
