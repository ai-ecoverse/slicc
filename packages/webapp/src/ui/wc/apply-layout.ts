/**
 * Apply a layout action to the live shell — the page-side counterpart of the
 * `layout` shell command (delivered over the `layout-apply` panel-RPC op).
 * Mirrors `applyShellContext` (the theme-mood switcher): a pure function over
 * the sprinkle zone. The dock-tree is the only layout system, so `set`/`reset`
 * just load a tree and `chat` moves the pinned chat leaf to a different zone
 * — there is no separate chat-placement/fraction concept anymore.
 *
 * This lives in its own module (not `wc-shell.ts`) so it can be imported and
 * unit-tested WITHOUT pulling in the `@slicc/webcomponents` barrel that
 * `wc-shell.ts` side-effect-imports (which needs a DOM the node test env
 * lacks). `WcSprinkleZone` is imported type-only, so it is erased at runtime
 * and carries no such dependency.
 */

import type { LayoutApplyMsg } from '../../shell/supplemental-commands/layout-command.js';
import { DEFAULT_LAYOUT, getPreset } from './layout-spec.js';
import type { WcSprinkleZone } from './wc-sprinkles.js';
import { CHAT_SURFACE_ID } from './wc-sprinkles.js';

export function applyLayout(zone: WcSprinkleZone, msg: LayoutApplyMsg): void {
  switch (msg.kind) {
    case 'set':
      zone.applyLayout(msg.tree);
      break;
    case 'reset': {
      const preset = getPreset(DEFAULT_LAYOUT);
      if (preset) zone.applyLayout(preset.tree);
      break;
    }
    case 'chat':
      zone.moveSurfaceToZone(CHAT_SURFACE_ID, msg.zone);
      break;
    case 'open':
      zone.placeSurface(msg.zone, msg.surfaceId);
      break;
    case 'close':
      zone.removeSurface(msg.surfaceId);
      break;
    case 'move':
      zone.moveSurfaceToZone(msg.surfaceId, msg.zone);
      break;
    case 'size':
      zone.setSurfaceSize(msg.surfaceId, msg.size);
      break;
  }
}
