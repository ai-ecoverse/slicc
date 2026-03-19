#!/bin/bash
# Build Sliccstart.app — a proper macOS app bundle you can double-click
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SLICC_ROOT="$(dirname "$SCRIPT_DIR")"
APP_NAME="Sliccstart"
APP_DIR="$SCRIPT_DIR/build/$APP_NAME.app"
CONTENTS="$APP_DIR/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"

echo "Building $APP_NAME..."
cd "$SCRIPT_DIR"
swift build -c release 2>&1 | tail -3

echo "Assembling $APP_NAME.app..."
rm -rf "$APP_DIR"
mkdir -p "$MACOS" "$RESOURCES"

# Copy binary
cp ".build/release/$APP_NAME" "$MACOS/$APP_NAME"

# Convert icon to icns with all required sizes
ICON_SRC="$SCRIPT_DIR/sliccstart-icon.jpg"
if [ -f "$ICON_SRC" ]; then
  ICONSET="$RESOURCES/AppIcon.iconset"
  mkdir -p "$ICONSET"
  # Convert to PNG and resize to all required sizes
  sips -s format png -z 1024 1024 "$ICON_SRC" --out "$ICONSET/icon_512x512@2x.png" 2>/dev/null
  sips -s format png -z 512 512   "$ICON_SRC" --out "$ICONSET/icon_512x512.png"    2>/dev/null
  sips -s format png -z 512 512   "$ICON_SRC" --out "$ICONSET/icon_256x256@2x.png" 2>/dev/null
  sips -s format png -z 256 256   "$ICON_SRC" --out "$ICONSET/icon_256x256.png"    2>/dev/null
  sips -s format png -z 256 256   "$ICON_SRC" --out "$ICONSET/icon_128x128@2x.png" 2>/dev/null
  sips -s format png -z 128 128   "$ICON_SRC" --out "$ICONSET/icon_128x128.png"    2>/dev/null
  sips -s format png -z 64 64     "$ICON_SRC" --out "$ICONSET/icon_32x32@2x.png"   2>/dev/null
  sips -s format png -z 32 32     "$ICON_SRC" --out "$ICONSET/icon_32x32.png"      2>/dev/null
  sips -s format png -z 32 32     "$ICON_SRC" --out "$ICONSET/icon_16x16@2x.png"   2>/dev/null
  sips -s format png -z 16 16     "$ICON_SRC" --out "$ICONSET/icon_16x16.png"      2>/dev/null
  iconutil -c icns "$ICONSET" -o "$RESOURCES/AppIcon.icns" && rm -rf "$ICONSET"
fi

# Create Info.plist
cat > "$CONTENTS/Info.plist" << 'PLIST'
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
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSSupportsAutomaticTermination</key>
    <true/>
    <key>NSSupportsSuddenTermination</key>
    <true/>
</dict>
</plist>
PLIST

echo ""
echo "Built: $APP_DIR"
echo ""
echo "To install: cp -r $APP_DIR /Applications/"
echo "Or just double-click: open $APP_DIR"
