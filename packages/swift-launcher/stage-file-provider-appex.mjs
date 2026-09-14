













import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const FILE_PROVIDER_APPEX_NAME = 'SliccFileProvider.appex';













export function stageFileProviderAppex({
  appexSource,
  plugInsDir,
  webrtcFramework,
  appIconIcns,
}) {
  if (!existsSync(appexSource)) {
    throw new Error(`ERROR: SliccFileProvider.appex not found at ${appexSource}`);
  }
  if (!existsSync(webrtcFramework)) {
    throw new Error(
      `ERROR: WebRTC.framework not found at ${webrtcFramework}. ` +
        'The File Provider appex links it at @rpath; copy the same framework ' +
        'slicc-server uses so fileproviderd can launch the extension.'
    );
  }
  if (!existsSync(appIconIcns)) {
    throw new Error(
      `ERROR: AppIcon.icns not found at ${appIconIcns}. ` +
        'Finder Locations uses the appex icon; assemble-app must generate it first.'
    );
  }

  mkdirSync(plugInsDir, { recursive: true });
  const dest = resolve(plugInsDir, FILE_PROVIDER_APPEX_NAME);
  cpSync(appexSource, dest, { recursive: true });

  const frameworks = resolve(dest, 'Contents/Frameworks');
  mkdirSync(frameworks, { recursive: true });
  cpSync(webrtcFramework, resolve(frameworks, 'WebRTC.framework'), {
    recursive: true,
    verbatimSymlinks: true,
  });

  const resources = resolve(dest, 'Contents/Resources');
  mkdirSync(resources, { recursive: true });
  cpSync(appIconIcns, resolve(resources, 'AppIcon.icns'));

  return dest;
}
