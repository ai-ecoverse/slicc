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
#   APPLE_PROVISIONING_PROFILE_BASE64  base64 of the main App Store .mobileprovision
#   APPLE_PROVISIONING_PROFILE_NAME    defaults to "Slicc Follower App Store"
#   APPLE_FILEPROVIDER_PROVISIONING_PROFILE_BASE64
#                                      base64 of the File Provider appex App Store profile
#                                      (required — missing/"-" soft-skips the whole upload)
#   APPLE_FILEPROVIDER_PROVISIONING_PROFILE_NAME
#                                      defaults to "Slicc Follower File Provider App Store"
#   APPLE_FILEPROVIDER_BUNDLE_ID       defaults to com.sliccy.follower.fileprovider
#   APPLE_WIDGETS_PROVISIONING_PROFILE_BASE64
#                                      base64 of the widget extension's App
#                                      Store .mobileprovision (its App ID needs
#                                      the App Groups capability)
#   APPLE_WIDGETS_PROVISIONING_PROFILE_NAME
#                                      defaults to "Slicc Follower Widgets App Store"
#   APPLE_WIDGETS_BUNDLE_ID            defaults to com.sliccy.follower.widgets
#   APPLE_SHARE_PROVISIONING_PROFILE_BASE64
#                                      Share extension appex App Store profile
#   APPLE_SHARE_PROVISIONING_PROFILE_NAME
#                                      defaults to "Slicc Follower Share App Store"
#   APPLE_SHARE_BUNDLE_ID              defaults to com.sliccy.follower.share
#   APPLE_TEAM_ID                      defaults to S8LB56P782
#
# Release wiring: .github/workflows/release.yml must pass every APPLE_* secret
# above into the Publish release step env. Repo secrets alone are not enough —
# an unset workflow env makes the File Provider check soft-skip TestFlight.
#   KEYCHAIN_PATH                      reuse a keychain set up by an
#                                       earlier workflow step; if unset
#                                       and APPLE_DISTRIBUTION_CERT_BASE64
#                                       is provided, a temp keychain is
#                                       created and torn down on exit
#   SLICC_SKIP_TESTFLIGHT=1            no-op; useful when the secrets
#                                       aren't available
#   SLICC_IOS_NO_ICLOUD=1              archive WITHOUT the iCloud KVS
#                                       entitlement (mirrors the macOS
#                                       PROVISION_PROFILE gate): use when the
#                                       App Store profile does not yet carry
#                                       the iCloud capability, so the release
#                                       ships without session sync instead of
#                                       failing codesign
set -euo pipefail

# iCloud KVS entitlement gate — see SLICC_IOS_NO_ICLOUD above. An empty
# CODE_SIGN_ENTITLEMENTS override drops the project.yml entitlements file.
#
# KNOWN LIMIT (2026-08-02): this is NOT sufficient when the App ID itself
# carries the iCloud capability in the developer portal — Xcode 26's
# preflight then rejects a profile without iCloud for this bundle id
# regardless of local entitlements ("doesn't include the iCloud
# capability"). The fix is portal-side: regenerate the "Slicc Follower
# App Store" profile with iCloud, or strip the capability from the App
# ID. Until then the archive fails, which is why release-native runs this
# script as a NON-GATING step.
ENTITLEMENTS_OVERRIDE=()
if [ "${SLICC_IOS_NO_ICLOUD:-}" = "1" ]; then
  echo "SLICC_IOS_NO_ICLOUD=1 — archiving without the iCloud KVS entitlement"
  ENTITLEMENTS_OVERRIDE=(CODE_SIGN_ENTITLEMENTS=)
fi

if [ "${SLICC_SKIP_TESTFLIGHT:-}" = "1" ]; then
  echo "SLICC_SKIP_TESTFLIGHT=1 — skipping TestFlight upload"
  exit 0
fi

