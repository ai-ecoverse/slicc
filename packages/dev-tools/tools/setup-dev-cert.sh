#!/usr/bin/env bash

















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






EXISTING_VALID="$(security find-identity -v -p codesigning 2>/dev/null | grep -cF "$IDENTITY_CN" || true)"
if [[ "$EXISTING_VALID" == "1" && "${FORCE:-0}" != "1" ]]; then
  echo "✔  Valid code-signing identity already present: \"$IDENTITY_CN\""
  echo "   (Re-run with FORCE=1 to recreate.)"
  exit 0
fi







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





P12_LEGACY_ARGS=()
if openssl pkcs12 -help 2>&1 | grep -q -- '-legacy'; then
  P12_LEGACY_ARGS=(-legacy -macalg sha1)
fi
openssl pkcs12 -export "${P12_LEGACY_ARGS[@]}" \
  -inkey "$WORKDIR/key.pem" -in "$WORKDIR/cert.pem" \
  -out "$WORKDIR/identity.p12" -passout "pass:$P12_PASS" >/dev/null 2>&1


echo "📥  Importing identity into ${KEYCHAIN}…"
security import "$WORKDIR/identity.p12" \
  -k "$KEYCHAIN" -P "$P12_PASS" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null









echo "🔏  Trusting \"$IDENTITY_CN\" for code signing (user trust domain)…"
if security add-trusted-cert -p codeSign -k "$KEYCHAIN" "$WORKDIR/cert.pem" >/dev/null 2>&1; then
  echo "✔  Trust setting added."
else
  echo "⚠️   Could not add a code-signing trust setting; the identity may stay"
  echo "    invalid (find-identity -v would not list it)."
fi




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
