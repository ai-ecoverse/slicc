/**
 * Console message capture and retrieval subcommand.
 *
 * Subscribes to Runtime.consoleAPICalled CDP events for a tab on first use,
 * accumulates messages in a ring buffer, and filters/returns them on demand.
 */

import type { CDPTransport } from '../../../../cdp/transport.js';
import { requireTab } from '../state.js';
import type { ConsoleMessage, PlaywrightHandler, PlaywrightState } from '../types.js';

const LEVELS = ['debug', 'log', 'info', 'warning', 'error'] as const;
const RING_BUFFER_SIZE = 1000;

/** Start capturing console messages for a tab if not already subscribed. */
function ensureCapturing(
  state: PlaywrightState,
  transport: CDPTransport,
  targetId: string,
  sessionId: string
): void {
  if (state.consoleCleanup.has(targetId)) return;

  state.consoleMessages.set(targetId, []);

  const handler = (params: Record<string, unknown>) => {
    if ((params['sessionId'] as string | undefined) !== sessionId) return;
    const type = (params['type'] as string | undefined) ?? 'log';
    const args =
      (params['args'] as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
    const text = args.map((a) => String(a.value ?? a.description ?? '')).join(' ');
    const msgs = state.consoleMessages.get(targetId);
    if (!msgs) return;
    msgs.push({ level: type, text, timestamp: Date.now() });
    if (msgs.length > RING_BUFFER_SIZE) {
      msgs.splice(0, msgs.length - RING_BUFFER_SIZE);
    }
  };

  transport.on('Runtime.consoleAPICalled', handler);

  state.consoleCleanup.set(targetId, () => {
    transport.off('Runtime.consoleAPICalled', handler);
  });
}

export const consoleHandler: PlaywrightHandler = async ({ browser, state, positional, flags }) => {
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };

  const minLevel = (positional[0] ?? 'log') as string;
  const clear = flags['clear'] === 'true';

  const minIndex = LEVELS.indexOf(minLevel as (typeof LEVELS)[number]);
  if (minIndex === -1) {
    return {
      stdout: '',
      stderr: `Invalid level "${minLevel}". Valid: ${LEVELS.join(', ')}\n`,
      exitCode: 1,
    };
  }

  // Only enable Runtime domain and subscribe if not already capturing for this tab.
  if (!state.consoleCleanup.has(tab.targetId)) {
    await browser.withTab(tab.targetId, async (sessionId) => {
      const transport = browser.getTransport();
      await transport.send('Runtime.enable', {}, sessionId);
      ensureCapturing(state, transport, tab.targetId, sessionId);
    });
  }

  const messages: ConsoleMessage[] = (state.consoleMessages.get(tab.targetId) ?? []).filter(
    (m) => LEVELS.indexOf(m.level as (typeof LEVELS)[number]) >= minIndex
  );

  // Clears all messages regardless of the min-level filter.
  if (clear) {
    state.consoleMessages.set(tab.targetId, []);
  }

  if (messages.length === 0) {
    return { stdout: 'No console messages\n', stderr: '', exitCode: 0 };
  }

  const lines = messages.map((m) => `[${m.level}] ${m.text}`).join('\n');
  return { stdout: lines + '\n', stderr: '', exitCode: 0 };
};
