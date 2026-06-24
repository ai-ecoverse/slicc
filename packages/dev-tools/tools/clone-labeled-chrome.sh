#!/usr/bin/env bash
# clone-labeled-chrome — make a per-harness copy of a "Google Chrome for
# Testing.app" bundle with a distinct CFBundleName / CFBundleDisplayName /
# CFBundleIdentifier so multiple concurrent SLICC dev floats show up as
# separate, named entries in the macOS ⌘-Tab App Switcher instead of three
# identical "Google Chrome for Testing" entries.
#
# macOS labels each running app by its bundle's CFBundleName and groups
# Switcher entries by CFBundleIdentifier, so launching the SAME .app multiple
# times (via `open -n -a`) collapses into one indistinguishable entry. Cloning
# the bundle with a unique name + id gives each float its own label/icon while
# preserving the full app-bundle identity the LaunchServices launch path relies
# on (Web Speech network backend, TCC mic grant) — the raw-binary fallback
# would lose that.
#
# On APFS the clone is a copy-on-write `cp -Rc`: effectively instant and
# space-free. Editing Info.plist breaks the bundle's resource seal, so the
# clone is re-signed ad-hoc (top-level only; nested frameworks keep their valid
# Google signatures) to keep launches clean.
#
# Usage:
#   CLONE_APP="$(bash clone-labeled-chrome.sh <source.app> <label> [bundle-id])"
#
# Args:
#   <source.app>  enclosing .app bundle of a Chrome for Testing install
#   <label>       Switcher label, e.g. "SLICC-Ext" (also the default id leaf)
#   [bundle-id]   optional CFBundleIdentifier (default: ai.sliccy.cft.<label>)
#
# Output (stdout): absolute path to the cloned .app bundle. All status/logging
# goes to stderr so the path can be captured cleanly in a command substitution.
#
# Env:
#   SLICC_CHROME_CLONE_DIR   clone parent dir (default: /tmp/slicc-chrome-clones)
#
# Behavior: on non-darwin (no LaunchServices / Switcher) it echoes the source
# bundle unchanged so callers stay portable. Exits non-zero with a stderr
# message when the source is missing or the clone/relabel fails.
set -euo pipefail

SRC_APP="${1:?usage: clone-labeled-chrome.sh <source.app> <label> [bundle-id]}"
LABEL="${2:?usage: clone-labeled-chrome.sh <source.app> <label> [bundle-id]}"
BUNDLE_ID="${3:-ai.sliccy.cft.${LABEL}}"

log() { echo "$@" >&2; }

# Non-darwin: no LaunchServices / App Switcher — pass the source through as-is.
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
# -c requests an APFS copy-on-write clone; fall back to a plain recursive copy
# on non-APFS volumes where -c isn't supported.
if ! cp -Rc "$SRC_APP" "$CLONE_APP" 2>/dev/null; then
  log "ℹ️   APFS clone unavailable — falling back to a full copy"
  cp -R "$SRC_APP" "$CLONE_APP"
fi

PLIST="${CLONE_APP}/Contents/Info.plist"
if [ ! -f "$PLIST" ]; then
  log "❌  clone-labeled-chrome: Info.plist missing in clone: $PLIST"
  exit 1
fi

# Set (or add, when the key is absent) each identity key.
set_key() {
  local key="$1" val="$2"
  /usr/libexec/PlistBuddy -c "Set :${key} ${val}" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :${key} string ${val}" "$PLIST"
}
set_key CFBundleName "$LABEL"
set_key CFBundleDisplayName "$LABEL"
set_key CFBundleIdentifier "$BUNDLE_ID"

# Editing Info.plist invalidates the bundle's resource seal. Re-sign the
# top-level bundle ad-hoc (no --deep: nested helpers/frameworks keep their
# valid Google signatures) so the launch isn't refused. Best-effort: a
# non-quarantined clone usually still launches even if this fails.
if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$CLONE_APP" >/dev/null 2>&1 \
    || log "⚠️   ad-hoc re-sign failed — launch may still work (clone is local/unquarantined)"
fi

# LaunchServices caches bundle metadata by path; register the clone so the new
# name/id take effect immediately for this launch.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$CLONE_APP" >/dev/null 2>&1 || true

log "✔  Labeled Chrome clone ready: ${CLONE_APP} (id: ${BUNDLE_ID})"
echo "$CLONE_APP"