# Soft-skip when the TestFlight secrets aren't usable. semantic-release's
# prepareCmd treats any non-zero exit as a release failure, which would
# block the macOS DMG / Chrome / Worker publish too. Exiting 0 here lets
# the rest of the pipeline ship and we can re-set the iOS secrets out of
# band without rolling back a release.
#
# Cover ALL six TestFlight secrets, not just the base64 ones. The
# original `gh secret set --body -` bug corrupted plain-text fields too
# (APPLE_DISTRIBUTION_CERT_PASSWORD / APPLE_API_KEY_ID /
# APPLE_API_KEY_ISSUER_ID), and if any of those are still set to "-"
# while the base64 values are real, the script would otherwise abort
# later in `security import` / `xcodebuild` instead of skipping cleanly.
# Addressed Copilot review comment on PR #573.
secret_unusable() {
  local v="${!1:-}"
  [ -z "$v" ] || [ "$v" = "-" ]
}
for var in APPLE_DISTRIBUTION_CERT_BASE64 APPLE_DISTRIBUTION_CERT_PASSWORD \
           APPLE_API_KEY_P8_BASE64 APPLE_API_KEY_ID APPLE_API_KEY_ISSUER_ID \
           APPLE_PROVISIONING_PROFILE_BASE64 \
           APPLE_FILEPROVIDER_PROVISIONING_PROFILE_BASE64 \
           APPLE_SHARE_PROVISIONING_PROFILE_BASE64 \
           APPLE_WIDGETS_PROVISIONING_PROFILE_BASE64; do
  if secret_unusable "$var"; then
    msg="TestFlight secret \$$var is missing or set to \"-\" — skipping iOS upload."
    if [ -n "${GITHUB_RUN_NUMBER:-}" ]; then
      echo "::warning::$msg"
    else
      echo "$msg"
    fi
    exit 0
  fi
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IOS_PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$IOS_PROJECT_DIR/../.." && pwd)"

VERSION="$(node -p "require('$PROJECT_ROOT/package.json').version")"
BUILD_NUMBER="${GITHUB_RUN_NUMBER:-$(git -C "$PROJECT_ROOT" rev-list --count HEAD)}"
TEAM_ID="${APPLE_TEAM_ID:-S8LB56P782}"
BUNDLE_ID="${APPLE_BUNDLE_ID:-com.sliccy.follower}"
PROFILE_NAME="${APPLE_PROVISIONING_PROFILE_NAME:-Slicc Follower App Store}"
FILEPROVIDER_BUNDLE_ID="${APPLE_FILEPROVIDER_BUNDLE_ID:-com.sliccy.follower.fileprovider}"
FILEPROVIDER_PROFILE_NAME="${APPLE_FILEPROVIDER_PROVISIONING_PROFILE_NAME:-Slicc Follower File Provider App Store}"
SHARE_BUNDLE_ID="${APPLE_SHARE_BUNDLE_ID:-com.sliccy.follower.share}"
SHARE_PROFILE_NAME="${APPLE_SHARE_PROVISIONING_PROFILE_NAME:-Slicc Follower Share App Store}"
WIDGETS_BUNDLE_ID="${APPLE_WIDGETS_BUNDLE_ID:-com.sliccy.follower.widgets}"
WIDGETS_PROFILE_NAME="${APPLE_WIDGETS_PROVISIONING_PROFILE_NAME:-Slicc Follower Widgets App Store}"

echo "=== SliccFollower TestFlight v${VERSION} (build ${BUILD_NUMBER}) ==="

# Apple requires App Store submissions to be built with Xcode 26+
# (iOS 26 SDK). On the macos-26 runner the default Xcode is 26.2 with
# the iOS 26.2 device platform fully provisioned. Older Xcode 26.x
# apps under /Applications also exist but only the *default* one has
# its iOS device platform fully installed — picking, say, Xcode 26.0.1
# explicitly causes `xcodebuild archive` to fail with
# "iOS 26.0 is not installed. Please download and install the
# platform from Xcode > Settings > Components." Use the runner's
# default Xcode (no DEVELOPER_DIR override) and just verify it's
# Xcode 26+.
#
# Avoid `xcodebuild -version | head -1`: under `set -o pipefail`,
# xcodebuild prints two lines and SIGPIPEs when head closes early,
# bubbling exit code 141 up out of the script.
XCODE_VERSION_RAW="$(xcodebuild -version 2>/dev/null || true)"
XCODE_VERSION="${XCODE_VERSION_RAW%%$'\n'*}"
XCODE_MAJOR="$(echo "$XCODE_VERSION" | sed -E 's/^Xcode[[:space:]]+([0-9]+).*/\1/')"
if [ -z "$XCODE_MAJOR" ] || ! [ "$XCODE_MAJOR" -ge 26 ] 2>/dev/null; then
  msg="Default Xcode is '${XCODE_VERSION:-unknown}' (< 26). App Store now rejects pre-Xcode-26 builds. Skipping iOS upload."
  if [ -n "${GITHUB_RUN_NUMBER:-}" ]; then
    echo "::warning::$msg"
  else
    echo "warn: $msg"
  fi
  exit 0
