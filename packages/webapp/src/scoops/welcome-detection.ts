import { createLogger } from '../base/logger.js';
import type { VirtualFS } from '../fs/index.js';
import { CanonicalSessionReader } from '../work-unit/conversation/sessions.js';
import { WorkUnitConversationStore } from '../work-unit/conversation/store.js';
import { chatSessionIdFor, PRIMARY_CONE_FOLDER } from '../work-unit/record.js';

const log = createLogger('welcome-detection');

const WELCOMED_MARKER_PATH = '/shared/.welcomed';

const CHAT_DB_NAME = 'browser-coding-agent';
const CHAT_DB_VERSION = 1;
const CHAT_STORE_NAME = 'sessions';
const CONE_SESSION_ID = chatSessionIdFor({ folder: PRIMARY_CONE_FOLDER });

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

    req.onblocked = () => {};
  });
}

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

async function loadLegacyConeChatSession(): Promise<PersistedChatSession | null> {
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

async function loadConeChatMessages(): Promise<PersistedChatMessage[]> {
  const [canonical, legacy] = await Promise.all([
    loadCanonicalConeChatMessages().catch((err) => {
      log.warn('Failed to read the cone conversation record', { error: errorText(err) });
      return [];
    }),
    loadLegacyConeChatSession().catch((err) => {
      log.warn('Failed to read the legacy cone chat session', { error: errorText(err) });
      return null;
    }),
  ]);
  const legacyMessages = Array.isArray(legacy?.messages) ? legacy.messages : [];
  return [...canonical, ...legacyMessages];
}

async function loadCanonicalConeChatMessages(): Promise<PersistedChatMessage[]> {
  const session = await new CanonicalSessionReader(
    new WorkUnitConversationStore()
  ).loadRootChatSession(PRIMARY_CONE_FOLDER);
  return session?.messages ?? [];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface WelcomeDetection {
  isFirstRun: boolean;
}

export async function hasWelcomeLickInHistory(): Promise<boolean> {
  try {
    const messages = await loadConeChatMessages();
    return messages.some((msg) => messageMentionsWelcomeLick(msg));
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

export async function detectWelcomeFirstRun(fs: VirtualFS): Promise<WelcomeDetection> {
  let markerPresent = false;
  try {
    markerPresent = await fs.exists(WELCOMED_MARKER_PATH);
  } catch (err) {
    log.warn('Failed to read welcomed marker', {
      path: WELCOMED_MARKER_PATH,
      error: err instanceof Error ? err.message : String(err),
    });

    return { isFirstRun: false };
  }

  if (markerPresent) return { isFirstRun: false };

  if (await hasWelcomeLickInHistory()) return { isFirstRun: false };

  return { isFirstRun: true };
}

export async function recordWelcomed(fs: VirtualFS): Promise<void> {
  await fs.writeFile(WELCOMED_MARKER_PATH, '1');
}

const FINAL_LICK_FINGERPRINT = '"action":"onboarding-complete-with-provider"';

function messageMentionsFinalLick(msg: PersistedChatMessage): boolean {
  const content = msg.content;
  if (typeof content === 'string') return content.includes(FINAL_LICK_FINGERPRINT);
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (typeof block === 'string') return block.includes(FINAL_LICK_FINGERPRINT);
    if (block && typeof block === 'object') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') return text.includes(FINAL_LICK_FINGERPRINT);
    }
    return false;
  });
}

export async function hasOnboardingFinalLickInHistory(): Promise<boolean> {
  try {
    const messages = await loadConeChatMessages();
    return messages.some((msg) => messageMentionsFinalLick(msg));
  } catch (err) {
    log.warn('Failed to scan cone chat session for final lick', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export const __test__ = {
  WELCOMED_MARKER_PATH,
  CONE_SESSION_ID,
  WELCOME_LICK_HEADER,
  CHAT_DB_NAME,
  CHAT_DB_VERSION,
  CHAT_STORE_NAME,
};
