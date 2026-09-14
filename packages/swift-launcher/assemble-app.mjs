#!/usr/bin/env node




import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyElectronOverlayEntry } from './copy-overlay-entry.mjs';
import { stageFileProviderAppex } from './stage-file-provider-appex.mjs';
import { stageWidgetAppex } from './stage-widget-appex.mjs';
import { buildIcns, buildIconAssetCatalog } from './build-app-icon.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sliccRoot = resolve(__dirname, '../..');
const swiftServerDir = resolve(sliccRoot, 'packages/swift-server');

const APP_NAME = 'Sliccstart';
const appDir = resolve(__dirname, 'build', `${APP_NAME}.app`);
const contents = resolve(appDir, 'Contents');
const macOS = resolve(contents, 'MacOS');
const resources = resolve(contents, 'Resources');

const SLICCSTART_VERSION = process.env.SLICCSTART_VERSION || '0.1.0';




const MACOS_ICON_DEPLOYMENT_TARGET = '26.0';




console.log(`Assembling ${APP_NAME}.app...`);
rmSync(appDir, { recursive: true, force: true });
mkdirSync(macOS, { recursive: true });
mkdirSync(resources, { recursive: true });


const sliccstartBin = resolve(macOS, APP_NAME);
cpSync(resolve(__dirname, '.build/release', APP_NAME), sliccstartBin);




try {
  execSync(`install_name_tool -add_rpath @executable_path/../Resources "${sliccstartBin}"`, {
    stdio: 'pipe',
  });
} catch {
  
}


const serverBin = resolve(swiftServerDir, '.build/release/slicc-server');
const serverDest = resolve(resources, 'slicc-server');
cpSync(serverBin, serverDest);
chmodSync(serverDest, 0o755);












const webrtcFramework = resolve(swiftServerDir, '.build/release/WebRTC.framework');
if (!existsSync(webrtcFramework)) {
  console.error(
    `ERROR: WebRTC.framework not found at ${webrtcFramework}. ` +
      `Build the release server first: (cd packages/swift-server && swift build -c release)`
  );
  process.exit(1);
}
cpSync(webrtcFramework, resolve(resources, 'WebRTC.framework'), {
  recursive: true,
  verbatimSymlinks: true,
});
console.log('Copied WebRTC.framework into Resources/');








const iconSrc = resolve(
  __dirname,
  '../../packages/assets/logos/macos-icon-iOS-Default-1024x1024@1x.png'
);
buildIcns({ iconSrc, resourcesDir: resources });
console.log('Built AppIcon.icns');

const iconBundle = resolve(__dirname, '../../packages/assets/logos/macos-icon.icon');
const iconCatalog = buildIconAssetCatalog({
  iconBundle,
  resourcesDir: resources,
  deploymentTarget: MACOS_ICON_DEPLOYMENT_TARGET,
});
if (iconCatalog.built) {
  console.log(`Compiled ${iconBundle.replace(/.*\//, '')} -> Assets.car (Dark/Tinted appearances)`);
} else {
  console.warn(
    `WARNING: appearance-keyed app icon skipped - ${iconCatalog.skipped}. ` +
      'The bundle falls back to the single-appearance AppIcon.icns.'
  );
}








console.log('Creating SLICC runtime marker dir...');
mkdirSync(resolve(resources, 'slicc'), { recursive: true });






const overlayDest = copyElectronOverlayEntry({
  distUiDir: resolve(sliccRoot, 'dist/ui'),
  resourcesDir: resources,
});
console.log(`Copied Electron overlay bootstrap: ${overlayDest}`);




