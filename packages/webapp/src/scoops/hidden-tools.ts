/**
 * Internal orchestration tools that should never appear in the chat
 * UI. These are mechanics — `send_message` (cone↔scoop traffic),
 * `list_scoops` (agent introspecting the scoop list), `list_tasks`
 * (cron / webhook table introspection) — not user-visible work, so
 * surfacing them as tool-call rows just adds noise.
 *
 * Single source of truth: every code path that translates agent
 * activity into the chat surface should read this list. Imported by:
 *
 *  - `OffscreenBridge.createCallbacks.onToolStart / onToolEnd`
 *    (live streaming path).
 *  - `agentMessagesToChatMessages` (history rebuild path called by
 *    `OffscreenBridge.handleRequestScoopMessages`).
 *
 * If those paths read different lists, history rebuilds will surface
 * tool calls that live streaming hides — exactly the inconsistency
 * the PR #614 review flagged.
 */

export const HIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'send_message',
  'list_scoops',
  'list_tasks',
]);
