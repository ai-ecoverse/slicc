/**
 * `layout` — manage the workbench UI layout: switch presets, open/close/move
 * a panel (chat, a tool panel, or a sprinkle) into a zone, resize a placed
 * panel by pixel or percent, reset. `layout edit` is a friendly alias for
 * `layout set focus` (the dock-tree editor is now the only layout system —
 * there is no separate "editor mode" to enter). This is the agent-facing
 * surface for arranging panels programmatically — `open`/`close`/`move`/
 * `size` are thin wrappers over `<slicc-dock-tree>`'s own
 * `placeSurface`/`removeSurface`/`moveSurfaceToZone`/`setSurfaceSize`.
 *
 * Runs in the kernel worker (no DOM). Parses args into a
 * `LayoutApplyMsg` and forwards it to the page over panel-RPC
 * (`layout-apply` op — the page-side workbench renderer owns applying
 * it; see `packages/webapp/src/kernel/panel-rpc.ts`).
 *
 * `parseLayoutArgs` is pure and is the unit-test seam.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import {
  DEFAULT_LAYOUT,
  type DockTreeSpecLike,
  type DockZoneName,
  getPreset,
  LAYOUT_PRESETS,
  type SurfaceSizeSpecLike,
} from '../../core/dock-tree-spec.js';
import { getPanelRpcClient } from '../../kernel/panel-rpc.js';

const ZONE_NAMES: readonly DockZoneName[] = ['top', 'left', 'middle', 'right', 'bottom'];

/**
 * `chat`, the fixed tool-panel ids, and the `sprinkle:` prefix — redeclared here
 * rather than imported from `wc-sprinkles.ts`, which lives in `ui/`: this module runs
 * in the kernel worker (no DOM), and the layer stack forbids `shell/` importing
 * `ui/`. The spec types come from `core/dock-tree-spec.ts` for the same reason.
 */
const CHAT_SURFACE_ID = 'chat';
const TOOL_PANEL_IDS: ReadonlySet<string> = new Set(['files', 'term', 'memory', 'monitor']);
const SPRINKLE_PREFIX = 'sprinkle:';

/**
 * Accept a bare sprinkle name (e.g. `weather`) and normalize it to its full
 * surfaceId (`sprinkle:weather`) so agents don't need to know the internal
 * prefix; `chat`, a tool-panel id, or an already-prefixed id passes through
 * unchanged.
 */
function normalizeSurfaceId(raw: string): string {
  if (raw === CHAT_SURFACE_ID || TOOL_PANEL_IDS.has(raw) || raw.startsWith(SPRINKLE_PREFIX)) {
    return raw;
  }
  return `${SPRINKLE_PREFIX}${raw}`;
}

/** Parse a size token: `<number>%` → percent, `<number>` or `<number>px` → pixels. */
function parseSizeToken(raw: string): { px?: number; percent?: number } | null {
  const pct = /^(\d+(?:\.\d+)?)%$/.exec(raw);
  if (pct) return { percent: Number.parseFloat(pct[1]) };
  const px = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(raw);
  if (px) return { px: Number.parseFloat(px[1]) };
  return null;
}

export type LayoutApplyMsg =
  | { kind: 'set'; tree: DockTreeSpecLike }
  | { kind: 'chat'; zone: DockZoneName }
  | { kind: 'open'; surfaceId: string; zone: DockZoneName }
  | { kind: 'close'; surfaceId: string }
  | { kind: 'move'; surfaceId: string; zone: DockZoneName }
  | { kind: 'size'; surfaceId: string; size: SurfaceSizeSpecLike }
  | { kind: 'reset' };

const SIZE_USAGE = 'usage: layout size <surfaceId> [--width <px|percent>] [--height <px|percent>]';

function parseSet(rest: string[]): LayoutApplyMsg | { error: string } {
  const name = rest[0];
  const preset = name ? getPreset(name) : null;
  if (!preset) return { error: `unknown layout: ${name ?? '(none)'}` };
  return { kind: 'set', tree: preset.tree };
}

function parseChat(rest: string[]): LayoutApplyMsg | { error: string } {
  const zone = rest[0];
  if (!ZONE_NAMES.includes(zone as DockZoneName)) {
    return { error: `usage: layout chat <${ZONE_NAMES.join('|')}>` };
  }
  return { kind: 'chat', zone: zone as DockZoneName };
}