fi
echo "  using $XCODE_VERSION (default Xcode)"

# The Xcode project is XcodeGen output and is not committed, so generate it
# before archiving. This is the one iOS build path that did not already
# regenerate (every workflow under .github/workflows does), and it goes on to
# patch the produced pbxproj for codesigning — so it must archive a project
# that matches project.yml, not whatever a local checkout had lying around.
# Placed after every soft-skip gate above: a run that is going to skip the
# upload must not hard-fail here for a missing tool it never needed.
if ! command -v xcodegen >/dev/null 2>&1; then
  echo "package-and-upload-testflight: xcodegen not found (brew install xcodegen)" >&2
  exit 1
fi
(cd "$IOS_PROJECT_DIR" && xcodegen generate)

ARCHIVE="$IOS_PROJECT_DIR/.build/SliccFollower.xcarchive"
EXPORT_DIR="$IOS_PROJECT_DIR/.build/export"
EXPORT_OPTS="$IOS_PROJECT_DIR/.build/ExportOptions-AppStore.generated.plist"
rm -rf "$ARCHIVE" "$EXPORT_DIR" "$EXPORT_OPTS"
mkdir -p "$IOS_PROJECT_DIR/.build"

CLEANUP=()
trap 'for f in "${CLEANUP[@]:-}"; do rm -rf "$f" 2>/dev/null || true; done; if [ "${OWN_KEYCHAIN:-0}" = "1" ] && [ -n "${KEYCHAIN_PATH:-}" ]; then security delete-keychain "$KEYCHAIN_PATH" || true; fi' EXIT

# --- Cert: import the Apple Distribution .p12 into a keychain --------------
#
# When running from CI's release.yml, the "Import Apple certificates"
# step has already created KEYCHAIN_PATH and imported the Apple
# Distribution cert (after openssl-normalizing the .p12 so legacy
# RC2-40 PKCS#12 exports can be read by macos-15-arm64's `security`).
# Re-importing the raw base64 here would either duplicate the cert or,
# worse, fail with "SecKeychainItemImport: Unable to decode the
# provided data" on the legacy export path — negating the workflow's
# normalization.
#
# So:
#   * CI path (KEYCHAIN_PATH already set): skip the cert import. Trust
#     that release.yml seeded the keychain.
#   * Local path (no KEYCHAIN_PATH): create a temp keychain and apply
#     the same openssl re-encrypt round-trip the workflow uses.
#
# Addressed Copilot review comment on PR #572 line 97.
if [ -n "${KEYCHAIN_PATH:-}" ]; then
  echo "  reusing keychain seeded by workflow: $KEYCHAIN_PATH"
  echo "  (skipping APPLE_DISTRIBUTION_CERT_BASE64 import — already done)"
