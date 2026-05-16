/**
 * Intercepted OAuth launcher — drives the controlled browser to the
 * authorize URL, then watches CDP `Fetch.requestPaused` events for the
 * configured redirect URI. Captures the code + state from the URL,
 * closes the tab, never runs a local HTTP server.
 *
 * Why this exists: xAI's public Grok-CLI OAuth client (and similar public
 * clients for Google Cloud Code Assist, etc.) only trust loopback redirect
 * URIs. A traditional web app can't bind 127.0.0.1, and a Chrome extension's
 * `chromiumapp.org` redirect isn't registered on those clients. CDP-side
 * interception sidesteps both problems: the redirect URI is a destination
 * string the browser tries to navigate to, and CDP can capture that
 * navigation before any TCP connection is opened.
 *
 * Design parallels hermes-agent's loopback flow but uses Fetch.requestPaused
 * instead of an actual http.Server. See:
 *   https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/auth.py
 */

import type { CDPTransport } from '../cdp/transport.js';
import type {
  InterceptingOAuthLauncher,
  InterceptOAuthConfig,
  OAuthRequestRewrite,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Validate that an unknown JSON-like value conforms to {@link InterceptOAuthConfig}.
 *
 * Lets the same flow definition live in three places interchangeably:
 *   1. A provider's `onOAuthLoginIntercepted` implementation (TypeScript).
 *   2. A JSON file the user drops into slicc's VFS (e.g. for one-off testing
 *      of a custom OAuth client without writing a provider).
 *   3. `oauth-token --intercept --authorize-url=… --redirect-pattern=…`
 *      arguments assembled by the supplemental command.
 *
 * Returns the typed config on success, or `{ error }` with a human-readable
 * message on failure (so callers can surface it to the user verbatim).
 */
export function parseInterceptOAuthConfig(
  data: unknown
): { ok: true; config: InterceptOAuthConfig } | { ok: false; error: string } {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, error: 'expected a JSON object' };
  }
  const d = data as Record<string, unknown>;

  if (typeof d.authorizeUrl !== 'string' || d.authorizeUrl.length === 0) {
    return { ok: false, error: 'authorizeUrl must be a non-empty string' };
  }
  if (typeof d.redirectUriPattern !== 'string' || d.redirectUriPattern.length === 0) {
    return { ok: false, error: 'redirectUriPattern must be a non-empty string' };
  }
  if (d.onCapture !== undefined && d.onCapture !== 'close' && d.onCapture !== 'leave') {
    return { ok: false, error: 'onCapture must be "close" or "leave"' };
  }
  if (d.timeoutMs !== undefined && (typeof d.timeoutMs !== 'number' || d.timeoutMs <= 0)) {
    return { ok: false, error: 'timeoutMs must be a positive number' };
  }

  const rewriteResult = validateRewrites(d.rewrite);
  if (!rewriteResult.ok) return rewriteResult;

  return {
    ok: true,
    config: {
      authorizeUrl: d.authorizeUrl,
      redirectUriPattern: d.redirectUriPattern,
      rewrite: rewriteResult.rewrites,
      onCapture: d.onCapture as 'close' | 'leave' | undefined,
      timeoutMs: d.timeoutMs as number | undefined,
    },
  };
}

function validateRewrites(
  raw: unknown
): { ok: true; rewrites: OAuthRequestRewrite[] | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, rewrites: undefined };
  if (!Array.isArray(raw)) return { ok: false, error: 'rewrite must be an array' };
  const out: OAuthRequestRewrite[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== 'object' || item === null) {
      return { ok: false, error: `rewrite[${i}] must be an object` };
    }
    const r = item as Record<string, unknown>;
    if (typeof r.match !== 'string' || r.match.length === 0) {
      return { ok: false, error: `rewrite[${i}].match must be a non-empty string` };
    }
    if (r.replaceUrl !== undefined && typeof r.replaceUrl !== 'string') {
      return { ok: false, error: `rewrite[${i}].replaceUrl must be a string when present` };
    }
    if (r.appendParams !== undefined) {
      if (
        typeof r.appendParams !== 'object' ||
        r.appendParams === null ||
        Array.isArray(r.appendParams)
      ) {
        return { ok: false, error: `rewrite[${i}].appendParams must be an object` };
      }
      for (const [k, v] of Object.entries(r.appendParams as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          return { ok: false, error: `rewrite[${i}].appendParams.${k} must be a string` };
        }
      }
    }
    out.push({
      match: r.match,
      appendParams: r.appendParams as Record<string, string> | undefined,
      replaceUrl: r.replaceUrl as string | undefined,
    });
  }
  return { ok: true, rewrites: out };
}

interface FetchRequestPausedEvent {
  requestId: string;
  request: { url: string; method: string; headers: Record<string, string> };
  resourceType?: string;
  frameId?: string;
}

interface CreateTargetResult {
  targetId: string;
}

interface AttachToTargetResult {
  sessionId: string;
}

