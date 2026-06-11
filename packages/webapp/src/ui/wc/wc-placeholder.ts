/**
 * Suggested composer placeholder — the legacy ChatPanel's
 * `refreshSuggestedPlaceholder` ported to the WC shell. After each finished
 * turn, a cheap one-shot LLM call (`quickLabel`) proposes the user's likely
 * next prompt from the recent conversation; it lands as the textarea
 * placeholder. Fails soft to the static default on every edge (no provider,
 * no conversation yet, user already typing, call failure).
 */

import type { ChatMessage } from '../types.js';

const TRANSCRIPT_USER_MAX = 400;
const TRANSCRIPT_ASSISTANT_MAX = 800;

const SYSTEM =
  "You suggest the user's next prompt in a coding-agent chat. Based on the recent " +
  'conversation, output ONE concrete follow-up the user might type next. Reply with just ' +
  'the prompt text — no quotes, no preamble, no list. Max 80 characters. If nothing useful ' +
  'comes to mind, reply exactly: What shall we build?';

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The `[user]…[assistant]` transcript for the suggestion prompt, or null
 *  when the conversation is too thin to suggest from. */
export function placeholderTranscript(messages: readonly ChatMessage[]): string | null {
  const finalized = messages.filter((m) => !m.isStreaming && !m.queued && m.source !== 'lick');
  const lastAssistant = [...finalized].reverse().find((m) => m.role === 'assistant');
  const recentUsers = finalized.filter((m) => m.role === 'user').slice(-3);
  if (!lastAssistant || recentUsers.length === 0) return null;
  return [
    ...recentUsers.map((m) => `[user]: ${truncate(m.content, TRANSCRIPT_USER_MAX)}`),
    `[assistant]: ${truncate(lastAssistant.content, TRANSCRIPT_ASSISTANT_MAX)}`,
  ].join('\n\n');
}

export interface RefreshPlaceholderOptions {
  messages: readonly ChatMessage[];
  /** Live composer text — a non-empty draft must never be disturbed. */
  currentValue: string;
  setPlaceholder(text: string): void;
  defaultPlaceholder: string;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to the shared quick-LLM helper. */
  quickLabelFn?: (opts: {
    system: string;
    prompt: string;
    maxTokens: number;
    signal?: AbortSignal;
  }) => Promise<string | null>;
}

/** Regenerate the composer placeholder from the recent turns (fail-soft). */
export async function refreshSuggestedPlaceholder(opts: RefreshPlaceholderOptions): Promise<void> {
  if (opts.currentValue.length > 0) return;
  const transcript = placeholderTranscript(opts.messages);
  if (!transcript) {
    opts.setPlaceholder(opts.defaultPlaceholder);
    return;
  }
  const quickLabelFn = opts.quickLabelFn ?? (await import('../quick-llm.js')).quickLabel;
  const suggestion = await quickLabelFn({
    system: SYSTEM,
    prompt: `Recent conversation:\n${transcript}`,
    maxTokens: 40,
    signal: opts.signal,
  });
  if (opts.signal?.aborted) return;
  if (opts.currentValue.length > 0) return;
  opts.setPlaceholder(suggestion && suggestion.length > 0 ? suggestion : opts.defaultPlaceholder);
}

export interface WirePlaceholderDeps {
  inputCard: HTMLElement & { value?: string };
  getMessages(): ChatMessage[];
  defaultPlaceholder: string;
}

/**
 * Returns the trigger the boot wires to "turn finished" moments: aborts any
 * in-flight suggestion, then regenerates from the current conversation.
 */
export function createPlaceholderRefresher(deps: WirePlaceholderDeps): () => void {
  let abort: AbortController | null = null;
  return () => {
    // A disabled composer is the read-only frozen view — leave it alone.
    if (deps.inputCard.hasAttribute('disabled')) return;
    abort?.abort();
    abort = new AbortController();
    void refreshSuggestedPlaceholder({
      messages: deps.getMessages(),
      currentValue: deps.inputCard.value ?? '',
      setPlaceholder: (text) => deps.inputCard.setAttribute('placeholder', text),
      defaultPlaceholder: deps.defaultPlaceholder,
      signal: abort.signal,
    }).catch(() => undefined);
  };
}
