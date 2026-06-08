/**
 * `setup-ui-fixture.ts` — design-time UI fixture loader extracted
 * verbatim from `main.ts`.
 *
 * Loading the app with `?ui-fixture=1` (or `?ui-fixture` / `?ui-fixture=true`)
 * swaps the chat view for a synthetic session covering every message
 * variant. Messages live in `chat-fixture.ts` and persist to a dedicated
 * `session-ui-fixture` id so real scoop storage is untouched.
 */

import { createLogger } from '../../core/index.js';
import type { ChatMessage } from '../types.js';

const log = createLogger('boot/ui-fixture');

/** True when the current URL requests the design-time UI fixture. */
export function isUIFixtureRequested(): boolean {
  try {
    const raw = new URLSearchParams(window.location.search).get('ui-fixture');
    if (raw === null) return false;
    return raw === '' || raw === '1' || raw.toLowerCase() === 'true';
  } catch {
    return false;
  }
}

/**
 * Load the design-time UI fixture into the chat panel. Writes messages
 * to a dedicated `session-ui-fixture` session id so the fixture survives
 * reloads without touching real scoop storage.
 */
export async function loadUIFixtureIntoChat(chatPanel: {
  switchToContext: (id: string, readOnly: boolean, scoopName?: string) => Promise<void>;
  loadMessages: (msgs: ChatMessage[]) => void;
  setCompactionState?: (state: 'summarizing' | 'extracting-memory' | 'idle') => void;
}): Promise<void> {
  const [{ createChatFixture, FIXTURE_SESSION_ID, FIXTURE_SCOOP_NAME }] = await Promise.all([
    import('../chat-fixture.js'),
  ]);
  await chatPanel.switchToContext(FIXTURE_SESSION_ID, true, FIXTURE_SCOOP_NAME);
  chatPanel.loadMessages(createChatFixture());
  // Optional preview of the compaction ghost bubble for designers:
  //   ?ui-fixture=1&compacting=summarizing
  //   ?ui-fixture=1&compacting=extracting-memory
  const params = new URLSearchParams(window.location.search);
  const compacting = params.get('compacting');
  if (compacting === 'summarizing' || compacting === 'extracting-memory') {
    chatPanel.setCompactionState?.(compacting);
  }
  log.info('Loaded UI fixture session for design iteration');
}
