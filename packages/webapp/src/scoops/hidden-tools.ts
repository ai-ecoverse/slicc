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
 *  - `Bridge.createCallbacks.onToolStart / onToolEnd`
 *    (live streaming path).
 *  - `agentMessagesToChatMessages` (history rebuild path called by
 *    `Bridge.handleRequestScoopMessages`).
 *
 * If those paths read different lists, history rebuilds will surface
 * tool calls that live streaming hides — exactly the inconsistency
 * the PR #614 review flagged.
 */

export const HIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'send_message',
  'list_scoops',
  'list_tasks',
  // `sudo_request` is the scoop-side plumbing for cone-mediated approval;
  // the user-visible event is the `[sudo-request]` channel message the
  // orchestrator delivers to the cone. `list_sudo_requests` is the
  // cone-side introspection counterpart.
  'sudo_request',
  'list_sudo_requests',
  // `lick_confirm` / `lick_dismiss` are cone-side decision mechanics; the
  // user-visible feedback is the card ✓/✗ flip, so the tool-call rows are
  // hidden to avoid duplicate "lick_confirm done" noise in the chat UI.
  'lick_confirm',
  'lick_dismiss',
]);