elif [ -n "${APPLE_DISTRIBUTION_CERT_BASE64:-}" ]; then
  if [ -z "${APPLE_DISTRIBUTION_CERT_PASSWORD:-}" ]; then
    echo "error: APPLE_DISTRIBUTION_CERT_PASSWORD must accompany APPLE_DISTRIBUTION_CERT_BASE64" >&2
    exit 1
  fi

  KEYCHAIN_PATH="${RUNNER_TEMP:-/tmp}/ios-signing-$$.keychain-db"
  KEYCHAIN_PASSWORD="$(openssl rand -base64 32)"
  security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
  security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
  security list-keychain -d user -s "$KEYCHAIN_PATH"
  OWN_KEYCHAIN=1
  echo "  created temp keychain: $KEYCHAIN_PATH"

  CERT_TMPDIR="$(mktemp -d -t slicc-tf-cert)"
  chmod 700 "$CERT_TMPDIR"
  CLEANUP+=("$CERT_TMPDIR")

  RAW="$CERT_TMPDIR/raw.p12"
  PEM="$CERT_TMPDIR/cert.pem"
  NORM="$CERT_TMPDIR/normalized.p12"

  printf '%s' "$APPLE_DISTRIBUTION_CERT_BASE64" | base64 --decode > "$RAW"
  if ! openssl pkcs12 -in "$RAW" -nodes -out "$PEM" \
       -passin "pass:${APPLE_DISTRIBUTION_CERT_PASSWORD}" 2>/dev/null; then
    echo "error: openssl could not read APPLE_DISTRIBUTION_CERT_BASE64" >&2
    exit 1
  fi
  openssl pkcs12 -export -in "$PEM" -out "$NORM" \
    -password "pass:${APPLE_DISTRIBUTION_CERT_PASSWORD}" \
    -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256

  security import "$NORM" \
    -P "$APPLE_DISTRIBUTION_CERT_PASSWORD" \
    -A -t cert -f pkcs12 \
    -k "$KEYCHAIN_PATH"
  security set-key-partition-list \
    -S apple-tool:,apple:,codesign: \
    -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH" >/dev/null
  echo "  imported Apple Distribution cert"
fi

# --- Profiles: install into ~/Library/MobileDevice/Provisioning Profiles ----
# Helper installs one base64 profile and echoes its UUID. The app embeds a
# File Provider appex, so archive/export needs both the main app profile and
# the appex profile (same App Group).
install_profile_b64() {
  local b64="$1" label="$2"
  local profile_dir="$HOME/Library/MobileDevice/Provisioning Profiles"
  mkdir -p "$profile_dir"
  local profile_tmp
  profile_tmp="$(mktemp -t slicc-profile).mobileprovision"
  CLEANUP+=("$profile_tmp")
  printf '%s' "$b64" | base64 --decode > "$profile_tmp"
  local profile_uuid
  profile_uuid="$(security cms -D -i "$profile_tmp" 2>/dev/null \
    | plutil -extract UUID raw -o - -)"
  cp "$profile_tmp" "$profile_dir/${profile_uuid}.mobileprovision"
  echo "  installed $label provisioning profile $profile_uuid"
}

install_profile_b64 "$APPLE_PROVISIONING_PROFILE_BASE64" "app"
install_profile_b64 "$APPLE_FILEPROVIDER_PROVISIONING_PROFILE_BASE64" "fileprovider"
install_profile_b64 "$APPLE_SHARE_PROVISIONING_PROFILE_BASE64" "share"
install_profile_b64 "$APPLE_WIDGETS_PROVISIONING_PROFILE_BASE64" "widgets"

# --- API key: locate the .p8 so altool / xcodebuild can find it -----------
if [ -z "${APPLE_API_KEY_ID:-}" ] || [ -z "${APPLE_API_KEY_ISSUER_ID:-}" ]; then
  echo "error: APPLE_API_KEY_ID and APPLE_API_KEY_ISSUER_ID must be set" >&2
  exit 1
