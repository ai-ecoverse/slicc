#!/bin/bash
# Archive SliccFollower.xcodeproj, export an App Store-signed .ipa,
# and upload it to TestFlight via altool.
#
# Designed to run from semantic-release's prepareCmd inside the Release
# GitHub Actions workflow, but also works locally if you already have
# the Apple Distribution cert + provisioning profile + API key on disk.
#
# Version stamping mirrors the macOS sign-and-package.sh approach: read
# CFBundleShortVersionString from the root package.json (semantic-release
# updates it). CFBundleVersion is the GITHUB_RUN_NUMBER (CI) or the git
# commit count (local fallback) so every upload gets a unique, monotonic
# build number within the same MARKETING_VERSION.
#
# Secrets / env (all optional locally; required on CI):
#   APPLE_API_KEY_ID                   App Store Connect API key id
#   APPLE_API_KEY_ISSUER_ID            App Store Connect API issuer id
#   APPLE_API_KEY_P8_BASE64            base64 of AuthKey_*.p8
#   APPLE_DISTRIBUTION_CERT_BASE64     base64 of Apple Distribution .p12
#   APPLE_DISTRIBUTION_CERT_PASSWORD   password for the .p12
#   APPLE_PROVISIONING_PROFILE_BASE64  base64 of the App Store .mobileprovision
#   APPLE_TEAM_ID                      defaults to S8LB56P782
#   KEYCHAIN_PATH                      reuse a keychain set up by an
#                                       earlier workflow step; if unset
#                                       and APPLE_DISTRIBUTION_CERT_BASE64
#                                       is provided, a temp keychain is
#                                       created and torn down on exit
#   SLICC_SKIP_TESTFLIGHT=1            no-op; useful when the secrets
#                                       aren't available
set -euo pipefail

if [ "${SLICC_SKIP_TESTFLIGHT:-}" = "1" ]; then
  echo "SLICC_SKIP_TESTFLIGHT=1 — skipping TestFlight upload"
  exit 0
fi

# Soft-skip when the TestFlight secrets aren't usable. semantic-release's
# prepareCmd treats any non-zero exit as a release failure, which would
# block the macOS DMG / Chrome / Worker publish too. Exiting 0 here lets
# the rest of the pipeline ship and we can re-set the iOS secrets out of
# band without rolling back a release.
if [ -z "${APPLE_DISTRIBUTION_CERT_BASE64:-}" ] || [ "${APPLE_DISTRIBUTION_CERT_BASE64:-}" = "-" ] \
   || [ -z "${APPLE_API_KEY_P8_BASE64:-}" ] || [ "${APPLE_API_KEY_P8_BASE64:-}" = "-" ] \
   || [ -z "${APPLE_PROVISIONING_PROFILE_BASE64:-}" ] || [ "${APPLE_PROVISIONING_PROFILE_BASE64:-}" = "-" ]; then
  if [ -n "${GITHUB_RUN_NUMBER:-}" ]; then
    echo "::warning::TestFlight secrets are missing or empty — skipping iOS upload."
  else
    echo "TestFlight secrets are missing or empty — skipping iOS upload."
  fi
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IOS_PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$IOS_PROJECT_DIR/../.." && pwd)"

VERSION="$(node -p "require('$PROJECT_ROOT/package.json').version")"
BUILD_NUMBER="${GITHUB_RUN_NUMBER:-$(git -C "$PROJECT_ROOT" rev-list --count HEAD)}"
TEAM_ID="${APPLE_TEAM_ID:-S8LB56P782}"
BUNDLE_ID="${APPLE_BUNDLE_ID:-com.sliccy.follower}"
PROFILE_NAME="${APPLE_PROVISIONING_PROFILE_NAME:-Slicc Follower App Store}"

echo "=== SliccFollower TestFlight v${VERSION} (build ${BUILD_NUMBER}) ==="

ARCHIVE="$IOS_PROJECT_DIR/.build/SliccFollower.xcarchive"
EXPORT_DIR="$IOS_PROJECT_DIR/.build/export"
EXPORT_OPTS="$IOS_PROJECT_DIR/.build/ExportOptions-AppStore.generated.plist"
rm -rf "$ARCHIVE" "$EXPORT_DIR" "$EXPORT_OPTS"
mkdir -p "$IOS_PROJECT_DIR/.build"

CLEANUP=()
trap 'for f in "${CLEANUP[@]:-}"; do rm -rf "$f" 2>/dev/null || true; done; if [ "${OWN_KEYCHAIN:-0}" = "1" ] && [ -n "${KEYCHAIN_PATH:-}" ]; then security delete-keychain "$KEYCHAIN_PATH" || true; fi' EXIT

# --- Cert: import the Apple Distribution .p12 into a keychain --------------
if [ -n "${APPLE_DISTRIBUTION_CERT_BASE64:-}" ]; then
  if [ -z "${APPLE_DISTRIBUTION_CERT_PASSWORD:-}" ]; then
    echo "error: APPLE_DISTRIBUTION_CERT_PASSWORD must accompany APPLE_DISTRIBUTION_CERT_BASE64" >&2
    exit 1
  fi
  P12_TMP="$(mktemp -t apple-dist).p12"
  CLEANUP+=("$P12_TMP")
  printf '%s' "$APPLE_DISTRIBUTION_CERT_BASE64" | base64 --decode > "$P12_TMP"

  if [ -z "${KEYCHAIN_PATH:-}" ]; then
    KEYCHAIN_PATH="${RUNNER_TEMP:-/tmp}/ios-signing-$$.keychain-db"
    KEYCHAIN_PASSWORD="$(openssl rand -base64 32)"
    security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
    security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
    security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
    security list-keychain -d user -s "$KEYCHAIN_PATH"
    OWN_KEYCHAIN=1
    echo "  created temp keychain: $KEYCHAIN_PATH"
  else
    echo "  reusing keychain: $KEYCHAIN_PATH"
  fi

  security import "$P12_TMP" \
    -P "$APPLE_DISTRIBUTION_CERT_PASSWORD" \
    -A -t cert -f pkcs12 \
    -k "$KEYCHAIN_PATH"
  if [ "${OWN_KEYCHAIN:-0}" = "1" ]; then
    security set-key-partition-list \
      -S apple-tool:,apple:,codesign: \
      -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH" >/dev/null
  fi
  echo "  imported Apple Distribution cert"
