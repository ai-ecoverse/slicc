import { bindTabCapture } from '../session-rebind.js';
import { requireTab } from '../state.js';
import type {
  ConsoleMessage,
  PlaywrightHandler,
  PlaywrightHandlerCtx,
  PlaywrightState,
} from '../types.js';

type CDPTransport = ReturnType<PlaywrightHandlerCtx['browser']['getTransport']>;

interface ConsoleApiCalledEvent {
  sessionId?: string;
  type?: string;
  args?: Array<{ value?: unknown; description?: string }>;
}

const LEVELS = ['debug', 'log', 'info', 'warning', 'error'] as const;
const RING_BUFFER_SIZE = 1000;

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

function ensureCapturing(
  browser: PlaywrightHandlerCtx['browser'],
  state: PlaywrightState,
  transport: CDPTransport,
  targetId: string,
  sessionId: string
): void {
  if (state.consoleCleanup.has(targetId)) return;

  state.consoleMessages.set(targetId, []);

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

  if (!state.consoleCleanup.has(tab.targetId)) {
    await onTab(tab.targetId, async ({ sessionId, transport }) => {
      await transport.send('Runtime.enable', {}, sessionId);
      ensureCapturing(browser, state, transport, tab.targetId, sessionId);
    });
  }

  const messages: ConsoleMessage[] = (state.consoleMessages.get(tab.targetId) ?? []).filter(
    (m) => LEVELS.indexOf(m.level as (typeof LEVELS)[number]) >= minIndex
  );

  if (clear) {
    state.consoleMessages.set(tab.targetId, []);
  }

  if (messages.length === 0) {
    return { stdout: 'No console messages\n', stderr: '', exitCode: 0 };
  }

  const lines = messages.map((m) => `[${m.level}] ${m.text}`).join('\n');
  return { stdout: lines + '\n', stderr: '', exitCode: 0 };
};