fi
if [ -n "${APPLE_API_KEY_P8_BASE64:-}" ]; then
  # altool --upload-app's --apiKey only takes the 10-char key ID, not
  # a path; it searches standard locations for AuthKey_<KEY_ID>.p8:
  #   ./private_keys, ~/private_keys, ~/.private_keys,
  #   ~/.appstoreconnect/private_keys
  # xcodebuild has -authenticationKeyPath which accepts arbitrary paths,
  # but altool does not, so we have to write to one of the well-known
  # locations. Use ~/.appstoreconnect/private_keys/ — it's the canonical
  # one and on a fresh CI runner this directory doesn't exist, so we
  # never clobber a developer's pre-existing key. We track it in
  # CLEANUP so an interrupted run doesn't leave the key on disk.
  P8_DIR="$HOME/.appstoreconnect/private_keys"
  mkdir -p "$P8_DIR"
  P8_PATH="$P8_DIR/AuthKey_${APPLE_API_KEY_ID}.p8"
  if [ -f "$P8_PATH" ] && [ -z "${GITHUB_RUN_NUMBER:-}" ]; then
    echo "  refusing to overwrite existing $P8_PATH (running locally)"
    echo "  (delete it manually if you want this script to manage it)"
  else
    printf '%s' "$APPLE_API_KEY_P8_BASE64" | base64 --decode > "$P8_PATH"
    chmod 600 "$P8_PATH"
    CLEANUP+=("$P8_PATH")
    echo "  wrote API key: $P8_PATH"
  fi
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
        <key>${FILEPROVIDER_BUNDLE_ID}</key>
        <string>${FILEPROVIDER_PROFILE_NAME}</string>
        <key>${SHARE_BUNDLE_ID}</key>
        <string>${SHARE_PROFILE_NAME}</string>
        <key>${WIDGETS_BUNDLE_ID}</key>
        <string>${WIDGETS_PROFILE_NAME}</string>
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
# Force manual signing for the archive even though the project file
# defaults to Automatic. CI's keychain only has the Apple Distribution
# cert (Development is intentionally not in the secrets surface), so
# automatic signing aborts looking for "Apple Development". Overriding
# at the command line keeps the .pbxproj friendly for local Xcode
# builds while pinning CI to the manual cert + provisioning profile we
# already imported.
#
# Global PROVISIONING_PROFILE_SPECIFIER only covers the app target; the
# File Provider appex needs its own specifier. xcodebuild accepts the
# global override for the main product; export uses ExportOptions.plist
# for both bundle IDs. To keep archive codesign happy for the embedded
# appex, also pass the appex specifier via a temporary xcconfig that
# only XcodeGen-style target settings would otherwise provide. We patch
# the generated pbxproj Release configs for the two bundle IDs just for
# this archive (project is regenerated in CI anyway from project.yml).
python3 - "$IOS_PROJECT_DIR/SliccFollower.xcodeproj/project.pbxproj" \
  "$BUNDLE_ID" "$PROFILE_NAME" \
  "$FILEPROVIDER_BUNDLE_ID" "$FILEPROVIDER_PROFILE_NAME" \
  "$SHARE_BUNDLE_ID" "$SHARE_PROFILE_NAME" \
  "$WIDGETS_BUNDLE_ID" "$WIDGETS_PROFILE_NAME" \
  "$TEAM_ID" <<'PY'
import sys
from pathlib import Path
(path, app_id, app_prof, fp_id, fp_prof, share_id, share_prof,
 widgets_id, widgets_prof, team) = sys.argv[1:11]
text = Path(path).read_text()
lines = text.splitlines(keepends=True)
out = []
i = 0
targets = {
    app_id: (app_prof, "Manual"),
    fp_id: (fp_prof, "Manual"),
    share_id: (share_prof, "Manual"),
    widgets_id: (widgets_prof, "Manual"),
}
while i < len(lines):
    out.append(lines[i])
    for bundle_id, (profile, style) in targets.items():
        if f"PRODUCT_BUNDLE_IDENTIFIER = {bundle_id};" in lines[i]:
            block = []
            j = i + 1
            while j < len(lines) and lines[j].strip() != "};":
                block.append(lines[j])
                j += 1
            new_block = []
            seen = set()
            for l in block:
                if "PROVISIONING_PROFILE_SPECIFIER" in l:
                    new_block.append(
                        f'\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "{profile}";\n'
                    )
                    seen.add("profile")
                    continue
                if "CODE_SIGN_STYLE" in l:
                    new_block.append(f"\t\t\t\tCODE_SIGN_STYLE = {style};\n")
                    seen.add("style")
                    continue
                if "DEVELOPMENT_TEAM" in l:
                    new_block.append(f"\t\t\t\tDEVELOPMENT_TEAM = {team};\n")
                    seen.add("team")
                    continue
                if "CODE_SIGN_IDENTITY" in l and "sdk" not in l:
                    new_block.append(
                        '\t\t\t\tCODE_SIGN_IDENTITY = "Apple Distribution";\n'
                    )
                    seen.add("identity")
                    continue
                new_block.append(l)
            inserts = []
            if "profile" not in seen:
                inserts.append(
                    f'\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "{profile}";\n'
                )
            if "style" not in seen:
                inserts.append(f"\t\t\t\tCODE_SIGN_STYLE = {style};\n")
            if "team" not in seen:
                inserts.append(f"\t\t\t\tDEVELOPMENT_TEAM = {team};\n")
            if "identity" not in seen:
                inserts.append(
                    '\t\t\t\tCODE_SIGN_IDENTITY = "Apple Distribution";\n'
                )
            out.extend(inserts)
            out.extend(new_block)
            if j < len(lines):
                out.append(lines[j])
            i = j + 1
            break
    else:
        i += 1
        continue
