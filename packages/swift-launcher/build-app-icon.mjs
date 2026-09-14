






















import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';


export const ICNS_SIZES = [
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









export function findActool(run = defaultRun) {
  try {
    const found = run('xcrun', ['--find', 'actool']).trim();
    return found.length > 0 ? found : null;
  } catch {
    return null;
  }
}










export function buildIcns({ iconSrc, resourcesDir, run = defaultRun }) {
  if (!existsSync(iconSrc)) {
    throw new Error(`ERROR: Icon source not found: ${iconSrc}`);
  }
  const iconset = resolve(resourcesDir, 'AppIcon.iconset');
  mkdirSync(iconset, { recursive: true });
  for (const [size, name] of ICNS_SIZES) {
    run('sips', ['-z', String(size), String(size), iconSrc, '--out', resolve(iconset, name)]);
  }
  const icns = resolve(resourcesDir, 'AppIcon.icns');
  run('iconutil', ['-c', 'icns', iconset, '-o', icns]);
  rmSync(iconset, { recursive: true, force: true });
  return icns;
}
















export function buildIconAssetCatalog({
  iconBundle,
  resourcesDir,
  deploymentTarget,
  run = defaultRun,
}) {
  if (!existsSync(iconBundle)) {
    throw new Error(`ERROR: Icon Composer bundle not found: ${iconBundle}`);
  }
  const actool = findActool(run);
  if (!actool) {
    return { built: false, skipped: 'actool not found (Xcode not installed)' };
  }
  
  
  
  const iconName = iconBundle.replace(/.*\//, '').replace(/\.icon$/, '');
  const partialPlist = resolve(resourcesDir, 'actool-partial.plist');
  try {
    run(actool, [
      iconBundle,
      '--compile',
      resourcesDir,
      '--platform',
      'macosx',
      '--minimum-deployment-target',
      deploymentTarget,
      '--app-icon',
      iconName,
      '--output-partial-info-plist',
      partialPlist,
    ]);
  } catch (err) {
    
    
    
    
    
    
    rmSync(partialPlist, { force: true });
    return { built: false, skipped: `actool could not compile ${iconName}.icon: ${errText(err)}` };
  }
  rmSync(partialPlist, { force: true });
  if (!existsSync(resolve(resourcesDir, 'Assets.car'))) {
    return { built: false, skipped: 'actool produced no Assets.car' };
  }
  
  
  
  rmSync(resolve(resourcesDir, `${iconName}.icns`), { force: true });
  return { built: true, iconName };
}








function errText(err) {
  const stderr =  (err)?.stderr;
  const text = String(stderr || (err instanceof Error ? err.message : err) || 'unknown error');
  return text.trim().split('\n').slice(0, 3).join(' ').slice(0, 300);
}


function defaultRun(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