/** Match a URL against a pattern with optional trailing `*`. */
function matchesPattern(url: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return url.startsWith(pattern.slice(0, -1));
  }
  return url === pattern || url.startsWith(`${pattern}?`) || url.startsWith(`${pattern}#`);
}

/**
 * Apply a list of {@link OAuthRequestRewrite}s to an outbound URL.
 * Exported for tests.
 */
export function applyRewrites(url: string, rewrites: OAuthRequestRewrite[] | undefined): string {
  if (!rewrites || rewrites.length === 0) return url;
  let current = url;
  for (const rule of rewrites) {
    if (!current.includes(rule.match)) continue;
    if (rule.replaceUrl) {
      current = rule.replaceUrl;
      continue;
    }
    if (rule.appendParams) {
      try {
        const parsed = new URL(current);
        for (const [k, v] of Object.entries(rule.appendParams)) {
          parsed.searchParams.set(k, v);
        }
        current = parsed.toString();
      } catch {
        // Non-URL-parseable values get left alone.
      }
    }
  }
  return current;
}

/**
 * Build an {@link InterceptingOAuthLauncher} bound to the given CDP transport.
 *
 * The transport is expected to be already connected. The launcher creates a
 * fresh target, attaches the session, enables `Fetch`, navigates, listens for
 * the redirect URI pattern, and either closes or leaves the tab depending on
 * `config.onCapture`.
 */
export function createInterceptingOAuthLauncher(
  transport: CDPTransport
): InterceptingOAuthLauncher {
  return async (config: InterceptOAuthConfig) => {
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const rewrites = config.rewrite ?? [];
    const onCapture = config.onCapture ?? 'close';

    let targetId: string | undefined;
    let sessionId: string | undefined;
    let resolved = false;
    let captured: string | null = null;

    const cleanup = async () => {
      if (sessionId) {
        try {
          await transport.send('Fetch.disable', {}, sessionId);
        } catch {
          /* best-effort */
        }
      }
      if (targetId && onCapture === 'close') {
        try {
          await transport.send('Target.closeTarget', { targetId });
        } catch {
          /* best-effort */
        }
      }
    };

    return await new Promise<string | null>((resolve) => {
      const finish = async (url: string | null) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        transport.off('Fetch.requestPaused', onPaused);
        await cleanup();
        resolve(url);
      };

      const onPaused = (params: Record<string, unknown>) => {
        const evt = params as unknown as FetchRequestPausedEvent;
        if (!evt?.request?.url || !sessionId) return;

        // Capture step: did this request hit the redirect URI?
        if (matchesPattern(evt.request.url, config.redirectUriPattern)) {
          captured = evt.request.url;
          // Fail the paused request — we never want this to actually hit the
          // wire. Tab close on the way out will dismiss the error page.
          transport
            .send(
              'Fetch.failRequest',
              { requestId: evt.requestId, errorReason: 'Aborted' },
              sessionId
            )
            .catch(() => {
              /* best-effort */
            });
          finish(captured);
          return;
        }

        // Rewrite step: patch the URL if a rule matches.
        const rewritten = applyRewrites(evt.request.url, rewrites);
        if (rewritten !== evt.request.url) {
          transport
            .send('Fetch.continueRequest', { requestId: evt.requestId, url: rewritten }, sessionId)
            .catch((err: unknown) => {
              console.warn(
                '[intercepted-oauth] continueRequest (rewrite) failed:',
                err instanceof Error ? err.message : String(err)
              );
            });
          return;
        }

        transport
          .send('Fetch.continueRequest', { requestId: evt.requestId }, sessionId)
          .catch(() => {
            /* best-effort */
          });
      };

      const timer = setTimeout(() => {
        finish(null);
      }, timeoutMs);

      (async () => {
        try {
          const created = (await transport.send('Target.createTarget', {
            url: 'about:blank',
          })) as unknown as CreateTargetResult;
          targetId = created.targetId;

          const attached = (await transport.send('Target.attachToTarget', {
            targetId,
            flatten: true,
          })) as unknown as AttachToTargetResult;
          sessionId = attached.sessionId;

          transport.on('Fetch.requestPaused', onPaused);
          await transport.send(
            'Fetch.enable',
            {
              patterns: [
                { urlPattern: config.redirectUriPattern, requestStage: 'Request' },
                // Also pause every request so the rewrite rules can fire on
                // intermediate hops (e.g. authorize URL patches). Provider
                // rewrites are scoped via `match`, so the false-positive cost
                // is just an extra continueRequest.
                ...rewrites.map((r) => ({ urlPattern: `*${r.match}*`, requestStage: 'Request' })),
              ],
            },
            sessionId
          );

          await transport.send('Page.navigate', { url: config.authorizeUrl }, sessionId);
        } catch (err) {
          console.error(
            '[intercepted-oauth] setup failed:',
            err instanceof Error ? err.message : String(err)
          );
          finish(null);
        }
      })();
    });
  };
}