Path(path).write_text("".join(out))
print(f"  patched pbxproj signing for {app_id} + {fp_id} + {share_id} + {widgets_id}")
PY

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
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="Apple Distribution" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  MARKETING_VERSION="$VERSION" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  ${ENTITLEMENTS_OVERRIDE[@]+"${ENTITLEMENTS_OVERRIDE[@]}"} \
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
# altool --upload-app returns exit 0 even when App Store Connect rejects
# the bundle at pre-flight validation (e.g. "Validation failed (409)
# Invalid bundle..."). It logs the error to stderr and walks away — so a
# bare `|| exit 1` doesn't catch it, and the workflow goes green while
# zero builds reach TestFlight. Tee output and grep for the failure
# markers altool actually emits before declaring success.
ALTOOL_LOG="$IOS_PROJECT_DIR/.build/altool.log"
set +e
xcrun altool --upload-app \
  -f "$IPA" \
  --type ios \
  --apiKey "$APPLE_API_KEY_ID" \
  --apiIssuer "$APPLE_API_KEY_ISSUER_ID" \
  2>&1 | tee "$ALTOOL_LOG"
# Capture both halves of the pipeline before re-enabling errexit. tee
# can fail independently of altool (e.g. .build is read-only), and we
# don't want a write failure to look like a successful upload.
#
# PIPESTATUS is rewritten after EVERY command (including a plain
# assignment), so two separate `VAR=${PIPESTATUS[N]}` lines read from a
# stale, single-element array — under `set -u` that aborts with
# "PIPESTATUS[1]: unbound variable" (broke release v2.34.3 → 0 GitHub
# release after a successful TestFlight upload). Capture the whole
# array in one expansion so both indices are available afterwards.
PIPE_STATUS=("${PIPESTATUS[@]}")
set -e
ALTOOL_STATUS="${PIPE_STATUS[0]}"
TEE_STATUS="${PIPE_STATUS[1]}"
if [ "$ALTOOL_STATUS" -ne 0 ]; then
  echo "error: altool exited $ALTOOL_STATUS" >&2
  exit 1
fi
if [ "$TEE_STATUS" -ne 0 ]; then
  echo "error: tee failed (exit $TEE_STATUS) writing $ALTOOL_LOG — log capture is unreliable, refusing to declare success" >&2
  exit 1
fi
# grep can return 0 (match → fail), 1 (no match → ship), or 2 (I/O
# error — log missing/unreadable). The naked `if grep …; then` form
# treats 2 the same as 1 and would ship a build whose validation status
# we couldn't actually verify. Branch on the exact status instead.
set +e
grep -qE 'ERROR: \[altool\.|Validation failed' "$ALTOOL_LOG"
GREP_STATUS=$?
set -e
case "$GREP_STATUS" in
  0)
    echo "error: altool reported a validation/upload failure (see log above)" >&2
    exit 1
    ;;
  1) ;;
  *)
    echo "error: grep failed (exit $GREP_STATUS) reading $ALTOOL_LOG — cannot verify upload" >&2
    exit 1
    ;;
esac
echo "=== SliccFollower v${VERSION} (build ${BUILD_NUMBER}) uploaded ==="

# --- External distribution (opt-in) ----------------------------------------
# altool stops at "uploaded"; testflight-distribute.mjs waits for processing,
# sets What to Test, submits Beta App Review, and attaches the build to the
# named tester group. Gated on SLICC_TF_EXTERNAL_GROUP so repos without an
# external program keep the historical upload-only behavior.
if [ -n "${SLICC_TF_EXTERNAL_GROUP:-}" ]; then
  echo "  distributing to tester group '$SLICC_TF_EXTERNAL_GROUP'..."
  SLICC_TF_BUILD_NUMBER="$BUILD_NUMBER" \
    SLICC_TF_BUNDLE_ID="$BUNDLE_ID" \
    APPLE_API_KEY_P8_PATH="$P8_PATH" \
    node "$SCRIPT_DIR/testflight-distribute.mjs"
else
  echo "  SLICC_TF_EXTERNAL_GROUP not set — upload only, no tester distribution."
fi
