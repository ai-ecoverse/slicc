/**
 * `layout` — manage the workbench UI layout: switch presets, open/close/move
 * a panel (chat, a tool panel, or a sprinkle) into a zone, resize a placed
 * panel by pixel or percent, reset. There is NO edit mode to enter: panels are
 * always rearrangeable, by the user (grab a panel's move button, which reveals
 * every position it can take) or by this command. `layout edit` remains only as
 * a backwards-compatible alias for `layout set focus`. This is the agent-facing
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
} from '../../base/dock-tree-spec.js';
import { getPanelRpcClient } from '../../kernel/panel-rpc.js';
import { isHelpRequest, subcommandHelpText } from './subcommand-help.js';

const ZONE_NAMES: readonly DockZoneName[] = ['top', 'left', 'middle', 'right', 'bottom'];

const HELP = `usage: layout <verb> [args]

  list                          List the built-in presets
  set <preset>                  Switch to a built-in preset
  chat <zone>                   Move the chat panel to a zone
  open <surfaceId> <zone>       Place a panel or sprinkle in a zone
  close <surfaceId>             Remove a placed panel
  move <surfaceId> <zone>       Move a placed panel to another zone
  size <surfaceId> [--width <n>px|<n>%] [--height <n>px|<n>%]
                                Resize a placed panel
  show <panelId>                Reveal a hidden panel
  hide <panelId>                Hide a placed panel
  save <name> [--protected]     Persist the current arrangement
  load <name>                   Restore a saved arrangement
  delete <name>                 Delete a saved arrangement
  reset                         Restore the default arrangement
  edit                          Alias for \`layout set ${DEFAULT_LAYOUT}\` (there is no edit mode)
  docs                          Describe the layout surfaces
  panels                        List the registered panel ids

Zones: ${ZONE_NAMES.join(', ')}
`;

/**
 * `chat`, the fixed tool-panel ids, and the `sprinkle:` prefix — redeclared here
 * rather than imported from `wc-sprinkles.ts`, which lives in `ui/`: this module runs
 * in the kernel worker (no DOM), and the layer stack forbids `shell/` importing
 * `ui/`. The spec types come from `base/dock-tree-spec.ts` for the same reason.
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
  | { kind: 'reset' }
  // Layout-document verbs (Phase 4). `load` takes a saved-layout name OR a
  // shipped preset name — the page resolves which, since only it can read the
  // VFS and the registry. `save` persists the CURRENT arrangement, which only
  // the page knows, so the worker just forwards the intent.
  | { kind: 'load'; name: string }
  | { kind: 'save'; name: string; protected: boolean }
  | { kind: 'delete'; name: string }
  | { kind: 'docs' }
  | { kind: 'panels' }
  | { kind: 'show'; panelId: string }
  | { kind: 'hide'; panelId: string };

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

/** `layout save <name> [--protected]` — persist the current arrangement. */
function parseSave(rest: string[]): LayoutApplyMsg | { error: string } {
  const name = rest[0];
  if (!name || name.startsWith('--')) {
    return { error: 'usage: layout save <name> [--protected]' };
  }
  if (!/^[\w.-]+$/.test(name)) {
    // The name becomes a filename; refuse separators rather than silently
    // writing outside the layouts directory.
    return { error: `invalid layout name "${name}" (use letters, digits, . _ -)` };
  }
  const flags = rest.slice(1);
  const unknown = flags.find((f) => f !== '--protected');
  if (unknown) return { error: `layout save: unknown flag "${unknown}"` };
  return { kind: 'save', name, protected: flags.includes('--protected') };
}

function parseNamed(kind: 'load' | 'delete', rest: string[]): LayoutApplyMsg | { error: string } {
  const name = rest[0];
  if (!name) return { error: `usage: layout ${kind} <name>` };
  return kind === 'load' ? { kind: 'load', name } : { kind: 'delete', name };
}

function parsePanelToggle(
  kind: 'show' | 'hide',
  rest: string[]
): LayoutApplyMsg | { error: string } {
  const panelId = rest[0];
  if (!panelId) return { error: `usage: layout ${kind} <panelId>` };
  return kind === 'show'
    ? { kind: 'show', panelId: normalizeSurfaceId(panelId) }
    : { kind: 'hide', panelId: normalizeSurfaceId(panelId) };
}

function parseEdit(): LayoutApplyMsg | { error: string } {
  // Backwards-compatible alias only: `layout edit` === `layout set focus`. There
  // is no editor mode — moving and resizing are always available, so a verb that
  // "enters editing" has nothing to turn on.
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
    case 'load':
      return parseNamed('load', rest);
    case 'save':
      return parseSave(rest);
    case 'delete':
      return parseNamed('delete', rest);
    case 'docs':
      return { kind: 'docs' };
    case 'panels':
      return { kind: 'panels' };
    case 'show':
      return parsePanelToggle('show', rest);
    case 'hide':
      return parsePanelToggle('hide', rest);
    default:
      return {
        error:
          'usage: layout <set|edit|chat|open|close|move|size|show|hide|load|save|delete|docs|panels|list|reset>',
      };
  }
}

export function createLayoutCommand(): Command {
  return defineCommand('layout', async (args) => {
    if (isHelpRequest(args)) {
      // Help before parsing: `reset` and `edit` ignore their remaining
      // args, so `layout reset --help` used to rearrange the workbench.
      const stdout = args[0]?.startsWith('-') ? HELP : subcommandHelpText('layout', args[0], HELP);
      return { stdout, stderr: '', exitCode: 0 };
    }
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
      const result = await panelRpc.call('layout-apply', parsed);
      // Read-only/report verbs (`docs`, `panels`, `save`) come back with text to
      // print: only the page can enumerate the VFS, the registry, or report where
      // a save landed. A verb the page could not carry out reports `applied:
      // false` with a reason rather than silently succeeding.
      if (result && result.applied === false) {
        return {
          stdout: '',
          stderr: `layout: ${result.error ?? 'could not apply layout'}\n`,
          exitCode: 1,
        };
      }
      const output = result?.output;
      return { stdout: output ? `${output.replace(/\n*$/, '')}\n` : '', stderr: '', exitCode: 0 };
    } catch (err) {
      return { stdout: '', stderr: `layout: ${(err as Error).message}\n`, exitCode: 1 };
    }
  });
}
