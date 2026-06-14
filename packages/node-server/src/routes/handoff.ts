import type { Express } from 'express';

/**
 * Profile-independent handoff injection.
 *
 * The CDP navigation-watcher only sees tabs inside the Chrome instance
 * SLICC launched (isolated profile keyed by port); similarly the
 * extension's webRequest observer only fires inside the profile where it
 * is installed. External tools (e.g. the slicc-handoff helper) post here
 * so a handoff reaches the cone regardless of which browser profile the
 * user is currently driving.
 *
 * The payload mirrors the parsed RFC 8288 `Link` form used by the
 * observers: `verb` ∈ {handoff, upskill}, `target` is the resolved URL,
 * `instruction` is optional free-form prose (handoff verb).
 */
export interface HandoffPayload {
  verb?: unknown;
  target?: unknown;
  instruction?: unknown;
  url?: unknown;
  title?: unknown;
  branch?: unknown;
  path?: unknown;
  // Detect legacy x-slicc-style payloads for a clear error message.
  sliccHeader?: unknown;
}

export interface NavigateEvent {
  type: 'navigate_event';
  verb: 'handoff' | 'upskill';
  target: string;
  instruction?: string;
  url: string;
  title?: string;
  branch?: string;
  path?: string;
  timestamp: string;
}

export interface HandoffRouteDeps {
  broadcastLickEvent(event: unknown): void;
}

/**
 * Validate an inbound handoff payload. Returns an error message when the
 * payload is malformed, or `null` when it is well-formed and ready to be
 * turned into a navigate event. Pure — no I/O.
 */
export function validateHandoffPayload(payload: HandoffPayload): string | null {
  if (typeof payload?.sliccHeader === 'string') {
    return 'The legacy `sliccHeader` payload was removed; post `{ verb, target, instruction? }` instead. See docs/slicc-handoff.md.';
  }
  if (payload?.verb !== 'handoff' && payload?.verb !== 'upskill') {
    return 'verb must be "handoff" or "upskill"';
  }
  if (typeof payload.target !== 'string' || payload.target.length === 0) {
    return 'target is required (non-empty string)';
  }
  if (payload.instruction != null && typeof payload.instruction !== 'string') {
    return 'instruction must be a string when provided';
  }
  // `branch` / `path` mirror the upskill rel's Link params and are
  // ignored on the handoff verb (its target is the page itself, not a
  // repo). Reject the wrong-shape combo loudly so emitters notice
  // rather than silently dropping the scope.
  if (payload.branch != null && typeof payload.branch !== 'string') {
    return 'branch must be a string when provided';
  }
  if (payload.path != null && typeof payload.path !== 'string') {
    return 'path must be a string when provided';
  }
  if (payload.verb === 'handoff' && (payload.branch != null || payload.path != null)) {
    return 'branch and path are only valid with verb="upskill"';
  }
  return null;
}

/** Build the navigate event broadcast to the browser. Assumes a valid payload. */
export function buildNavigateEvent(payload: HandoffPayload): NavigateEvent {
  const optionalString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;
  return {
    type: 'navigate_event',
    verb: payload.verb as 'handoff' | 'upskill',
    target: payload.target as string,
    instruction: typeof payload.instruction === 'string' ? payload.instruction : undefined,
    url: optionalString(payload.url) ?? 'about:handoff',
    title: typeof payload.title === 'string' ? payload.title : undefined,
    branch: optionalString(payload.branch),
    path: optionalString(payload.path),
    timestamp: new Date().toISOString(),
  };
}

export function registerHandoffRoute(app: Express, deps: HandoffRouteDeps): void {
  app.post('/api/handoff', (req, res) => {
    const payload = req.body as HandoffPayload;
    const error = validateHandoffPayload(payload);
    if (error) {
      res.status(400).json({ error });
      return;
    }
    deps.broadcastLickEvent(buildNavigateEvent(payload));
    res.json({ ok: true });
  });
}
