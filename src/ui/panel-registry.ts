/**
 * Panel Registry — tracks all panels (built-in + SHTML) with their zone placement.
 */

import type { PanelDescriptor, PanelRegistryEntry, ZoneId } from './panel-types.js';

export class PanelRegistry {
  private entries = new Map<string, PanelRegistryEntry>();
  private listeners = new Set<() => void>();

  /** Register a panel. */
  register(descriptor: PanelDescriptor): void {
    this.entries.set(descriptor.id, { descriptor });
    this.notify();
  }

  /** Unregister a panel by id. */
  unregister(id: string): void {
    this.entries.delete(id);
    this.notify();
  }

  /** Get a panel entry by id. */
  get(id: string): PanelRegistryEntry | undefined {
    return this.entries.get(id);
  }

  /** Get all panels currently placed in a zone. */
  getByZone(zone: ZoneId): PanelDescriptor[] {
    const result: PanelDescriptor[] = [];
    for (const entry of this.entries.values()) {
      if (entry.descriptor.zone === zone) result.push(entry.descriptor);
    }
    return result;
  }

  /** Get all closed panels (zone === null). */
  getClosed(): PanelDescriptor[] {
    const result: PanelDescriptor[] = [];
    for (const entry of this.entries.values()) {
      if (entry.descriptor.zone === null) result.push(entry.descriptor);
    }
    return result;
  }

  /** Move a panel to a zone (or close it by setting null). */
  setZone(id: string, zone: ZoneId | null): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.descriptor.zone = zone;
      this.notify();
    }
  }

  /** Get all registered panel ids. */
  ids(): string[] {
    return Array.from(this.entries.keys());
  }

  /** Check if a panel is registered. */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Subscribe to registry changes. Returns unsubscribe function. */
  onChange(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }
}
