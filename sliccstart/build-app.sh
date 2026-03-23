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

# Node.js version to bundle (LTS 24.x)
NODE_VERSION="${NODE_VERSION:-24.14.0}"
NODE_CACHE="$SCRIPT_DIR/.node-cache"

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
# 3. Bundle Node.js
# ---------------------------------------------------------------------------
echo "Bundling Node.js v${NODE_VERSION}..."
mkdir -p "$NODE_CACHE" "$RESOURCES/node/bin"

ARCH="$(uname -m)"
if [ "$ARCH" = "x86_64" ]; then
  NODE_ARCH="x64"
else
  NODE_ARCH="arm64"
fi

NODE_TARBALL="node-v${NODE_VERSION}-darwin-${NODE_ARCH}.tar.xz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"

if [ ! -f "$NODE_CACHE/$NODE_TARBALL" ]; then
  echo "  Downloading $NODE_TARBALL..."
  curl -fsSL "$NODE_URL" -o "$NODE_CACHE/$NODE_TARBALL"
fi

NODE_EXTRACTED="$NODE_CACHE/node-v${NODE_VERSION}-darwin-${NODE_ARCH}"
if [ ! -d "$NODE_EXTRACTED" ]; then
  tar -xf "$NODE_CACHE/$NODE_TARBALL" -C "$NODE_CACHE"
fi

cp "$NODE_EXTRACTED/bin/node" "$RESOURCES/node/bin/node"
chmod +x "$RESOURCES/node/bin/node"

# ---------------------------------------------------------------------------
# 4. Bundle SLICC dist + runtime node_modules
# ---------------------------------------------------------------------------
echo "Bundling SLICC runtime..."
SLICC_BUNDLE="$RESOURCES/slicc"
mkdir -p "$SLICC_BUNDLE/dist"

# Copy built dist directories
cp -R "$SLICC_ROOT/dist/cli"       "$SLICC_BUNDLE/dist/"
cp -R "$SLICC_ROOT/dist/ui"        "$SLICC_BUNDLE/dist/"
if [ -d "$SLICC_ROOT/dist/extension" ]; then
  cp -R "$SLICC_ROOT/dist/extension" "$SLICC_BUNDLE/dist/"
fi
# Copy top-level dist files (e.g. tray-url-shared.js imported by dist/cli/)
for f in "$SLICC_ROOT"/dist/*.js; do
  [ -f "$f" ] && cp "$f" "$SLICC_BUNDLE/dist/"
done

# Minimal package.json for module resolution
cat > "$SLICC_BUNDLE/package.json" << 'PKG'
{"name":"sliccy","version":"0.1.0","type":"module"}
PKG

# Install only the runtime dependencies the CLI needs
echo "  Installing runtime node_modules..."
BUNDLED_NPM="$NODE_EXTRACTED/bin/npm"
BUNDLED_NODE="$RESOURCES/node/bin/node"

# express and ws are imported by dist/cli at runtime
# @electron/fuses and @electron/asar are needed by DebugBuildCreator
(
  cd "$SLICC_BUNDLE"
  NODE_PATH="" "$BUNDLED_NODE" "$BUNDLED_NPM" install --omit=dev --no-audit --no-fund \
    "express@^4.21.2" ws @electron/fuses @electron/asar 2>&1 | tail -3
)

# Prune docs, types, and test fixtures from node_modules
echo "  Pruning node_modules..."
find "$SLICC_BUNDLE/node_modules" \( \
  -name "*.md" -o -name "*.ts" -o -name "*.map" -o \
  -name "LICENSE*" -o -name "CHANGELOG*" -o -name "HISTORY*" -o \
  -name ".eslintrc*" -o -name ".prettierrc*" -o -name "tsconfig.json" -o \
  -name "Makefile" -o -name ".travis.yml" -o -name ".github" -o \
  -name "test" -o -name "tests" -o -name "__tests__" -o -name "example" -o -name "examples" \
\) -exec rm -rf {} + 2>/dev/null || true

# ---------------------------------------------------------------------------
# 5. Info.plist
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
# 6. Summary
# ---------------------------------------------------------------------------
BUNDLE_SIZE=$(du -sh "$APP_DIR" | cut -f1)
echo ""
echo "Built: $APP_DIR ($BUNDLE_SIZE)"
echo ""
echo "To install: cp -r $APP_DIR /Applications/"
echo "Or just double-click: open $APP_DIR"