fi

# --- Profile: install into ~/Library/MobileDevice/Provisioning Profiles ----
if [ -n "${APPLE_PROVISIONING_PROFILE_BASE64:-}" ]; then
  PROFILE_DIR="$HOME/Library/MobileDevice/Provisioning Profiles"
  mkdir -p "$PROFILE_DIR"
  PROFILE_TMP="$(mktemp -t slicc-profile).mobileprovision"
  CLEANUP+=("$PROFILE_TMP")
  printf '%s' "$APPLE_PROVISIONING_PROFILE_BASE64" | base64 --decode > "$PROFILE_TMP"
  PROFILE_UUID="$(security cms -D -i "$PROFILE_TMP" 2>/dev/null \
    | plutil -extract UUID raw -o - -)"
  cp "$PROFILE_TMP" "$PROFILE_DIR/${PROFILE_UUID}.mobileprovision"
  echo "  installed provisioning profile $PROFILE_UUID"
fi

# --- API key: locate the .p8 so altool / xcodebuild can find it -----------
if [ -z "${APPLE_API_KEY_ID:-}" ] || [ -z "${APPLE_API_KEY_ISSUER_ID:-}" ]; then
  echo "error: APPLE_API_KEY_ID and APPLE_API_KEY_ISSUER_ID must be set" >&2
  exit 1
fi
if [ -n "${APPLE_API_KEY_P8_BASE64:-}" ]; then
  # Write to a private temp dir so we never clobber a developer's local
  # ~/.appstoreconnect/private_keys/ key. xcodebuild + altool both accept
  # an explicit path so the standard location isn't required.
  P8_TMPDIR="$(mktemp -d -t slicc-p8)"
  CLEANUP+=("$P8_TMPDIR")
  P8_PATH="$P8_TMPDIR/AuthKey_${APPLE_API_KEY_ID}.p8"
  printf '%s' "$APPLE_API_KEY_P8_BASE64" | base64 --decode > "$P8_PATH"
  echo "  wrote API key: $P8_PATH"
else
  P8_PATH="${APPLE_API_KEY_P8_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${APPLE_API_KEY_ID}.p8}"
  if [ ! -f "$P8_PATH" ]; then
    echo "error: API key not found at $P8_PATH (set APPLE_API_KEY_P8_BASE64 or APPLE_API_KEY_P8_PATH)" >&2
    exit 1
  fi
  echo "  using API key: $P8_PATH"
fi

# --- ExportOptions.plist (manual signing — sidesteps cloud-managed certs) ---
cat > "$EXPORT_OPTS" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>signingStyle</key>
    <string>manual</string>
    <key>teamID</key>
    <string>${TEAM_ID}</string>
    <key>signingCertificate</key>
    <string>Apple Distribution</string>
    <key>provisioningProfiles</key>
    <dict>
        <key>${BUNDLE_ID}</key>
        <string>${PROFILE_NAME}</string>
    </dict>
    <key>uploadSymbols</key>
    <true/>
    <key>stripSwiftSymbols</key>
    <true/>
</dict>
</plist>
EOF

# --- Archive ---------------------------------------------------------------
echo "  archiving..."
xcodebuild \
  -project "$IOS_PROJECT_DIR/SliccFollower.xcodeproj" \
  -scheme SliccFollower \
  -destination 'generic/platform=iOS' \
  -configuration Release \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  -authenticationKeyID "$APPLE_API_KEY_ID" \
  -authenticationKeyIssuerID "$APPLE_API_KEY_ISSUER_ID" \
  -authenticationKeyPath "$P8_PATH" \
  MARKETING_VERSION="$VERSION" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  archive >/tmp/slicc-archive.log 2>&1 \
  || { tail -50 /tmp/slicc-archive.log; exit 1; }
echo "  archive ok"

# --- Export ---------------------------------------------------------------
echo "  exporting..."
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_OPTS" \
  -allowProvisioningUpdates \
  -authenticationKeyID "$APPLE_API_KEY_ID" \
  -authenticationKeyIssuerID "$APPLE_API_KEY_ISSUER_ID" \
  -authenticationKeyPath "$P8_PATH" \
  >/tmp/slicc-export.log 2>&1 \
  || { tail -50 /tmp/slicc-export.log; exit 1; }
IPA="$EXPORT_DIR/SliccFollower.ipa"
[ -f "$IPA" ] || { echo "error: $IPA missing after export" >&2; exit 1; }
echo "  export ok ($(du -h "$IPA" | cut -f1))"

# --- Upload to TestFlight -------------------------------------------------
echo "  uploading to TestFlight..."
xcrun altool --upload-app \
  -f "$IPA" \
  --type ios \
  --apiKey "$APPLE_API_KEY_ID" \
  --apiIssuer "$APPLE_API_KEY_ISSUER_ID" \
  || { echo "error: altool upload failed" >&2; exit 1; }
echo "=== SliccFollower v${VERSION} (build ${BUILD_NUMBER}) uploaded ==="
