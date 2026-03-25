#!/usr/bin/env node
// Assemble Sliccstart.app — a self-contained macOS app bundle
// This script does NOT compile Swift; it only assembles the .app bundle
// from already-compiled binaries.

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sliccRoot = resolve(__dirname, '../..');
const swiftServerDir = resolve(sliccRoot, 'packages/swift-server');

const APP_NAME = 'Sliccstart';
const appDir = resolve(__dirname, 'build', `${APP_NAME}.app`);
const contents = resolve(appDir, 'Contents');
const macOS = resolve(contents, 'MacOS');
const resources = resolve(contents, 'Resources');

const SLICCSTART_VERSION = process.env.SLICCSTART_VERSION || '0.1.0';

// ---------------------------------------------------------------------------
// 1. Assemble .app structure
// ---------------------------------------------------------------------------
console.log(`Assembling ${APP_NAME}.app...`);
rmSync(appDir, { recursive: true, force: true });
mkdirSync(macOS, { recursive: true });
mkdirSync(resources, { recursive: true });

// Copy Sliccstart binary
cpSync(resolve(__dirname, '.build/release', APP_NAME), resolve(macOS, APP_NAME));

// Copy slicc-server binary
const serverBin = resolve(swiftServerDir, '.build/release/slicc-server');
const serverDest = resolve(resources, 'slicc-server');
cpSync(serverBin, serverDest);
chmodSync(serverDest, 0o755);

// ---------------------------------------------------------------------------
// 2. Icon
// ---------------------------------------------------------------------------
const iconSrc = resolve(__dirname, 'sliccstart-icon.png');
if (existsSync(iconSrc)) {
  const iconset = resolve(resources, 'AppIcon.iconset');
  mkdirSync(iconset, { recursive: true });

  const sizes = [
    [1024, 'icon_512x512@2x.png'],
    [512, 'icon_512x512.png'],
    [512, 'icon_256x256@2x.png'],
    [256, 'icon_256x256.png'],
    [256, 'icon_128x128@2x.png'],
    [128, 'icon_128x128.png'],
    [64, 'icon_32x32@2x.png'],
    [32, 'icon_32x32.png'],
    [32, 'icon_16x16@2x.png'],
    [16, 'icon_16x16.png'],
  ];

  for (const [size, name] of sizes) {
    execSync(`sips -z ${size} ${size} "${iconSrc}" --out "${resolve(iconset, name)}"`, {
      stdio: 'ignore',
    });
  }

  execSync(`iconutil -c icns "${iconset}" -o "${resolve(resources, 'AppIcon.icns')}"`, {
    stdio: 'ignore',
  });
  rmSync(iconset, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3. Bundle SLICC UI assets
// ---------------------------------------------------------------------------
console.log('Bundling SLICC UI...');
const uiSrc = resolve(sliccRoot, 'dist/ui');
const uiDest = resolve(resources, 'slicc/dist/ui');
mkdirSync(dirname(uiDest), { recursive: true });
cpSync(uiSrc, uiDest, { recursive: true });

// ---------------------------------------------------------------------------
// 4. Info.plist
// ---------------------------------------------------------------------------
const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
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
`;
writeFileSync(resolve(contents, 'Info.plist'), infoPlist);

// ---------------------------------------------------------------------------
// 5. Summary
// ---------------------------------------------------------------------------
const bundleSize = execSync(`du -sh "${appDir}"`, { encoding: 'utf8' }).split('\t')[0];
console.log('');
console.log(`Built: ${appDir} (${bundleSize})`);
console.log('');
console.log(`To install: cp -r ${appDir} /Applications/`);
console.log(`Or just double-click: open ${appDir}`);

