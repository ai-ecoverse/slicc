/**
 * UI fixture — a synthetic chat session covering every message UI
 * variant so designers can iterate on the chat panel without having to
 * drive a real conversation.
 *
 * Activated by loading the app with `?ui-fixture=1`. The messages are
 * persisted to a dedicated `session-ui-fixture` session id so they
 * survive reloads without touching real scoop storage.
 *
 * When updating the fixture, add variants rather than replacing old
 * ones — the goal is for every CSS rule in chat/tools/lick/feedback
 * styles to have a matching sample here.
 */

import type { ChatMessage, ToolCall } from './types.js';

/** Base timestamp: 2024-01-01 10:00:00 local. Keeping it fixed makes the
 *  rendered timeline deterministic and avoids "5 seconds ago" style
 *  drift when the fixture is reloaded. */
const T0 = new Date('2024-01-01T10:00:00').getTime();

/** Advance the clock by `minutes` from T0 — used so lick messages pass
 *  `shouldShowLabel`'s >2min-gap check and trigger a new avatar row. */
function tsAt(minutes: number): number {
  return T0 + minutes * 60_000;
}

/** Session id used by `loadFixtureSession`. Exported so main.ts and
 *  tests can reference it without duplicating the string. */
export const FIXTURE_SESSION_ID = 'session-ui-fixture';

/** Scoop name shown in the header when the fixture is active.
 *  Passed to `switchToContext(_, _, scoopName)` so message labels
 *  render as `@ui-fixture` instead of `sliccy`. */
export const FIXTURE_SCOOP_NAME = 'ui-fixture';

/** Build the synthetic chat history. Pure function — no side effects.
 *  Each message has a stable id so the fixture is idempotent under
 *  re-renders and matches exact-id lookups in tests. */
