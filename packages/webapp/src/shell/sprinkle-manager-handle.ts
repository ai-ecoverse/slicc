/** Sprinkle metadata consumed by the shell command. */
export interface ShellSprinkle {
  name: string;
  title: string;
  path: string;
}

/**
 * One rendered document of a sprinkle, on whichever runtime renders it.
 *
 * A sprinkle has a single store but can have many live documents: the
 * leader's own panel plus one per connected follower that mirrored it.
 * `sprinkle list` reports these so an owner can see that two documents
 * exist against one store (issue #2166).
 */
export interface SprinkleInstance {
  /** Sprinkle name the instance renders. */
  name: string;
  /** Runtime that renders it — `'leader'` for the local one, else a follower runtime id. */
  runtimeId: string;
  /** Float/runtime tag the follower connected with, e.g. `slicc-standalone`. Absent for the leader. */
  runtime?: string;
}

/**
 * Which instances a `sprinkle send` should reach.
 *
 * Omitting `runtime` broadcasts to every instance (leader + all connected
 * followers) — the historical behavior, now documented rather than implied.
 */
export interface SprinkleSendTarget {
  /** Deliver only to this runtime id (`'leader'` or a follower runtime id from `host`). */
  runtime?: string;
}

/**
 * What a `sprinkle send` actually reached.
 *
 * "Delivered" means the update was handed to that instance's transport, not
 * that the panel acknowledged rendering it — an ack channel is panel-side
 * work tracked separately. It is still strictly better than the previous
 * unconditional exit 0: a push that reached nothing is now visible.
 */
export interface SprinkleSendReport {
  /** True when the leader's own open sprinkle received the push. */
  leader: boolean;
  /** Runtime ids of followers the push was sent to. */
  followers: string[];
  /** Set when a `--runtime` target matched no connected runtime. */
  unknownRuntime?: string;
}

/**
 * What the follower transport did with a push.
 *
 * Lives here rather than next to the `SprinkleManager` so the leader-tray
 * broadcaster (`scoops/`) can type its return value without importing from
 * `ui/` — that back-edge is exactly what the layer-direction review pattern
 * forbids.
 */
export interface SprinkleBroadcastResult {
  /** Runtime ids whose channel accepted the update. */
  followers: string[];
  /** Set when a `--runtime` target matched no connected follower. */
  unknownRuntime?: string;
}

/** Total instances a send reached — zero means the push vanished. */
export function sendReportReach(report: SprinkleSendReport): number {
  return (report.leader ? 1 : 0) + report.followers.length;
}

/**
 * A discovered sprinkle as the proxies carry it across a transport.
 *
 * Superset of {@link ShellSprinkle} — it keeps the discovery fields the page's
 * `Sprinkle` has so the worker/offscreen proxies can describe their payload
 * without importing the type from `ui/` (a layer back-edge).
 */
export interface SprinkleEntry extends ShellSprinkle {
  autoOpen?: boolean;
  icon?: string;
}

/**
 * What a cross-realm sprinkle-manager proxy exposes.
 *
 * The real `SprinkleManager` lives in `ui/` (it owns DOM containers), but the
 * shell that drives it runs in the kernel worker or the extension's offscreen
 * document. Both proxies implement THIS surface, so `scoops/` never has to
 * import the manager's own type upward from `ui/`.
 */
export interface SprinkleManagerProxySurface extends SprinkleManagerHandle {
  available(): SprinkleEntry[];
  openNewAutoOpenSprinkles(): Promise<void>;
  restoreOpenSprinkles?(): Promise<void>;
}

/** Worker-safe slice of the sprinkle manager used by the shell command. */
export interface SprinkleManagerHandle {
  refresh(): Promise<void>;
  available(): ShellSprinkle[];
  opened(): string[];
  open(name: string): Promise<void>;
  close(name: string): void;
  reload(name: string): Promise<void>;
  sendToSprinkle(
    name: string,
    data: unknown,
    target?: SprinkleSendTarget
  ): SprinkleSendReport | Promise<SprinkleSendReport>;
}
