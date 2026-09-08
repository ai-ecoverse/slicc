/**
 * Console message capture and retrieval subcommand.
 *
 * Subscribes to Runtime.consoleAPICalled CDP events for a tab on first use,
 * accumulates messages in a ring buffer, and filters/returns them on demand.
 */

import { bindTabCapture } from '../session-rebind.js';
import { requireTab } from '../state.js';
import type {
  ConsoleMessage,
  PlaywrightHandler,
  PlaywrightHandlerCtx,
  PlaywrightState,
} from '../types.js';

// Derived from the handler context rather than imported from `cdp/` so this
// module stays inside the shell layer (see layer-stack import direction).
type CDPTransport = ReturnType<PlaywrightHandlerCtx['browser']['getTransport']>;

/**
 * The fields this handler reads off a `Runtime.consoleAPICalled` event.
 *
 * The transport's listener signature is untyped (`CDPPayload`, an alias for
 * `Record<string, unknown>`), so we narrow the raw payload into this named
 * shape once at the boundary — that makes every field access below a checked
 * property read rather than an ad-hoc per-field cast.
 */
interface ConsoleApiCalledEvent {
  sessionId?: string;
  type?: string;
  args?: Array<{ value?: unknown; description?: string }>;
}

const LEVELS = ['debug', 'log', 'info', 'warning', 'error'] as const;
const RING_BUFFER_SIZE = 1000;

/** Normalize CDP console types not in LEVELS to their nearest severity. */
const CDP_TYPE_NORMALIZATION: Record<string, string> = {
  assert: 'error',
  trace: 'debug',
  dir: 'log',
  dirxml: 'log',
  table: 'log',
  count: 'info',
  timeEnd: 'info',
  clear: 'log',
  startGroup: 'log',
  startGroupCollapsed: 'log',
  endGroup: 'log',
  profile: 'debug',
  profileEnd: 'debug',
};

/** Start capturing console messages for a tab if not already subscribed. */
function ensureCapturing(
  browser: PlaywrightHandlerCtx['browser'],
  state: PlaywrightState,
  transport: CDPTransport,
  targetId: string,
  sessionId: string
): void {
  if (state.consoleCleanup.has(targetId)) return;

  state.consoleMessages.set(targetId, []);

  // The tab's session can be replaced under us (the bridge re-attaches when a
  // proxy reset invalidates it), and events for the new session carry a new
  // id. `binding.sessionId` is read per event so a long-lived capture does not
  // go silently deaf; `bindTabCapture` also re-arms this listener and
  // re-enables `Runtime` on the replacement session.
  const handler = (rawParams: Parameters<Parameters<CDPTransport['on']>[1]>[0]) => {
    const params = rawParams as ConsoleApiCalledEvent;
    if (params.sessionId !== binding.sessionId) return;
    const type = params.type ?? 'log';
    const level = CDP_TYPE_NORMALIZATION[type] ?? type;
    const args = params.args ?? [];
    const text = args.map((a) => String(a.value ?? a.description ?? '')).join(' ');
    const msgs = state.consoleMessages.get(targetId);
    if (!msgs) return;
    msgs.push({ level, text, timestamp: Date.now() });
    if (msgs.length > RING_BUFFER_SIZE) {
      msgs.splice(0, msgs.length - RING_BUFFER_SIZE);
    }
  };

  // ponytail: Runtime.exceptionThrown (uncaught errors, rejected promises) not surfaced
  // here — would need a separate subscription. Add when agents need JS exception capture.
  const binding = bindTabCapture({
    browser,
    targetId,
    transport,
    sessionId,
    listeners: [['Runtime.consoleAPICalled', handler]],
    enable: (t, s) => t.send('Runtime.enable', {}, s),
  });

  state.consoleCleanup.set(targetId, () => binding.stop());
}

export const consoleHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  onTab,
}) => {
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
    await onTab(tab.targetId, async ({ sessionId, transport }) => {
      await transport.send('Runtime.enable', {}, sessionId);
      ensureCapturing(browser, state, transport, tab.targetId, sessionId);
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
