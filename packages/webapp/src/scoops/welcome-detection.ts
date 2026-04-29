/**
 * Welcome detection — checks whether the current user has already
 * completed the onboarding flow.
 *
 * On first run (no `/shared/.welcomed` marker file AND no prior
 * welcome lick in the cone's chat history), the caller (ui/main.ts)
 * emits a `sprinkle` lick with name `welcome` and action `first-run`
 * to the cone. The welcome skill then renders the welcome dip in chat
 * via the `![](/shared/sprinkles/welcome/welcome.shtml)` image syntax
 * instead of relying on the legacy auto-opened panel.
 *
 * The marker is written by `main.ts` when the user finishes the
 * onboarding (`onboarding-complete` / `shortcut-migrate` actions),
 * mirroring the existing welcome panel lifecycle. We deliberately do
 * NOT advance it here so a partial onboarding that the user reloads
 * mid-flow still re-fires the lick on the next boot — UNLESS the
 * lick already shows up in the cone's persisted chat history, in
 * which case we treat that as a stronger "already welcomed" signal
 * than the marker file (the chat history is the canonical record of
 * what the user has seen).
 */

import { createLogger } from '../core/logger.js';
import type { VirtualFS } from '../fs/index.js';

const log = createLogger('welcome-detection');

const WELCOMED_MARKER_PATH = '/shared/.welcomed';

/**
 * IndexedDB layer that holds the chat-panel's persisted conversations.
 * Mirrors `ui/session-store.ts` literally — DB name + store + the
 * `session-cone` key the chat panel uses for the cone scoop. We avoid
 * importing the UI `SessionStore` so this module stays inside the
 * scoops layer (which `main.ts` imports from both CLI and extension
 * boot paths) without pulling in chat-panel internals.
 */
const CHAT_DB_NAME = 'browser-coding-agent';
const CHAT_DB_VERSION = 1;
const CHAT_STORE_NAME = 'sessions';
const CONE_SESSION_ID = 'session-cone';

/**
 * Header literal the orchestrator prepends to every welcome lick
 * (see `routeLickToScoop` in `ui/main.ts`). If we find this anywhere
 * in the cone's persisted message log, the welcome lick has already
 * fired in a previous boot.
 */
const WELCOME_LICK_HEADER = '[Sprinkle Event: welcome]';

interface PersistedChatMessage {
  role?: string;
  content?: unknown;
}

interface PersistedChatSession {
  id: string;
  messages?: PersistedChatMessage[];
}

function openChatDbOnce(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CHAT_DB_NAME, CHAT_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHAT_STORE_NAME)) {
        db.createObjectStore(CHAT_STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // `onblocked` fires when another tab/worker still holds an old
    // version open. The upgrade will retry once the holder closes.
    req.onblocked = () => {
      /* leave the promise pending — onsuccess/onerror will fire eventually */
    };
  });
}

/**
 * Open the chat DB with a single retry after a short backoff. Boot
 * paths that race with `nuke`'s pending `deleteDatabase` requests can
 * surface as `AbortError: Version change transaction was aborted in
 * upgradeneeded event handler` — the second attempt almost always
 * succeeds because the delete has completed by then. We swallow the
 * first failure rather than blocking welcome detection on it.
 */
function openChatDb(): Promise<IDBDatabase> {
  return openChatDbOnce().catch(
    () =>
      new Promise<IDBDatabase>((resolve, reject) => {
        setTimeout(() => {
          openChatDbOnce().then(resolve, reject);
        }, 120);
      })
  );
}

async function loadConeChatSession(): Promise<PersistedChatSession | null> {
  const db = await openChatDb();
  try {
    return await new Promise<PersistedChatSession | null>((resolve, reject) => {
      const tx = db.transaction(CHAT_STORE_NAME, 'readonly');
      const req = tx.objectStore(CHAT_STORE_NAME).get(CONE_SESSION_ID);
      req.onsuccess = () => resolve((req.result as PersistedChatSession | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export interface WelcomeDetection {
  /** True when the welcomed marker is absent and the welcome lick should fire. */
  isFirstRun: boolean;
}

/**
 * Scan the cone's persisted chat history for a previously-fired
 * welcome lick. The orchestrator writes every lick into the chat as
 * a synthetic user message whose content begins with
 * `[Sprinkle Event: welcome]`, so a substring match is sufficient.
 *
 * Returns `false` on any error so a transient IndexedDB hiccup doesn't
 * permanently suppress the welcome lick on a genuinely-fresh boot.
 */
export async function hasWelcomeLickInHistory(): Promise<boolean> {
  try {
    const session = await loadConeChatSession();
    if (!session || !Array.isArray(session.messages)) return false;
    return session.messages.some((msg) => messageMentionsWelcomeLick(msg));
  } catch (err) {
    log.warn('Failed to scan cone chat session for welcome lick', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function messageMentionsWelcomeLick(msg: PersistedChatMessage): boolean {
  const content = msg.content;
  if (typeof content === 'string') return content.includes(WELCOME_LICK_HEADER);
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (typeof block === 'string') return block.includes(WELCOME_LICK_HEADER);
    if (block && typeof block === 'object') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') return text.includes(WELCOME_LICK_HEADER);
    }
    return false;
  });
}

/**
 * Detect whether the welcome lick should fire on this boot. Returns
 * `isFirstRun: true` only when BOTH:
 *   - `/shared/.welcomed` does not exist, AND
 *   - the cone's persisted chat history has no prior welcome lick.
 *
 * The history check exists because the marker is only written when
 * the user actively completes onboarding (`onboarding-complete` /
 * `shortcut-migrate`). Without the history check, a user who
 * partially onboarded and reloaded the page would see the welcome
 * lick re-fire on every boot, even though the cone already greeted
 * them. The marker still wins on a fresh chat (history wiped, marker
 * intact) so we don't re-greet returning users.
 *
 * IMPORTANT: This function does **not** create the marker. The marker
 * is written by `main.ts`'s sprinkle-lick handler when the user
 * actually completes onboarding.
 */
export async function detectWelcomeFirstRun(fs: VirtualFS): Promise<WelcomeDetection> {
  let markerPresent = false;
  try {
    markerPresent = await fs.exists(WELCOMED_MARKER_PATH);
  } catch (err) {
    log.warn('Failed to read welcomed marker', {
      path: WELCOMED_MARKER_PATH,
      error: err instanceof Error ? err.message : String(err),
    });
    // Be conservative: if we can't read the marker, assume we've
    // already welcomed so we don't pester returning users with a
    // duplicate lick on every transient FS hiccup.
    return { isFirstRun: false };
  }

  if (markerPresent) return { isFirstRun: false };

  // No marker — fall back to the chat-history check so reloads
  // between the lick firing and onboarding completing don't double-fire.
  if (await hasWelcomeLickInHistory()) return { isFirstRun: false };

  return { isFirstRun: true };
}

/**
 * Persist the welcomed marker. Pairs with the existing
 * `onboarding-complete` / `shortcut-migrate` lick handlers in `main.ts`.
 * Exported for symmetry with `upgrade-detection.ts` and so future
 * call-sites can write the marker without re-implementing the path.
 */
export async function recordWelcomed(fs: VirtualFS): Promise<void> {
  await fs.writeFile(WELCOMED_MARKER_PATH, '1');
}

export const __test__ = {
  WELCOMED_MARKER_PATH,
  CONE_SESSION_ID,
  WELCOME_LICK_HEADER,
  CHAT_DB_NAME,
  CHAT_DB_VERSION,
  CHAT_STORE_NAME,
};