function parseOpen(rest: string[]): LayoutApplyMsg | { error: string } {
  const [surfaceId, zone] = rest;
  if (!surfaceId || !ZONE_NAMES.includes(zone as DockZoneName)) {
    return { error: `usage: layout open <surfaceId> <${ZONE_NAMES.join('|')}>` };
  }
  return { kind: 'open', surfaceId: normalizeSurfaceId(surfaceId), zone: zone as DockZoneName };
}

function parseClose(rest: string[]): LayoutApplyMsg | { error: string } {
  const surfaceId = rest[0];
  if (!surfaceId) return { error: 'usage: layout close <surfaceId>' };
  return { kind: 'close', surfaceId: normalizeSurfaceId(surfaceId) };
}

function parseMove(rest: string[]): LayoutApplyMsg | { error: string } {
  const [surfaceId, zone] = rest;
  if (!surfaceId || !ZONE_NAMES.includes(zone as DockZoneName)) {
    return { error: `usage: layout move <surfaceId> <${ZONE_NAMES.join('|')}>` };
  }
  return { kind: 'move', surfaceId: normalizeSurfaceId(surfaceId), zone: zone as DockZoneName };
}

/** Apply one `--width`/`--height` flag+value pair onto `size`, or return an error. */
function applySizeFlag(
  size: SurfaceSizeSpecLike,
  flag: string,
  value: string | undefined
): { error: string } | null {
  if (flag !== '--width' && flag !== '--height')
    return { error: `layout size: unknown flag "${flag}"` };
  if (!value) return { error: `layout size: missing value for ${flag}` };
  const token = parseSizeToken(value);
  if (!token)
    return { error: `layout size: invalid size "${value}" (want <number>px or <number>%)` };
  if (flag === '--width') {
    if (token.percent != null) size.widthPercent = token.percent;
    else size.widthPx = token.px;
  } else {
    if (token.percent != null) size.heightPercent = token.percent;
    else size.heightPx = token.px;
  }
  return null;
}

function parseSize(rest: string[]): LayoutApplyMsg | { error: string } {
  const surfaceId = rest[0];
  if (!surfaceId) return { error: SIZE_USAGE };
  const size: SurfaceSizeSpecLike = {};
  for (let i = 1; i < rest.length; i += 2) {
    const err = applySizeFlag(size, rest[i], rest[i + 1]);
    if (err) return err;
  }
  if (
    size.widthPx == null &&
    size.widthPercent == null &&
    size.heightPx == null &&
    size.heightPercent == null
  ) {
    return { error: SIZE_USAGE };
  }
  return { kind: 'size', surfaceId: normalizeSurfaceId(surfaceId), size };
}

function parseEdit(): LayoutApplyMsg | { error: string } {
  // Friendly alias: `layout edit` === `layout set focus` — the dock-tree is
  // always active, so there is no separate editor mode to enter.
  const preset = getPreset(DEFAULT_LAYOUT);
  if (!preset) return { error: 'default layout unavailable' };
  return { kind: 'set', tree: preset.tree };
}

/** Pure arg parser — the unit-test seam. */
export function parseLayoutArgs(args: string[]): LayoutApplyMsg | { error: string } {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'set':
      return parseSet(rest);
    case 'chat':
      return parseChat(rest);
    case 'open':
      return parseOpen(rest);
    case 'close':
      return parseClose(rest);
    case 'move':
      return parseMove(rest);
    case 'size':
      return parseSize(rest);
    case 'reset':
      return { kind: 'reset' };
    case 'edit':
      return parseEdit();
    default:
      return { error: 'usage: layout <set|edit|chat|open|close|move|size|list|reset>' };
  }
}

export function createLayoutCommand(): Command {
  return defineCommand('layout', async (args) => {
    if (args[0] === 'list' || args.length === 0) {
      const names = Object.keys(LAYOUT_PRESETS).join(', ');
      return {
        stdout: `layouts: ${names}\ndefault: ${DEFAULT_LAYOUT}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    const parsed = parseLayoutArgs(args);
    if ('error' in parsed) return { stdout: '', stderr: `layout: ${parsed.error}\n`, exitCode: 1 };

    const panelRpc = getPanelRpcClient();
    if (!panelRpc) {
      return { stdout: '', stderr: 'layout: UI is unavailable in this environment\n', exitCode: 1 };
    }
    try {
      await panelRpc.call('layout-apply', parsed);
      return { stdout: '', stderr: '', exitCode: 0 };
    } catch (err) {
      return { stdout: '', stderr: `layout: ${(err as Error).message}\n`, exitCode: 1 };
    }
  });
}
