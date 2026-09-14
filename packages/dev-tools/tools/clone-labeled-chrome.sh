#!/usr/bin/env bash




































set -euo pipefail

SRC_APP="${1:?usage: clone-labeled-chrome.sh <source.app> <label> [bundle-id]}"
LABEL="${2:?usage: clone-labeled-chrome.sh <source.app> <label> [bundle-id]}"
BUNDLE_ID="${3:-ai.sliccy.cft.${LABEL}}"

log() { echo "$@" >&2; }


if [ "$(uname -s)" != "Darwin" ]; then
  echo "$SRC_APP"
  exit 0
fi

if [ ! -d "$SRC_APP" ]; then
  log "❌  clone-labeled-chrome: source app bundle not found: $SRC_APP"
  exit 1
fi

CLONE_DIR="${SLICC_CHROME_CLONE_DIR:-/tmp/slicc-chrome-clones}"
mkdir -p "$CLONE_DIR"
CLONE_APP="${CLONE_DIR}/${LABEL}.app"

log "🪞  Cloning Chrome for Testing → ${CLONE_APP} (label: ${LABEL})"
rm -rf "$CLONE_APP"


if ! cp -Rc "$SRC_APP" "$CLONE_APP" 2>/dev/null; then
  log "ℹ️   APFS clone unavailable — falling back to a full copy"
  cp -R "$SRC_APP" "$CLONE_APP"
fi

PLIST="${CLONE_APP}/Contents/Info.plist"
if [ ! -f "$PLIST" ]; then
  log "❌  clone-labeled-chrome: Info.plist missing in clone: $PLIST"
  exit 1
fi


set_key() {
  local key="$1" val="$2"
  /usr/libexec/PlistBuddy -c "Set :${key} ${val}" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :${key} string ${val}" "$PLIST"
}
set_key CFBundleName "$LABEL"
set_key CFBundleDisplayName "$LABEL"
set_key CFBundleIdentifier "$BUNDLE_ID"





if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$CLONE_APP" >/dev/null 2>&1 \
    || log "⚠️   ad-hoc re-sign failed — launch may still work (clone is local/unquarantined)"
fi



LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$CLONE_APP" >/dev/null 2>&1 || true

log "✔  Labeled Chrome clone ready: ${CLONE_APP} (id: ${BUNDLE_ID})"
echo "$CLONE_APP"
