/**
 * Per-target viewport overrides that survive CDP session replacement.
 *
 * Extracted from {@link BrowserAPI} so the map can be unit-tested without the
 * attach path. Re-applying an override onto a fresh session (wire
 * `Emulation.setDeviceMetricsOverride`) stays on BrowserAPI — this module owns
 * only the recorded values.
 */

import type { ViewportOverride } from './tab-handle.js';

export class ViewportOverrideStore {
  private readonly overrides = new Map<string, ViewportOverride>();

  get(targetId: string): ViewportOverride | undefined {
    return this.overrides.get(targetId);
  }

  set(targetId: string, vp: ViewportOverride): void {
    this.overrides.set(targetId, vp);
  }

  delete(targetId: string): void {
    this.overrides.delete(targetId);
  }

  has(targetId: string): boolean {
    return this.overrides.has(targetId);
  }

  get size(): number {
    return this.overrides.size;
  }
}
