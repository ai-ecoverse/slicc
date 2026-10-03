/**
 * UI-only Cherry entry for the extension side panel.
 *
 * Same `mountSlicc` options as the public SDK, but does not import
 * `cdp-host-handlers.ts`. The panel is `uiOnly` (follower iframe, no host CDP
 * target); bundling synthetic Input/DOM handlers there blew the 14 kB
 * `sidepanel.js` budget.
 */

import type { CherryFeatures, MountSliccOptions, SliccHandle } from './index.js';
import { mountSliccImpl } from './mount.js';

export type { CherryFeatures, MountSliccOptions, SliccHandle };

export function mountSlicc(options: MountSliccOptions): SliccHandle {
  if (!options?.container && !options?.iframe) {
    throw new Error('mountSlicc: either options.container or options.iframe is required');
  }
  return mountSliccImpl(options);
}
