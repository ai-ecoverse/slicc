#!/bin/bash
# Set the GitHub Actions secrets needed for the TestFlight upload pipeline.
#
# The macOS Sliccstart pipeline already uses APPLE_TEAM_ID / APPLE_ID /
# APPLE_APP_SPECIFIC_PASSWORD / APPLE_CERTIFICATE_BASE64 (Developer ID).
# TestFlight (iOS) needs a *separate* set of credentials because:
#   * App Store uploads sign with "Apple Distribution", not "Developer ID Application"
#   * altool can use an App Store Connect API key (.p8) instead of the
#     username + app-specific password pair
#
# This script registers/refreshes:
#
#   APPLE_API_KEY_ID                    # plain text (10-char Key ID)
#   APPLE_API_KEY_ISSUER_ID             # plain text (UUID)
#   APPLE_API_KEY_P8_BASE64             # base64 of the AuthKey_*.p8
#   APPLE_DISTRIBUTION_CERT_BASE64      # base64 of an Apple Distribution .p12
#   APPLE_DISTRIBUTION_CERT_PASSWORD    # password for the .p12
#   APPLE_PROVISIONING_PROFILE_BASE64   # base64 of the App Store .mobileprovision
#
# Usage:
#   packages/ios-app/scripts/setup-testflight-secrets.sh \
#     --key-id DWXPL9LU63 \
#     --issuer-id 13125f6b-67e9-4fa2-9c4a-ec54dc1fc873 \
#     --p8 ~/.appstoreconnect/private_keys/AuthKey_DWXPL9LU63.p8 \
#     --profile "$HOME/Library/MobileDevice/Provisioning Profiles/Slicc_Follower_App_Store.mobileprovision" \
#     --cert-p12 /path/to/AppleDistribution.p12 \
#     --cert-password 'something'
#
# Anything you don't pass is read from the corresponding env var (see
# below) or, for the API key, auto-discovered from the standard
# ~/.appstoreconnect/private_keys/ location.
#
# The Apple Distribution cert MUST be exported from Keychain Access
# beforehand:
#   1. Open Keychain Access
#   2. Find "Apple Distribution: <Your Name> (<TeamID>)" under
#      "My Certificates"
#   3. Right-click the certificate row (NOT the private key sub-row)
#      and choose "Export ..."
#   4. Save as Personal Information Exchange (.p12) and pick a password
#      (you'll pass it via --cert-password / APPLE_DISTRIBUTION_CERT_PASSWORD)
set -euo pipefail

# Use the absolute gh path so this works under shell wrappers that
# intercept `gh` for auth checks. Fall back to PATH lookup otherwise.
GH_BIN="${GH_BIN:-/opt/homebrew/bin/gh}"
if [ ! -x "$GH_BIN" ]; then
  GH_BIN="$(command -v gh || true)"
fi
if [ -z "$GH_BIN" ] || [ ! -x "$GH_BIN" ]; then
  echo "error: gh CLI not found. Install with 'brew install gh' or set GH_BIN." >&2
  exit 1
fi

REPO="${GITHUB_REPO:-ai-ecoverse/slicc}"

KEY_ID="${APPLE_API_KEY_ID:-}"
ISSUER_ID="${APPLE_API_KEY_ISSUER_ID:-}"
P8_PATH="${APPLE_API_KEY_P8_PATH:-}"
PROFILE_PATH="${APPLE_PROVISIONING_PROFILE_PATH:-}"
CERT_P12_PATH="${APPLE_DISTRIBUTION_CERT_P12:-}"
CERT_PASSWORD="${APPLE_DISTRIBUTION_CERT_PASSWORD:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --key-id) KEY_ID="$2"; shift 2;;
    --issuer-id) ISSUER_ID="$2"; shift 2;;
    --p8) P8_PATH="$2"; shift 2;;
    --profile) PROFILE_PATH="$2"; shift 2;;
    --cert-p12) CERT_P12_PATH="$2"; shift 2;;
    --cert-password) CERT_PASSWORD="$2"; shift 2;;
    --repo) REPO="$2"; shift 2;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0;;
    *)
      echo "error: unknown flag: $1" >&2
      exit 2;;
  esac
