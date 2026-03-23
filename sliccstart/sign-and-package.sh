#!/bin/bash
set -euo pipefail

VERSION="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR/build/Sliccstart.app"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

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
    --entitlements "$SCRIPT_DIR/node-entitlements.plist" \
    "$APP_DIR/Contents/Resources/node/bin/node"
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
  codesign --force --sign - "$APP_DIR/Contents/Resources/node/bin/node"
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
cp "$SCRIPT_DIR/build/Sliccstart.dmg" "$PROJECT_ROOT/artifacts/release/sliccstart-v${VERSION}.dmg"

# 8. Create update ZIP (for AppUpdater)
ditto -c -k --keepParent "$APP_DIR" "$PROJECT_ROOT/artifacts/release/Sliccstart-${VERSION}.zip"

echo "=== Done ==="