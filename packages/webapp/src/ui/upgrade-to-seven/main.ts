/**
 * Entry for `/upgrade-to-seven.html` (slicc#4051): seven's BIOS runs it in a
 * hidden same-origin frame to move this browser's six profile into seven in
 * place. Registers no service worker and boots no kernel; see `exporter.ts`.
 * Opened any other way (top level, or framed by another origin) it does
 * nothing.
 */

import { NUKE_CONTROL_CHANNEL } from '../../shell/supplemental-commands/nuke-channel.js';
import { planProfileDirectory } from '../../transcript/profile-export.js';
import { defaultSixLockManager, openSixUpgradeChannel } from '../six-upgrade-stop.js';
import { isFramedBySameOrigin, postToSameOriginParent, runSixUpgradeExport } from './exporter.js';

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
  const [{ openUpgradeExportDeps }, { openOpfsProfileDirectory }] = await Promise.all([
    import('./exporter-deps.js'),
    import('../../transcript/profile-directory-opfs.js'),
  ]);
  await runSixUpgradeExport({
    post: postToSameOriginParent(window),
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
