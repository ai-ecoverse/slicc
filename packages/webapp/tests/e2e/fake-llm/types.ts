/**
 * Fixture schema for the deterministic fake OpenAI-compatible LLM server
 * (see `./server.ts`).
 *
 * A fixture is an ordered list of scripted assistant `turns`. For each
 * `POST /v1/chat/completions` call the server picks a turn using:
 *
 *   1. If `turns[cursor]` has no matcher, OR its matcher matches the
 *      latest user message, that turn is used and the cursor advances
 *      past it.
 *   2. Otherwise the server scans forward from `cursor+1` for the first
 *      turn whose matcher matches; if found, that turn is used and the
 *      cursor advances past it (skipped, non-matching turns become
 *      unreachable).
 *   3. If nothing matches, behavior is governed by `onOverflow`
 *      (default `error` — the server returns a 400 with a clear
 *      diagnostic, never a hang).
 *
 * The matching algorithm makes plain cursor-order fixtures work without
 * any matcher boilerplate, while still allowing per-turn selection
 * (`whenUserMessageMatches`) when a single fixture needs to react to
 * different inputs.
 */

/** A scripted tool call. `arguments` accepts either an already-serialized
 *  JSON string (passed through unchanged) or an object (JSON.stringified
 *  by the server). `id` is auto-generated when omitted. */
export interface ToolCallFixture {
  id?: string;
  name: string;
  arguments: string | Record<string, unknown>;
}

/** Selector for {@link AssistantTurn.whenUserMessageMatches}. Strings are
 *  treated as case-sensitive substring matches; regex literals are used
 *  directly; the object form lets JSON fixtures express regex matchers. */
export type UserMessageMatcher = string | RegExp | { pattern: string; flags?: string };

/** A single scripted assistant turn. At least one of `content` or
 *  `tool_calls` should be present; both is also valid (mirrors real
 *  OpenAI behavior where an assistant turn may emit prose AND tool
 *  calls before a `finish_reason: 'tool_calls'`). */
export interface AssistantTurn {
  content?: string;
  tool_calls?: ToolCallFixture[];
  /** Defaults to `'tool_calls'` if `tool_calls` is non-empty, else `'stop'`. */
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | (string & {});
  /** Optional gate — turn is only eligible when the latest user message
   *  matches. Omit for purely cursor-ordered fixtures. */
  whenUserMessageMatches?: UserMessageMatcher;
  /** Streaming character chunk size for `content`. Defaults to 16. */
  contentChunkSize?: number;
  /** Streaming character chunk size for each tool-call's `arguments`
   *  string. Defaults to 24. The leading chunk always carries the
   *  id/name with empty arguments to mirror real OpenAI streaming. */
  toolArgumentsChunkSize?: number;
}

export interface Fixture {
  /** Primary model id. Echoed in every SSE chunk and returned first
   *  from `GET /v1/models`. */
  model: string;
  /** Optional extra model ids advertised by `GET /v1/models` (for
   *  multi-model fixtures or `local-llm discover` testing). */
  models?: string[];
  turns: AssistantTurn[];
  /** Behavior when no turn is eligible for the current request.
   *  `error` (default): respond 400 with a JSON diagnostic.
   *  `repeat-last`: replay the most recently used turn. */
  onOverflow?: 'error' | 'repeat-last';
}
