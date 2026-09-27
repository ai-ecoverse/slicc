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
