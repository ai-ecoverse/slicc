/**
 * vpod sandbox ("pod") registry. Module-level state in the kernel
 * worker (modules are singletons per worker, same persistence model as
 * the v86 VM registry in `v86-vm.ts`) so a pod booted by one
 * `vpod start` invocation is drivable by every later `vpod <sub>`
 * invocation in the session.
 */

import type { VpodSandbox } from './vpod-loader.js';

export interface PodRecord {
  name: string;
  sandbox: VpodSandbox;
  sdkVersion: string;
  snapshotId: string;
  pid: number | null;
  startedAt: number;
  bootArgv: readonly string[];
  /**
   * True while a `commands.run` is in flight. The executor runs guest
   * commands through a single session handle — concurrent exec calls
   * would interleave inside the wasm, so `vpod run` fails fast instead.
   */
  busy: boolean;
}

const registry = new Map<string, PodRecord>();

export function getPod(name: string): PodRecord | undefined {
  return registry.get(name);
}

export function listPods(): PodRecord[] {
  return [...registry.values()];
}

export function registerPod(record: PodRecord): void {
  registry.set(record.name, record);
}

export function unregisterPod(name: string): void {
  registry.delete(name);
}

/** Test-only: drop all records without touching the sandboxes. */
export function resetPodRegistryForTests(): void {
  registry.clear();
}
