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