export function createChatFixture(): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // ── 1. User + short assistant ──────────────────────────────────────
  messages.push({
    id: 'fx-user-1',
    role: 'user',
    content: 'Hey sliccy — can you summarize what this fixture covers?',
    timestamp: tsAt(0),
  });

  messages.push({
    id: 'fx-assistant-1',
    role: 'assistant',
    content:
      'Sure! This session walks through every chat UI variant I know about. ' +
      "You'll see user and assistant bubbles, tool calls in every status, " +
      'the six lick channels, a delegation, queued messages, and a streaming ' +
      'tail at the end so you can inspect the live state.',
    timestamp: tsAt(0.2),
  });

  // ── 2. Markdown + code block + inline formatting ──────────────────
  messages.push({
    id: 'fx-user-2',
    role: 'user',
    content: 'Show me some **markdown** — headings, lists, code, a blockquote.',
    timestamp: tsAt(1),
  });

  messages.push({
    id: 'fx-assistant-2',
    role: 'assistant',
    content: [
      '## Rich content sample',
      '',
      'Here is a short list:',
      '',
      '- `renderAssistantMessageContent` handles GFM markdown',
      '- Code blocks get syntax highlighting',
      '- Inline `code` uses the mono token',
      '',
      'A fenced code block:',
      '',
      '```ts',
      "import { createChatFixture } from './chat-fixture.js';",
      '',
      'const msgs = createChatFixture();',
      'console.log(msgs.length);',
      '```',
      '',
      '> Blockquotes should feel quieter than regular text.',
      '',
      'And a nested ordered list:',
      '',
      '1. First step',
      '2. Second step',
      '   1. Sub-step A',
      '   2. Sub-step B',
      '3. Third step',
    ].join('\n'),
    timestamp: tsAt(1.3),
  });

  // ── 3. Assistant with tool calls in every status ───────────────────
  const toolCallSuccess: ToolCall = {
    id: 'fx-tc-read',
    name: 'read_file',
    input: { path: '/workspace/README.md' },
    result: '# Sample README\n\nThis is the contents that read_file returned.',
  };
  const toolCallBashSuccess: ToolCall = {
    id: 'fx-tc-bash',
    name: 'bash',
    input: { command: 'ls -la /workspace' },
    result:
      'total 24\ndrwxr-xr-x 4 user user 4096 Jan 01 10:00 .\ndrwxr-xr-x 6 user user 4096 Jan 01 10:00 ..\n-rw-r--r-- 1 user user  187 Jan 01 10:00 README.md\ndrwxr-xr-x 2 user user 4096 Jan 01 10:00 src',
  };
  const toolCallError: ToolCall = {
    id: 'fx-tc-err',
    name: 'edit_file',
    input: { path: '/workspace/missing.ts', old_str: 'x', new_str: 'y' },
    result: 'ENOENT: no such file or directory, open "/workspace/missing.ts"',
    isError: true,
  };
  // Running / streaming tool call — result undefined renders the spinner.
  const toolCallRunning: ToolCall = {
    id: 'fx-tc-run',
    name: 'bash',
    input: { command: 'npm run test -- --coverage' },
  };
  // A tool call carrying a transient screenshot (1x1 transparent PNG is
  // enough to exercise the thumbnail rendering path).
  const toolCallScreenshot: ToolCall = {
    id: 'fx-tc-shot',
    name: 'bash',
    input: { command: 'playwright-cli screenshot' },
    result: 'Screenshot saved to /tmp/shot.png',
    _screenshotDataUrl:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  };

  messages.push({
    id: 'fx-assistant-3',
    role: 'assistant',
    content: 'Let me check a few things before I answer.',
    timestamp: tsAt(2),
    toolCalls: [
      toolCallSuccess,
      toolCallBashSuccess,
      toolCallError,
      toolCallRunning,
      toolCallScreenshot,
    ],
  });

  // ── 4. Delegation from cone ────────────────────────────────────────
  messages.push({
    id: 'fx-delegation-1',
    role: 'user',
    content:
      '**[Instructions from sliccy]**\n\nRead `/workspace/README.md` and extract the install steps into `/shared/install.md`.',
    timestamp: tsAt(4),
    source: 'delegation',
    channel: 'delegation',
  });

  messages.push({
    id: 'fx-assistant-delegated',
    role: 'assistant',
    content:
      'Extracted the install steps. Wrote them to `/shared/install.md`. ' +
      'The section covers prerequisites, npm install, and the dev server launch.',
    timestamp: tsAt(4.4),
    source: 'cone',
  });

  // ── 5. Licks — one per channel ────────────────────────────────────
  messages.push({
    id: 'fx-lick-webhook',
    role: 'user',
    content:
      '[Webhook Event: github-push]\n```json\n' +
      JSON.stringify(
        {
          ref: 'refs/heads/main',
          repository: { full_name: 'example/repo' },
          head_commit: { message: 'fix(ui): tighten button contrast in dark mode' },
        },
        null,
        2
      ) +
      '\n```',
    timestamp: tsAt(6),
    source: 'lick',
    channel: 'webhook',
  });

  messages.push({
    id: 'fx-lick-cron',
    role: 'user',
    content:
      '[Cron Event: daily-digest]\n```json\n' +
      JSON.stringify({ time: new Date(tsAt(8)).toISOString() }, null, 2) +
      '\n```',
    timestamp: tsAt(8),
    source: 'lick',
    channel: 'cron',
  });

  messages.push({
    id: 'fx-lick-sprinkle',
    role: 'user',
    content:
      '[Sprinkle Event: welcome]\n```json\n' +
      JSON.stringify({ action: 'onboarding-complete', data: { mountWorkspace: true } }, null, 2) +
      '\n```',
    timestamp: tsAt(10),
    source: 'lick',
    channel: 'sprinkle',
  });

  messages.push({
    id: 'fx-lick-fswatch',
    role: 'user',
    content:
      '[File Watch Event: src-watch]\n```json\n' +
      JSON.stringify(
        {
          changes: [
            { type: 'modified', path: '/workspace/src/app.ts' },
            { type: 'created', path: '/workspace/src/utils.ts' },
          ],
        },
        null,
        2
      ) +
      '\n```',
    timestamp: tsAt(12),
    source: 'lick',
    channel: 'fswatch',
  });

  messages.push({
    id: 'fx-lick-navigate',
    role: 'user',
    content:
      '[Navigate Event: https://www.sliccy.ai/handoff?msg=handoff%3Ademo]\n```json\n' +
      JSON.stringify(
        {
          url: 'https://www.sliccy.ai/handoff?msg=handoff%3Ademo',
          sliccHeader: 'handoff:demo',
          title: 'Handoff',
        },
        null,
        2
      ) +
      '\n```',
    timestamp: tsAt(14),
    source: 'lick',
    channel: 'navigate',
  });

  messages.push({
    id: 'fx-lick-session-reload',
    role: 'user',
    content:
      '[Session Reload: mount-recovery]\n\n' +
      'A previously-mounted directory needs to be reauthorized:\n\n' +
      '- `/mnt/workspace` (was `workspace/`)',
    timestamp: tsAt(16),
    source: 'lick',
    channel: 'session-reload',
  });

  // ── 6. Queued messages (before the streaming tail) ────────────────
  messages.push({
    id: 'fx-queued-1',
    role: 'user',
    content: 'Also double-check the install.md formatting after you finish.',
    timestamp: tsAt(18),
    queued: true,
  });

  // ── 7. Streaming / live-state tail ────────────────────────────────
  // Assistant message mid-stream — the cursor keeps blinking via CSS.
  messages.push({
    id: 'fx-assistant-streaming',
    role: 'assistant',
    content: "Great, running the coverage suite now. I'll report back as soon as it ",
    timestamp: tsAt(20),
    isStreaming: true,
    toolCalls: [
      {
        id: 'fx-tc-streaming',
        name: 'bash',
        input: { command: 'npm run test -- --coverage' },
        // No result — renders the running spinner.
      },
    ],
  });

  return messages;
}
