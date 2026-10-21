import { NUKE_CONTROL_CHANNEL } from '../../shell/supplemental-commands/nuke-channel.js';
import { planProfileDirectory } from '../../transcript/profile-export.js';
import { defaultSixLockManager, openSixUpgradeChannel } from '../six-upgrade-stop.js';
import {
  isFramedBySameOrigin,
  postToSameOriginParent,
  runSixUpgradeExport,
  SIX_UPGRADE_MESSAGE_TYPE,
} from './exporter.js';

function showIdle(): void {
  const p = document.createElement('p');
  p.textContent = 'SLICC 7 runs this page when it moves SLICC 6 into this browser.';
  document.body.replaceChildren(p);
}

async function start(): Promise<void> {
  if (!isFramedBySameOrigin(window)) {
    showIdle();
    return;
  }
  const post = postToSameOriginParent(window);
  let modules: [
    typeof import('./exporter-deps.js'),
    typeof import('../../transcript/profile-directory-opfs.js'),
  ];
  try {
    modules = await Promise.all([
      import('./exporter-deps.js'),
      import('../../transcript/profile-directory-opfs.js'),
    ]);
  } catch (err) {
    post({
      type: SIX_UPGRADE_MESSAGE_TYPE,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const [{ openUpgradeExportDeps }, { openOpfsProfileDirectory }] = modules;
  await runSixUpgradeExport({
    post,
    channel: openSixUpgradeChannel(),
    legacyReloadChannel: new BroadcastChannel(NUKE_CONTROL_CHANNEL),
    locks: defaultSixLockManager(),
    plan: async (onProgress) =>
      planProfileDirectory(await openUpgradeExportDeps(__SLICC_VERSION__), { onProgress }),
    openWriter: async (exportId) =>
      openOpfsProfileDirectory(await navigator.storage.getDirectory(), exportId),
  });
}

void start();
