#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR/build/Sliccstart.app"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENTITLEMENTS="$SCRIPT_DIR/Sliccstart.entitlements"

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
  # Sign nested code innermost-first, then the outer app. WebRTC.framework
  # (bundled next to slicc-server so dyld can resolve @rpath/WebRTC.framework)
  # ships pre-signed by Google; re-sign it with our Developer ID + hardened
  # runtime so notarization accepts the embedded framework.
  codesign --force --options runtime --sign "$IDENTITY" --timestamp \
    "$APP_DIR/Contents/Resources/WebRTC.framework"
  codesign --force --options runtime --sign "$IDENTITY" --timestamp \
    "$APP_DIR/Contents/Resources/slicc-server"

  # iCloud key-value sync (cross-device tray sessions) needs an embedded
  # Developer ID provisioning profile that authorizes the ubiquity-kvstore
  # entitlement. When PROVISION_PROFILE points at that profile we embed it and
  # sign against a merged entitlements file (base + iCloud KVS). Without it we
  # sign against the base entitlements only, and the app degrades to a local
  # key-value cache (no sync) — so CI stays green until the profile secret
  # exists.
  #
  # In CI, the release workflow (.github/workflows/release.yml, "Import Apple
  # certificates" step) decodes the macOS-specific
  # APPLE_MACOS_PROVISIONING_PROFILE_BASE64 secret to a file and exports
  # PROVISION_PROFILE + KVSTORE_IDENTIFIER for this script, so published macOS
  # builds ship the iCloud KVS entitlement. (That is a distinct secret from the
  # iOS App Store APPLE_PROVISIONING_PROFILE_BASE64 used by TestFlight.)
  if [ -n "${PROVISION_PROFILE:-}" ]; then
    if [ ! -f "$PROVISION_PROFILE" ]; then
      echo "ERROR: PROVISION_PROFILE set but file not found: $PROVISION_PROFILE" >&2
      exit 1
    fi
    echo "Embedding provisioning profile for iCloud sync..."
    cp "$PROVISION_PROFILE" "$APP_DIR/Contents/embedded.provisionprofile"
    # The key-value sync bucket namespace. Defaults to the team-prefixed
    # bundle id (what the auto-generated profile pins). Override with
    # KVSTORE_IDENTIFIER to use a brand-neutral, cross-app value the iOS
    # follower can share (e.g. S8LB56P782.ai.sliccy.trays) — the outer
    # codesign will fail fast if the embedded profile does not authorize it.
    KVSTORE_IDENTIFIER="${KVSTORE_IDENTIFIER:-${APPLE_TEAM_ID}.com.slicc.sliccstart}"
    MERGED_ENTITLEMENTS="$SCRIPT_DIR/build/Sliccstart.icloud.entitlements"
    cp "$ENTITLEMENTS" "$MERGED_ENTITLEMENTS"
    /usr/libexec/PlistBuddy -c \
      "Add :com.apple.developer.ubiquity-kvstore-identifier string ${KVSTORE_IDENTIFIER}" \
      "$MERGED_ENTITLEMENTS" 2>/dev/null \
      || /usr/libexec/PlistBuddy -c \
        "Set :com.apple.developer.ubiquity-kvstore-identifier ${KVSTORE_IDENTIFIER}" \
        "$MERGED_ENTITLEMENTS"
    ENTITLEMENTS="$MERGED_ENTITLEMENTS"
  else
    echo "No provisioning profile — signing base entitlements only (tray sessions stay local, no cross-device sync)."
  fi

  codesign --force --options runtime --entitlements "$ENTITLEMENTS" \
    --sign "$IDENTITY" --timestamp "$APP_DIR"

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
  codesign --force --sign - "$APP_DIR/Contents/Resources/WebRTC.framework"
  codesign --force --sign - "$APP_DIR/Contents/Resources/slicc-server"
  codesign --force --entitlements "$ENTITLEMENTS" --sign - "$APP_DIR"
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

echo "=== Done ==="