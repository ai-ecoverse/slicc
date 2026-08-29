/**
 * Module-level hook so the kernel worker's `layout` command (over the
 * `layout-apply` panel-RPC op) can reach the page-side `applyLayout`.
 * Mirrors the `setPreviewMinter` / `getPreviewMinter` precedent in
 * `packages/webapp/src/shell/preview-minter.ts`: a module-level `let`,
 * a `setX(fn | null)`, and a `getX()`.
 *
 * Registered in the shared WC boot path (`wc-live.ts` `attachWcClient`),
 * so both floats' applier side is covered — standalone via wc-live's own
 * boot, extension via `wc-extension.ts` reusing `attachWcClient`.
 */

import type { LayoutApplyMsg } from '../../shell/supplemental-commands/layout-command.js';

/**
 * What the page reports back for one verb.
 *
 * The dock-tree verbs are fire-and-forget, but the layout-DOCUMENT verbs
 * (`docs`/`panels`/`save`/`load`) have to return text or an error: only the page
 * can read the VFS, the panel registry, or the arrangement on screen.
 */
export interface LayoutApplyResult {
  applied: boolean;
  output?: string;
  error?: string;
}

/**
 * `void` keeps the original fire-and-forget shape valid, so the existing
 * dock-tree applier needs no change; document-aware appliers return a result.
 */
export type LayoutApplier = (
  msg: LayoutApplyMsg
) => void | LayoutApplyResult | Promise<LayoutApplyResult | void>;

let layoutApplier: LayoutApplier | null = null;

export function setLayoutApplier(fn: LayoutApplier | null): void {
  layoutApplier = fn;
}

export function getLayoutApplier(): LayoutApplier | null {
  return layoutApplier;
}
