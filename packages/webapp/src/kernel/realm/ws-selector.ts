/**
 * `ws-selector.ts` — declarative WebSocket frame matcher.
 *
 * The selector is a JSON object built by skill code. It is NEVER
 * a function or a string of JS — that's the whole point of the
 * `browser.websocket` security review: filter logic is statically
 * inspectable, so a compromised skill can't smuggle code into the
 * runtime via the filter slot.
 *
 * The matcher runs on both sides of the boundary: the page-side
 * router uses it (inlined into `ws-router-page.ts` as part of the
 * static IIFE) to drop non-matching frames before they leave the
 * page; the host uses it (via this module) for unit tests and as a
 * defense-in-depth re-check in `WsSubscriberRegistry`.
 */

import type { WsSelector } from './realm-types.js';

export interface ParsedFrame {
  /** The raw `event.data` string from the WS frame. */
  raw: string;
  /** Parsed body — `unknown` after JSON.parse, or `raw` for text. */
  body: unknown;
}

/**
 * Parse a raw frame string according to the selector's `parseAs`.
 * Returns `null` if parsing fails (the router/host drops the frame).
 * Defaults to `'json'` because every interception use case so far
 * (Slack/Teams/LinkedIn) carries JSON frames.
 */
export function parseWsFrame(raw: string, selector: WsSelector | undefined): ParsedFrame | null {
  const parseAs = selector?.parseAs ?? 'json';
  if (parseAs === 'text') return { raw, body: raw };
  try {
    return { raw, body: JSON.parse(raw) };
  } catch {
    return null;
  }
}

/**
 * Check whether `frame.body` satisfies the selector's `where`
 * template. A missing `where` matches every frame; non-object bodies
 * never match a non-empty `where`. The comparison is deep-equality
 * for primitives and recursive subset-match for nested objects.
 */
export function matchWsSelector(frame: ParsedFrame, selector: WsSelector | undefined): boolean {
  const where = selector?.where;
  if (!where || Object.keys(where).length === 0) return true;
  if (!isPlainObject(frame.body)) return false;
  return subsetMatch(frame.body as Record<string, unknown>, where);
}

/**
 * Apply `selector.project` to the parsed body, returning only the
 * named top-level fields. When `project` is missing or empty, returns
 * the body unchanged. Non-object bodies are returned as-is regardless
 * of `project` — projection is a no-op for primitive payloads.
 */
export function projectWsFrame(frame: ParsedFrame, selector: WsSelector | undefined): unknown {
  const project = selector?.project;
  if (!project || project.length === 0) return frame.body;
  if (!isPlainObject(frame.body)) return frame.body;
  const src = frame.body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of project) {
    if (key in src) out[key] = src[key];
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function subsetMatch(value: Record<string, unknown>, template: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(template)) {
    const actual = value[key];
    if (isPlainObject(expected)) {
      if (!isPlainObject(actual)) return false;
      if (!subsetMatch(actual as Record<string, unknown>, expected as Record<string, unknown>)) {
        return false;
      }
      continue;
    }
    if (!Object.is(actual, expected)) return false;
  }
  return true;
}
