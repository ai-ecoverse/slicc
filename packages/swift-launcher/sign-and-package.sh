#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR/build/Sliccstart.app"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Single source of truth: root package.json (kept in sync by @semantic-release/git).
VERSION="$(node -p "require('$PROJECT_ROOT/package.json').version")"

echo "=== Sliccstart sign-and-package v${VERSION} ==="

# 1. Patch Info.plist with release version
echo "Patching Info.plist with version ${VERSION}..."
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP_DIR/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$VERSION" "$APP_DIR/Contents/Info.plist"

# 2. Code sign (if Apple credentials available)
if [ -n "${APPLE_TEAM_ID:-}" ]; then
  IDENTITY="Developer ID Application: Lars Trieloff ($APPLE_TEAM_ID)"

  echo "Code signing Sliccstart.app with $IDENTITY..."
  # Sign nested executables first, then the outer app
  codesign --force --options runtime --sign "$IDENTITY" --timestamp \
    "$APP_DIR/Contents/Resources/slicc-server"
  codesign --force --options runtime --sign "$IDENTITY" --timestamp "$APP_DIR"

  # Verify signature
  codesign --verify --verbose "$APP_DIR"

  # 3. Notarize the app
  echo "Creating ZIP for notarization..."
  ditto -c -k --keepParent "$APP_DIR" "$SCRIPT_DIR/build/Sliccstart-notarize.zip"

  echo "Submitting app for notarization..."
  xcrun notarytool submit "$SCRIPT_DIR/build/Sliccstart-notarize.zip" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --wait

  # 4. Staple notarization ticket
  echo "Stapling notarization ticket to app..."
  xcrun stapler staple "$APP_DIR"

  rm -f "$SCRIPT_DIR/build/Sliccstart-notarize.zip"
else
  echo "No APPLE_TEAM_ID set, using ad-hoc signing..."
  codesign --force --sign - "$APP_DIR/Contents/Resources/slicc-server"
  codesign --force --sign - "$APP_DIR"
fi

# 5. Create DMG
echo "Creating DMG..."
mkdir -p "$SCRIPT_DIR/build/dmg"
cp -R "$APP_DIR" "$SCRIPT_DIR/build/dmg/"
ln -sf /Applications "$SCRIPT_DIR/build/dmg/Applications"
hdiutil create -volname Sliccstart -srcfolder "$SCRIPT_DIR/build/dmg" -ov -format UDZO "$SCRIPT_DIR/build/Sliccstart.dmg"
rm -rf "$SCRIPT_DIR/build/dmg"

# 6. Sign and notarize DMG
if [ -n "${APPLE_TEAM_ID:-}" ]; then
  echo "Signing DMG..."
  codesign --force --sign "$IDENTITY" --timestamp "$SCRIPT_DIR/build/Sliccstart.dmg"

  echo "Submitting DMG for notarization..."
  xcrun notarytool submit "$SCRIPT_DIR/build/Sliccstart.dmg" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --wait

  echo "Stapling notarization ticket to DMG..."
  xcrun stapler staple "$SCRIPT_DIR/build/Sliccstart.dmg"
fi

# 7. Copy artifacts
echo "Copying artifacts..."
mkdir -p "$PROJECT_ROOT/artifacts/release"
cp "$SCRIPT_DIR/build/Sliccstart.dmg" "$PROJECT_ROOT/artifacts/release/sliccstart-v${VERSION}.dmg"

# 8. Create update ZIP (for AppUpdater)
ditto -c -k --keepParent "$APP_DIR" "$PROJECT_ROOT/artifacts/release/Sliccstart-${VERSION}.zip"

# 9. Webapp-only ZIP and manifest (smooth-upgrade path)
#
# These let Sliccstart skip the full app swap for releases that only changed
# `dist/ui`. The launcher hashes the running Sliccstart/slicc-server binaries
# against this manifest and applies a tiny `webapp-<version>.zip` overlay
# without restarting if they match.
WEBAPP_DIR="$APP_DIR/Contents/Resources/slicc/dist/ui"
WEBAPP_ZIP="$PROJECT_ROOT/artifacts/release/webapp-${VERSION}.zip"
MANIFEST="$PROJECT_ROOT/artifacts/release/manifest-${VERSION}.json"

echo "Creating webapp-only zip..."
# No `--keepParent` — WebappOverlayStore.install() expects index.html at the
# root of the extracted overlay, not nested under a `ui/` directory.
( cd "$WEBAPP_DIR" && ditto -c -k . "$WEBAPP_ZIP" )

echo "Writing manifest..."
SLICCSTART_HASH="$(shasum -a 256 "$APP_DIR/Contents/MacOS/Sliccstart" | awk '{print $1}')"
SERVER_HASH="$(shasum -a 256 "$APP_DIR/Contents/Resources/slicc-server" | awk '{print $1}')"

# Deterministic webapp hash: sort relative paths, hash "<path>:<sha256>" lines.
# Mirrors `sha256Directory` in `Sliccstart/Models/UpdateManifest.swift` so
# the value in the published manifest matches what Sliccstart computes
# from the running app bundle. The Swift side uses `.skipsHiddenFiles`, so
# we must drop every dotfile/dotdir here too — otherwise hashes diverge
# the first time a `.well-known/` or similar slips into `dist/ui`.
WEBAPP_HASH="$(
  cd "$WEBAPP_DIR" && \
  find . -type f -not -path '*/.*' \
    | sed 's|^\./||' \
    | sort \
    | while read -r f; do
        printf '%s:%s\n' "$f" "$(shasum -a 256 "$f" | awk '{print $1}')"
      done \
    | shasum -a 256 \
    | awk '{print $1}'
)"

cat > "$MANIFEST" <<JSON
{
  "version": "${VERSION}",
  "sliccstart": "${SLICCSTART_HASH}",
  "sliccServer": "${SERVER_HASH}",
  "webapp": "${WEBAPP_HASH}",
  "webappAsset": "webapp-${VERSION}.zip"
}
JSON

echo "=== Done ==="