const fileProviderProject = resolve(__dirname, 'SliccstartFileProvider.xcodeproj');
const fileProviderAppex = resolve(
  __dirname,
  'build/DerivedData/Build/Products/Release/SliccFileProvider.appex'
);
if (existsSync(resolve(__dirname, 'project.yml'))) {
  console.log('Building SliccFileProvider appex...');
  execSync('xcodegen generate', { cwd: __dirname, stdio: 'inherit' });
  execSync(
    [
      'xcodebuild build',
      `-project "${fileProviderProject}"`,
      '-scheme SliccFileProvider',
      '-configuration Release',
      `-derivedDataPath "${resolve(__dirname, 'build/DerivedData')}"`,
      'CODE_SIGNING_ALLOWED=NO',
      'ONLY_ACTIVE_ARCH=NO',
    ].join(' '),
    { cwd: __dirname, stdio: 'inherit' }
  );
  const plugIns = resolve(contents, 'PlugIns');
  
  
  
  stageFileProviderAppex({
    appexSource: fileProviderAppex,
    plugInsDir: plugIns,
    webrtcFramework: resolve(resources, 'WebRTC.framework'),
    appIconIcns: resolve(resources, 'AppIcon.icns'),
  });
  console.log('Copied SliccFileProvider.appex into Contents/PlugIns/ (WebRTC + AppIcon embedded)');

  
  console.log('Building SliccstartWidgets appex...');
  execSync(
    [
      'xcodebuild build',
      `-project "${fileProviderProject}"`,
      '-scheme SliccstartWidgets',
      '-configuration Release',
      `-derivedDataPath "${resolve(__dirname, 'build/DerivedData')}"`,
      'CODE_SIGNING_ALLOWED=NO',
      'ONLY_ACTIVE_ARCH=NO',
    ].join(' '),
    { cwd: __dirname, stdio: 'inherit' }
  );
  stageWidgetAppex({
    appexSource: resolve(
      __dirname,
      'build/DerivedData/Build/Products/Release/SliccstartWidgets.appex'
    ),
    plugInsDir: plugIns,
  });
  console.log('Copied SliccstartWidgets.appex into Contents/PlugIns/');
} else {
  console.warn('WARN: project.yml missing — skipping File Provider and widget appexes');
}




const creditsSrc = resolve(__dirname, 'Sliccstart/Resources/Credits.html');
if (!existsSync(creditsSrc)) {
  console.error(`ERROR: Credits.html not found: ${creditsSrc}`);
  process.exit(1);
}
cpSync(creditsSrc, resolve(resources, 'Credits.html'));
console.log('Copied Credits.html');




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
${
      iconCatalog.built
        ? `    <key>CFBundleIconName</key>\n    <string>${iconCatalog.iconName}</string>\n`
        : ''
    }    <key>CFBundleIdentifier</key>
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
    <key>NSCameraUsageDescription</key>
    <string>Slicc launches Google Chrome to host the assistant UI. Chrome — not Slicc — uses the camera for sites you visit (Google Meet, Zoom, etc.). Grant access if you want camera-enabled sites to work inside Slicc.</string>
    <key>NSMicrophoneUsageDescription</key>
    <string>Slicc launches Google Chrome to host the assistant UI. Chrome — not Slicc — uses the microphone for sites you visit (Google Meet, Zoom, etc.). Grant access if you want microphone-enabled sites to work inside Slicc.</string>
    <key>NSAppleEventsUsageDescription</key>
    <string>Sliccstart uses Apple Events to open a new Terminal or iTerm2 window and attach it to your running SLICC session.</string>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>Web site URL</string>
            <key>CFBundleTypeRole</key>
            <string>Viewer</string>
            <key>CFBundleURLSchemes</key>
            <array>
                <string>http</string>
                <string>https</string>
            </array>
        </dict>
    </array>
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeName</key>
            <string>HTML document</string>
            <key>CFBundleTypeRole</key>
            <string>Viewer</string>
            <key>LSHandlerRank</key>
            <string>Alternate</string>
            <key>LSItemContentTypes</key>
            <array>
                <string>public.html</string>
                <string>public.xhtml</string>
            </array>
        </dict>
    </array>
</dict>
</plist>
`;
writeFileSync(resolve(contents, 'Info.plist'), infoPlist);




const bundleSize = execSync(`du -sh "${appDir}"`, { encoding: 'utf8' }).split('\t')[0];
console.log('');
console.log(`Built: ${appDir} (${bundleSize})`);
console.log('');
console.log(`To install: cp -r ${appDir} /Applications/`);
console.log(`Or just double-click: open ${appDir}`);
