/**
 * Lick-back API — the substrate's outbound channel to an external Claude brain
 * (the symmetric mirror of inbound `/api/lick/emit`). Under substrate mode the
 * webapp runs no internal cone, so browser-originated events (chat messages,
 * `upgrade`/sprinkle licks) have no local responder — lick-back routes them to
 * whichever orchestrator session has CLAIMED the channel.
 *
 * Routes (all loopback Host-guarded, like the substrate routes):
 *   POST /api/lickback/claim      — atomically claim a channel for this session
 *   POST /api/lickback/heartbeat  — renew the claim's lease
 *   GET  /api/lickback?channel=   — SSE drain of the channel's outbound events
 *   POST /api/lickback/reply      — stream a reply back to the browser panel
 *
 * Ownership + buffering live in {@link LickbackRegistry}; this module is the
 * thin HTTP surface. The browser pushes outbound events over the lick bridge
 * (`lickback-event`, enqueued by the bridge into the registry); replies go back
 * over the same bridge as a `lickback-reply` broadcast.
 *
 * Parity: N/A — substrate is standalone-only; the extension float has no
 * node-server (spec §11).
 */
// tva
import type { Express, Response } from 'express';
import type { LickBridge } from './lick-bridge.js';
import type { LickbackRegistry } from './lickback-registry.js';
import { isLoopbackHostHeader } from './substrate-api.js';

/** Route prefix the lick-back API owns; the Host guard is scoped to it. */
const LICKBACK_PREFIX = '/api/lickback';

/** The MVP ships one channel; the API is shaped so more slot in later. */
const DEFAULT_CHANNEL = 'chat';

/** Resolve a request's channel, defaulting to `chat` for an absent/blank value. */
function pickChannel(raw: unknown): string {
  return typeof raw === 'string' && raw.length > 0 ? raw : DEFAULT_CHANNEL;
}

/** Send a `400 X-Slicc-Session required`; returns true when the session is absent. */
function requireSession(res: Response, session: string | undefined): session is undefined {
  if (!session) {
    res.status(400).json({ error: 'X-Slicc-Session header is required' });
    return true;
  }
  return false;
}

export function registerLickbackApiRoutes(
  app: Express,
  bridge: Pick<LickBridge, 'broadcastLickEvent'>,
  registry: LickbackRegistry
): void {
  // DNS-rebinding guard: lick-back drives the human's chat from an external
  // brain, so reject any request whose `Host` header isn't loopback. Mirrors
  // the substrate-api guard; scoped to `/api/lickback` so the rest of `/api`
  // is untouched.
  app.use((req, res, next) => {
    const guarded = req.path === LICKBACK_PREFIX || req.path.startsWith(`${LICKBACK_PREFIX}/`);
    if (guarded && !isLoopbackHostHeader(req.headers.host)) {
      res
        .status(403)
        .json({ error: 'lick-back API is loopback-only (non-loopback Host rejected)' });
      return;
    }
    next();
  });

  /**
   * POST /api/lickback/claim — body `{ channel? }`, header `X-Slicc-Session`.
   * First caller wins the channel; the owner (or an expired channel) renews.
   *
   * 200 `{ owner, leaseMs }` — claim granted/renewed.
   * 409 `{ owner }`           — owned by a different, non-expired session.
   * 400                       — X-Slicc-Session missing.
   */
  app.post('/api/lickback/claim', (req, res) => {
    const session = req.header('X-Slicc-Session');
    if (requireSession(res, session)) return;
    const channel = pickChannel((req.body as { channel?: unknown } | undefined)?.channel);
    const result = registry.claim(channel, session);
    if (result.ok) res.json({ owner: result.owner, leaseMs: result.leaseMs });
    else res.status(409).json({ owner: result.owner });
  });

  /**
   * POST /api/lickback/heartbeat — body `{ channel? }`, header `X-Slicc-Session`.
   * Renews the owner's lease without re-claiming (never steals on expiry).
   *
   * 200 `{ ok: true }` — renewed.
   * 409                — caller is not the channel's owner.
   * 400                — X-Slicc-Session missing.
   */
  app.post('/api/lickback/heartbeat', (req, res) => {
    const session = req.header('X-Slicc-Session');
    if (requireSession(res, session)) return;
    const channel = pickChannel((req.body as { channel?: unknown } | undefined)?.channel);
    if (registry.heartbeat(channel, session)) res.json({ ok: true });
    else res.status(409).json({ error: 'channel owned by another session' });
  });

  /**
   * GET /api/lickback?channel= — SSE drain, owner-only. Streams the channel's
   * buffered-then-live outbound events as `data: <json>\n\n` frames; holding the
   * stream pins the lease open. Disconnect unsubscribes (the queue re-buffers).
   *
   * 200 text/event-stream — owner; events stream.
   * 409                   — caller is not the channel's owner.
   * 400                   — X-Slicc-Session missing.
   */
  app.get('/api/lickback', (req, res) => {
    const session = req.header('X-Slicc-Session');
    if (requireSession(res, session)) return;
    const channel = pickChannel(req.query.channel);
    // Gate before committing SSE headers: the ownership check is synchronous, so
    // the `subscribe` below cannot race it (single-threaded event loop).
    if (!registry.isOwner(channel, session)) {
      res.status(409).json({ error: 'channel owned by another session' });
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    // Flush the head immediately so the owner sees 200 even before the first
    // event (the buffer may be empty when it connects).
    res.flushHeaders?.();

    const sub = registry.subscribe(channel, session, (event) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    if (!sub.ok) {
      // Defensive: isOwner passed synchronously above, so this is unreachable.
      res.end();
      return;
    }
    res.on('close', () => sub.unsubscribe());
  });

  /**
   * POST /api/lickback/reply — the external brain's streamed reply back to the
   * browser panel. Body `{ channel?, replyTo, delta?, text?, done? }`, header
   * `X-Slicc-Session`. Owner-only; forwards a `lickback-reply` over the lick
   * bridge for the webapp to render as an assistant turn.
   *
   * 200 `{ ok: true }` — forwarded.
   * 409                — caller is not the channel's owner (bridge untouched).
   * 400                — X-Slicc-Session or replyTo missing.
   */
  app.post('/api/lickback/reply', (req, res) => {
    const session = req.header('X-Slicc-Session');
    if (requireSession(res, session)) return;
    const {
      channel: rawChannel,
      replyTo,
      delta,
      text,
      done,
    } = (req.body ?? {}) as {
      channel?: unknown;
      replyTo?: unknown;
      delta?: unknown;
      text?: unknown;
      done?: unknown;
    };
    if (typeof replyTo !== 'string' || replyTo === '') {
      res.status(400).json({ error: '"replyTo" body field is required' });
      return;
    }
    const channel = pickChannel(rawChannel);
    if (!registry.isOwner(channel, session)) {
      res.status(409).json({ error: 'channel owned by another session' });
      return;
    }
    // Only carry the fields that were supplied so the wire mirror stays tight
    // (a delta frame vs. a one-shot text frame vs. a bare done terminator).
    const event: Record<string, unknown> = { type: 'lickback-reply', channel, replyTo };
    if (delta !== undefined) event.delta = delta;
    if (text !== undefined) event.text = text;
    if (done !== undefined) event.done = done;
    bridge.broadcastLickEvent(event);
    res.json({ ok: true });
  });
}
