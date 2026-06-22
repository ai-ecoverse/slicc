#!/usr/bin/env bash
# setup-dev-cert — create a STABLE self-signed code-signing identity for local
# swift-server development so its macOS Keychain Designated Requirement (DR)
# stops changing on every `swift build`.
#
# Why: swift-server reads a single Keychain item (service `ai.sliccy.slicc`,
# account `__envfile__`) at startup. An ad-hoc-signed binary's DR changes per
# build, so the "Always Allow" grant never sticks and macOS re-prompts every
# run — which HANGS a headless launch (the dev fresh-bridge harness). Signing
# with one persistent identity gives a stable DR, so a single "Always Allow"
# (or the partition-list grant printed below) survives every rebuild.
#
# This is a ONE-TIME, interactive setup (it touches your login keychain). The
# harness `dev-swift-fresh.sh` auto-signs the binary with this identity when it
# exists; until then it falls back to the ad-hoc signature.
#
# Usage:
#   bash packages/dev-tools/tools/setup-dev-cert.sh
set -euo pipefail

IDENTITY_CN="SLICC Dev Code Signing"
KEYCHAIN="login.keychain-db"
P12_PASS="slicc-dev"
KC_SERVICE="ai.sliccy.slicc"
KC_ACCOUNT="__envfile__"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "❌  This script only applies to macOS (Security.framework / codesign)."
  exit 1
fi

# ── 1. Idempotency: bail out if the identity already exists ───────────
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY_CN"; then
  echo "✔  Code-signing identity already present: \"$IDENTITY_CN\""
  echo "   (Re-run with FORCE=1 to recreate.)"
  if [[ "${FORCE:-0}" != "1" ]]; then
    exit 0
  fi
  echo "⚠️   FORCE=1 — leaving the old identity in place; a new one will be added."
fi

# ── 2. Generate a self-signed code-signing cert + key ────────────────
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
CONF="$WORKDIR/cert.cnf"
cat > "$CONF" <<EOF
[req]
distinguished_name = dn
x509_extensions    = v3
prompt             = no
[dn]
CN = $IDENTITY_CN
[v3]
basicConstraints   = critical,CA:false
keyUsage           = critical,digitalSignature
extendedKeyUsage   = critical,codeSigning
EOF

echo "🔧  Generating self-signed code-signing certificate (valid 10 years)…"
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$WORKDIR/key.pem" -out "$WORKDIR/cert.pem" \
  -days 3650 -config "$CONF" >/dev/null 2>&1

# OpenSSL 3 defaults to PBES2/AES-256 + SHA-256 MAC, which macOS `security import`
# cannot verify ("MAC verification failed"). Force the legacy 3DES/RC2 + SHA-1 MAC
# bundle macOS accepts. LibreSSL (/usr/bin/openssl) lacks -legacy and already emits a
# compatible bundle, so only add the flags when this openssl supports them.
P12_LEGACY_ARGS=()
if openssl pkcs12 -help 2>&1 | grep -q -- '-legacy'; then
  P12_LEGACY_ARGS=(-legacy -macalg sha1)
fi
openssl pkcs12 -export "${P12_LEGACY_ARGS[@]}" \
  -inkey "$WORKDIR/key.pem" -in "$WORKDIR/cert.pem" \
  -out "$WORKDIR/identity.p12" -passout "pass:$P12_PASS" >/dev/null 2>&1

# ── 3. Import into the login keychain, allowing codesign to use the key ─
echo "📥  Importing identity into ${KEYCHAIN}…"
security import "$WORKDIR/identity.p12" \
  -k "$KEYCHAIN" -P "$P12_PASS" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null

# ── 4. Let codesign use the private key without prompting ─────────────
# set-key-partition-list rewrites the private key's ACL partition list; it
# needs your login-keychain password. We never echo it.
echo ""
echo "🔑  Your login-keychain password is needed once to authorize codesign"
echo "    to use the new signing key without prompting."
read -r -s -p "    login keychain password: " LOGIN_PW
echo ""
if security set-key-partition-list \
  -S apple-tool:,apple: -s -k "$LOGIN_PW" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "✔  Signing key authorized for codesign."
else
  echo "⚠️   Could not set key partition list (wrong password?). codesign may"
  echo "    prompt once the first time it uses the key — that's harmless."
fi
unset LOGIN_PW

echo ""
echo "✅  Done. Identity \"$IDENTITY_CN\" is ready."
echo ""
echo "Next:"
echo "  1. The harness signs swift-server with it automatically:"
echo "       bash packages/dev-tools/tools/dev-swift-fresh.sh"
echo "  2. Grant the server access to its secrets blob ONCE, interactively:"
echo "     run the harness (or the server) in a terminal and, when macOS shows"
echo "     the Keychain access prompt for \"$KC_SERVICE\", click \"Always Allow\"."
echo "     This binary now has a STABLE Designated Requirement, so that"
echo "     trusted-application grant sticks across every future rebuild."
echo ""
echo "  (Optional non-interactive alternative — for THIS stable identity only,"
echo "   NOT for ad-hoc binaries, whose unreliable unsigned: partition does"
echo "   not durably authorize a per-rebuild cdhash. The interactive"
echo "   \"Always Allow\" above is the recommended path.)"
echo ""
echo "       security set-generic-password-partition-list \\"
echo "         -S apple-tool:,apple: \\"
echo "         -s $KC_SERVICE -a $KC_ACCOUNT \\"
echo "         -k \"<your-login-keychain-password>\""
