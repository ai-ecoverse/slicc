import type { LayoutApplyMsg } from '../../shell/supplemental-commands/layout-command.js';

export interface LayoutApplyResult {
  applied: boolean;
  output?: string;
  error?: string;
}

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
