/**
 * Module-level hook so the kernel worker's `layout` command (over the
 * `layout-apply` panel-RPC op) can reach the page-side `applyLayout`.
 * Mirrors the `setPreviewMinter` / `getPreviewMinter` precedent in
 * `packages/webapp/src/scoops/preview-minter.ts`: a module-level `let`,
 * a `setX(fn | null)`, and a `getX()`.
 *
 * Registered in the shared WC boot path (`wc-live.ts` `attachWcClient`),
 * so both floats' applier side is covered — standalone via wc-live's own
 * boot, extension via `wc-extension.ts` reusing `attachWcClient`.
 */

import type { LayoutApplyMsg } from '../../shell/supplemental-commands/layout-command.js';

export type LayoutApplier = (msg: LayoutApplyMsg) => void;

let layoutApplier: LayoutApplier | null = null;

export function setLayoutApplier(fn: LayoutApplier | null): void {
  layoutApplier = fn;
}

export function getLayoutApplier(): LayoutApplier | null {
  return layoutApplier;
}