done

# Auto-discover the API key file if --p8 was not given.
if [ -z "$P8_PATH" ] && [ -n "$KEY_ID" ]; then
  candidate="$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8"
  if [ -f "$candidate" ]; then
    P8_PATH="$candidate"
  fi
fi
if [ -z "$P8_PATH" ]; then
  found=$(ls "$HOME/.appstoreconnect/private_keys/AuthKey_"*.p8 2>/dev/null | head -1)
  if [ -n "$found" ]; then
    P8_PATH="$found"
    if [ -z "$KEY_ID" ]; then
      KEY_ID="$(basename "$P8_PATH" | sed -E 's/^AuthKey_(.*)\.p8$/\1/')"
      echo "  inferred APPLE_API_KEY_ID=$KEY_ID from $P8_PATH"
    fi
  fi
fi

missing=()
[ -z "$KEY_ID" ]        && missing+=("--key-id / APPLE_API_KEY_ID")
[ -z "$ISSUER_ID" ]     && missing+=("--issuer-id / APPLE_API_KEY_ISSUER_ID")
[ -z "$P8_PATH" ]       && missing+=("--p8 / APPLE_API_KEY_P8_PATH")
[ -z "$PROFILE_PATH" ]  && missing+=("--profile / APPLE_PROVISIONING_PROFILE_PATH")
[ -z "$CERT_P12_PATH" ] && missing+=("--cert-p12 / APPLE_DISTRIBUTION_CERT_P12")
[ -z "$CERT_PASSWORD" ] && missing+=("--cert-password / APPLE_DISTRIBUTION_CERT_PASSWORD")
if [ ${#missing[@]} -ne 0 ]; then
  echo "error: missing required arguments:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  echo >&2
  echo "Run '$0 --help' for usage." >&2
  exit 2
fi

for f in "$P8_PATH" "$PROFILE_PATH" "$CERT_P12_PATH"; do
  if [ ! -f "$f" ]; then
    echo "error: file not found: $f" >&2
    exit 2
  fi
done

# Sanity-check the .p12 password before pushing it as a secret.
if ! openssl pkcs12 -in "$CERT_P12_PATH" -passin "pass:$CERT_PASSWORD" -nokeys -noout >/dev/null 2>&1; then
  echo "error: cannot decrypt $CERT_P12_PATH with the supplied password." >&2
  echo "       Re-export the cert from Keychain Access and try again." >&2
  exit 2
fi

set_secret() {
  local name="$1" value="$2"
  printf '  %-40s ' "$name"
  if printf '%s' "$value" | "$GH_BIN" secret set "$name" -R "$REPO" --body - >/dev/null; then
    echo "ok"
  else
    echo "FAILED"
    return 1
  fi
}

echo "Setting TestFlight secrets on $REPO via $GH_BIN..."
set_secret APPLE_API_KEY_ID "$KEY_ID"
set_secret APPLE_API_KEY_ISSUER_ID "$ISSUER_ID"
set_secret APPLE_API_KEY_P8_BASE64 "$(base64 < "$P8_PATH")"
set_secret APPLE_DISTRIBUTION_CERT_BASE64 "$(base64 < "$CERT_P12_PATH")"
set_secret APPLE_DISTRIBUTION_CERT_PASSWORD "$CERT_PASSWORD"
set_secret APPLE_PROVISIONING_PROFILE_BASE64 "$(base64 < "$PROFILE_PATH")"

echo
echo "Done. Verify with:"
echo "  $GH_BIN secret list -R $REPO | grep -E 'APPLE_API_KEY|APPLE_DISTRIBUTION|APPLE_PROVISIONING'"
