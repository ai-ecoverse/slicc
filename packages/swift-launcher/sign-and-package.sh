#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR/build/Sliccstart.app"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENTITLEMENTS="$SCRIPT_DIR/Sliccstart.entitlements"


VERSION="$(node -p "require('$PROJECT_ROOT/package.json').version")"

echo "=== Sliccstart sign-and-package v${VERSION} ==="


echo "Patching Info.plist with version ${VERSION}..."
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP_DIR/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$VERSION" "$APP_DIR/Contents/Info.plist"


if [ -n "${APPLE_TEAM_ID:-}" ]; then
  IDENTITY="Developer ID Application: Lars Trieloff ($APPLE_TEAM_ID)"

  echo "Code signing Sliccstart.app with $IDENTITY..."




  codesign --force --options runtime --sign "$IDENTITY" --timestamp \
    "$APP_DIR/Contents/Resources/WebRTC.framework"
  codesign --force --options runtime --sign "$IDENTITY" --timestamp \
    "$APP_DIR/Contents/Resources/slicc-server"
  if [ -d "$APP_DIR/Contents/PlugIns/SliccFileProvider.appex" ]; then
    APPEX="$APP_DIR/Contents/PlugIns/SliccFileProvider.appex"
    APPEX_WEBRTC="$APPEX/Contents/Frameworks/WebRTC.framework"
    if [ -d "$APPEX_WEBRTC" ]; then



      codesign --force --options runtime --sign "$IDENTITY" --timestamp \
        "$APPEX_WEBRTC"
    fi




    codesign --force --options runtime --entitlements "$SCRIPT_DIR/SliccFileProvider.entitlements" \
      --sign "$IDENTITY" --timestamp \
      "$APPEX"
  fi


  if [ -d "$APP_DIR/Contents/PlugIns/SliccstartWidgets.appex" ]; then
    codesign --force --options runtime \
      --entitlements "$SCRIPT_DIR/SliccstartWidgets.entitlements" \
      --sign "$IDENTITY" --timestamp \
      "$APP_DIR/Contents/PlugIns/SliccstartWidgets.appex"
  fi















  if [ -n "${PROVISION_PROFILE:-}" ]; then
    if [ ! -f "$PROVISION_PROFILE" ]; then
      echo "ERROR: PROVISION_PROFILE set but file not found: $PROVISION_PROFILE" >&2
      exit 1
    fi
    echo "Embedding provisioning profile for iCloud sync..."
    cp "$PROVISION_PROFILE" "$APP_DIR/Contents/embedded.provisionprofile"





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


  codesign --verify --verbose "$APP_DIR"


  echo "Creating ZIP for notarization..."
  ditto -c -k --keepParent "$APP_DIR" "$SCRIPT_DIR/build/Sliccstart-notarize.zip"

  echo "Submitting app for notarization..."
  xcrun notarytool submit "$SCRIPT_DIR/build/Sliccstart-notarize.zip" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --wait


  echo "Stapling notarization ticket to app..."
  xcrun stapler staple "$APP_DIR"

  rm -f "$SCRIPT_DIR/build/Sliccstart-notarize.zip"
else
  echo "No APPLE_TEAM_ID set, using ad-hoc signing..."
  codesign --force --sign - "$APP_DIR/Contents/Resources/WebRTC.framework"
  codesign --force --sign - "$APP_DIR/Contents/Resources/slicc-server"
  if [ -d "$APP_DIR/Contents/PlugIns/SliccFileProvider.appex" ]; then
    APPEX="$APP_DIR/Contents/PlugIns/SliccFileProvider.appex"
    APPEX_WEBRTC="$APPEX/Contents/Frameworks/WebRTC.framework"
    if [ -d "$APPEX_WEBRTC" ]; then
      codesign --force --sign - "$APPEX_WEBRTC"
    fi
    codesign --force --entitlements "$SCRIPT_DIR/SliccFileProvider.entitlements" --sign - \
      "$APPEX"
  fi
  if [ -d "$APP_DIR/Contents/PlugIns/SliccstartWidgets.appex" ]; then
    codesign --force --entitlements "$SCRIPT_DIR/SliccstartWidgets.entitlements" --sign - \
      "$APP_DIR/Contents/PlugIns/SliccstartWidgets.appex"
  fi
  codesign --force --entitlements "$ENTITLEMENTS" --sign - "$APP_DIR"
fi


echo "Creating DMG..."
mkdir -p "$SCRIPT_DIR/build/dmg"
cp -R "$APP_DIR" "$SCRIPT_DIR/build/dmg/"
ln -sf /Applications "$SCRIPT_DIR/build/dmg/Applications"
hdiutil create -volname Sliccstart -srcfolder "$SCRIPT_DIR/build/dmg" -ov -format UDZO "$SCRIPT_DIR/build/Sliccstart.dmg"
rm -rf "$SCRIPT_DIR/build/dmg"


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


echo "Copying artifacts..."
mkdir -p "$PROJECT_ROOT/artifacts/release"
cp "$SCRIPT_DIR/build/Sliccstart.dmg" "$PROJECT_ROOT/artifacts/release/sliccstart-v${VERSION}.dmg"


ditto -c -k --keepParent "$APP_DIR" "$PROJECT_ROOT/artifacts/release/Sliccstart-${VERSION}.zip"

echo "=== Done ==="