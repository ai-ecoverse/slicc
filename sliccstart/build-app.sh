#!/bin/bash
# Build Sliccstart.app — a self-contained macOS app bundle
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SLICC_ROOT="$(dirname "$SCRIPT_DIR")"
SLICC_SERVER_DIR="$SLICC_ROOT/sliccserver"
APP_NAME="Sliccstart"
APP_DIR="$SCRIPT_DIR/build/$APP_NAME.app"
CONTENTS="$APP_DIR/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"

# App version — set SLICCSTART_VERSION env var to override (e.g. during release)
SLICCSTART_VERSION="${SLICCSTART_VERSION:-0.1.0}"

# ---------------------------------------------------------------------------
# 1. Compile Swift binary
# ---------------------------------------------------------------------------
echo "Building $APP_NAME..."
cd "$SCRIPT_DIR"
swift build -c release 2>&1 | tail -3

echo "Building slicc-server..."
cd "$SLICC_SERVER_DIR"
swift build -c release 2>&1 | tail -3
cd "$SCRIPT_DIR"

echo "Assembling $APP_NAME.app..."
rm -rf "$APP_DIR"
mkdir -p "$MACOS" "$RESOURCES"

# Copy binary
cp ".build/release/$APP_NAME" "$MACOS/$APP_NAME"

# Copy native server runtime
cp "$SLICC_SERVER_DIR/.build/release/slicc-server" "$RESOURCES/slicc-server"
chmod +x "$RESOURCES/slicc-server"

# ---------------------------------------------------------------------------
# 2. Icon
# ---------------------------------------------------------------------------
ICON_SRC="$SCRIPT_DIR/sliccstart-icon.png"
if [ -f "$ICON_SRC" ]; then
  ICONSET="$RESOURCES/AppIcon.iconset"
  mkdir -p "$ICONSET"
  sips -z 1024 1024 "$ICON_SRC" --out "$ICONSET/icon_512x512@2x.png" 2>/dev/null
  sips -z 512 512   "$ICON_SRC" --out "$ICONSET/icon_512x512.png"    2>/dev/null
  sips -z 512 512   "$ICON_SRC" --out "$ICONSET/icon_256x256@2x.png" 2>/dev/null
  sips -z 256 256   "$ICON_SRC" --out "$ICONSET/icon_256x256.png"    2>/dev/null
  sips -z 256 256   "$ICON_SRC" --out "$ICONSET/icon_128x128@2x.png" 2>/dev/null
  sips -z 128 128   "$ICON_SRC" --out "$ICONSET/icon_128x128.png"    2>/dev/null
  sips -z 64 64     "$ICON_SRC" --out "$ICONSET/icon_32x32@2x.png"   2>/dev/null
  sips -z 32 32     "$ICON_SRC" --out "$ICONSET/icon_32x32.png"      2>/dev/null
  sips -z 32 32     "$ICON_SRC" --out "$ICONSET/icon_16x16@2x.png"   2>/dev/null
  sips -z 16 16     "$ICON_SRC" --out "$ICONSET/icon_16x16.png"      2>/dev/null
  iconutil -c icns "$ICONSET" -o "$RESOURCES/AppIcon.icns" && rm -rf "$ICONSET"
fi

# ---------------------------------------------------------------------------
# 3. Bundle SLICC UI assets
# ---------------------------------------------------------------------------
echo "Bundling SLICC UI..."
mkdir -p "$RESOURCES/slicc/dist"
cp -R "$SLICC_ROOT/dist/ui" "$RESOURCES/slicc/dist/"

# ---------------------------------------------------------------------------
# 4. Info.plist
# ---------------------------------------------------------------------------
cat > "$CONTENTS/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>Sliccstart</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleIdentifier</key>
    <string>com.slicc.sliccstart</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>Sliccstart</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${SLICCSTART_VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${SLICCSTART_VERSION}</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSSupportsAutomaticTermination</key>
    <false/>
    <key>NSSupportsSuddenTermination</key>
    <false/>
</dict>
</plist>
PLIST

# ---------------------------------------------------------------------------
# 5. Summary
# ---------------------------------------------------------------------------
BUNDLE_SIZE=$(du -sh "$APP_DIR" | cut -f1)
echo ""
echo "Built: $APP_DIR ($BUNDLE_SIZE)"
echo ""
echo "To install: cp -r $APP_DIR /Applications/"
echo "Or just double-click: open $APP_DIR"
