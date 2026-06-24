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

# ── 1. Idempotency: keep a single, already-valid identity as-is ───────
# Bail ONLY when exactly one VALID (trusted) identity is present. The old
# check used the bare `-v` form but the cert was never trusted, so on a broken
# setup it matched nothing and happily stacked another duplicate every run
# (that is how the keychain ended up with several "$IDENTITY_CN" copies).
EXISTING_VALID="$(security find-identity -v -p codesigning 2>/dev/null | grep -cF "$IDENTITY_CN" || true)"
if [[ "$EXISTING_VALID" == "1" && "${FORCE:-0}" != "1" ]]; then
  echo "✔  Valid code-signing identity already present: \"$IDENTITY_CN\""
  echo "   (Re-run with FORCE=1 to recreate.)"
  exit 0
fi

# ── 1b. Clean slate: remove EVERY pre-existing copy (trusted or not) ──
# Re-runs (and the earlier `-v` bug) can stack several "$IDENTITY_CN"
# identities. `delete-identity -c` / `delete-certificate -c` refuse to act
# when a CN is ambiguous ("matches more than one certificate"), so delete by
# SHA-1 hash, one at a time, until none remain — then create exactly one
# fresh, trusted identity below. This also clears the existing duplicates.
REMOVED=0
while true; do
  CERT_HASH="$(security find-certificate -a -c "$IDENTITY_CN" -Z "$KEYCHAIN" 2>/dev/null \
    | awk '/SHA-1 hash:/{print $3; exit}')"
  [[ -z "$CERT_HASH" ]] && break
  security delete-identity -Z "$CERT_HASH" "$KEYCHAIN" >/dev/null 2>&1 \
    || security delete-certificate -Z "$CERT_HASH" "$KEYCHAIN" >/dev/null 2>&1 \
    || break
  REMOVED=$((REMOVED + 1))
  [[ "$REMOVED" -gt 20 ]] && break
done
if [[ "$REMOVED" -gt 0 ]]; then
  echo "🧹  Removed $REMOVED pre-existing \"$IDENTITY_CN\" cert(s) before recreating."
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

# ── 3b. Trust the self-signed cert for code signing ──────────────────
# A self-signed cert imports as UNtrusted (CSSMERR_TP_NOT_TRUSTED), so
# `security find-identity -v -p codesigning` — the valid-only form both this
# script and dev-swift-fresh.sh use to detect the identity — returns nothing
# and the harness silently falls back to ad-hoc signing, defeating the stable
# Designated Requirement this script exists to provide. Add a code-signing
# trust setting in the USER trust domain (no -d / sudo; applies
# non-interactively) so the identity becomes valid.
echo "🔏  Trusting \"$IDENTITY_CN\" for code signing (user trust domain)…"
if security add-trusted-cert -p codeSign -k "$KEYCHAIN" "$WORKDIR/cert.pem" >/dev/null 2>&1; then
  echo "✔  Trust setting added."
else
  echo "⚠️   Could not add a code-signing trust setting; the identity may stay"
  echo "    invalid (find-identity -v would not list it)."
fi

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

# ── 5. Verify the identity is now valid + unique ─────────────────────
VALID_NOW="$(security find-identity -v -p codesigning 2>/dev/null | grep -cF "$IDENTITY_CN" || true)"
if [[ "$VALID_NOW" == "1" ]]; then
  echo "✔  Verified: exactly one VALID \"$IDENTITY_CN\" identity is present."
else
  echo "⚠️   Expected exactly one VALID identity, found $VALID_NOW."
  echo "    'security find-identity -v -p codesigning' must list it for the"
  echo "    harness to sign with it. If it stays invalid, the trust setting"
  echo "    did not apply on this machine."
fi

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
