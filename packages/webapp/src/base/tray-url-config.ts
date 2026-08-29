/**
 * Pure tray URL parsing + the two boot-config storage keys.
 *
 * These have no runtime dependencies — no fetch, no DOM, no orchestrator
 * state — and both `shell/` (the `host` command) and `scoops/` (the tray
 * managers) need them. Keeping them at the bottom rung is what lets the shell
 * reach them without importing UP the layer stack
 * (`fs/base → shell/git → cdp → tools → core → scoops → ui`); see
 * `docs/review-patterns.md` § Layer-stack import direction and #2537.
 *
 * `scoops/tray-runtime-config.ts` re-exports every symbol here under its
 * established name and keeps the half that genuinely needs a higher layer
 * (`resolveTrayRuntimeConfig` / `fetchRuntimeConfig`, which reach for
 * `shell/proxied-fetch.js` and `kernel/messages.js`).
 *
 * The canonical `normalizeTrayWorkerBaseUrl` / `parseTrayJoinUrl`
 * implementations live in `node-server/src/tray-url-shared.ts`, shared with
 * the CLI; this module re-exports the former and builds on the latter.
 */

import {
  normalizeTrayWorkerBaseUrl,
  parseTrayJoinUrl,
} from '../../../node-server/src/tray-url-shared.js';

export { normalizeTrayWorkerBaseUrl };

/** Key for the stored tray worker base URL (`https://host[/base]`). */
export const TRAY_WORKER_STORAGE_KEY = 'slicc.trayWorkerBaseUrl';
/** Key for the stored follower join URL (`https://…/join/<trayId>.<secret>`). */
export const TRAY_JOIN_STORAGE_KEY = 'slicc.trayJoinUrl';

export interface TrayUrlConfig {
  workerBaseUrl: string;
  trayId: string | null;
  joinUrl: string | null;
}

export type TrayJoinConfig = TrayUrlConfig & { joinUrl: string };

/**
 * Parse any tray URL shape into its worker base plus whichever of
 * `trayId` / `joinUrl` the shape carries: a `…/tray/<trayId>` leader/session
 * URL yields `trayId`, a `…/join/<token>` follower URL delegates to
 * `parseTrayJoinUrl` and yields `joinUrl`, and a bare origin yields neither.
 * Returns null for anything unparseable.
 */
export function parseTrayUrlValue(raw: string | null | undefined): TrayUrlConfig | null {
  if (!raw) return null;

  try {
    const url = new URL(raw.trim());
    url.search = '';
    url.hash = '';

    const segments = url.pathname.split('/').filter(Boolean);
    let trayId: string | null = null;
    const joinUrl: string | null = null;
    if (segments.length >= 2 && segments.at(-2) === 'tray') {
      trayId = decodeURIComponent(segments.at(-1)!);
      segments.splice(-2, 2);
      url.pathname = segments.length > 0 ? `/${segments.join('/')}` : '/';
    } else if (segments.length >= 2 && segments.at(-2) === 'join') {
      return parseTrayJoinUrl(url.toString());
    }

    const workerBaseUrl = normalizeTrayWorkerBaseUrl(url.toString());
    if (!workerBaseUrl) {
      return null;
    }

    return { workerBaseUrl, trayId, joinUrl };
  } catch {
    return null;
  }
}

/**
 * `parseTrayUrlValue` narrowed to the follower shape: null unless the input
 * really was a `…/join/<trayId>.<secret>` URL.
 */
export function parseTrayJoinUrlValue(raw: string | null | undefined): TrayJoinConfig | null {
  const parsed = parseTrayUrlValue(raw);
  return parsed?.joinUrl ? (parsed as TrayJoinConfig) : null;
}
