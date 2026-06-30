/**
 * Lick-back API — the cup's outbound channel to an external Claude brain
 * (the symmetric mirror of inbound `/api/lick/emit`). Under cup mode the
 * webapp runs no internal cone, so browser-originated events (chat messages,
 * `upgrade`/sprinkle licks) have no local responder — lick-back routes them to
 * whichever orchestrator session has CLAIMED the channel.
 *
 * Routes (all loopback Host-guarded, like the cup routes):
 *   POST /api/lickback/claim      — atomically claim a channel for this session
 *   POST /api/lickback/heartbeat  — renew the claim's lease
 *   GET  /api/lickback?channel=   — SSE drain of the channel's outbound events
 *                                   (emits `: ping` keepalive comments so the
 *                                   consumer's idle fetch never hits undici's
 *                                   300s bodyTimeout and mis-reads it as cup-death)
 *   POST /api/lickback/reply      — stream a reply back to the browser panel
 *   POST /api/lickback/stop       — operator stand-down: end the owner's open SSE
 *                                   so its blocked long-poll consumer returns
 *
 * Ownership + buffering live in {@link LickbackRegistry}; this module is the
 * thin HTTP surface. The browser pushes outbound events over the lick bridge
 * (`lickback-event`, enqueued by the bridge into the registry); replies go back
 * over the same bridge as a `lickback-reply` broadcast.
 *
 * Parity: N/A — cup is standalone-only; the extension float has no
 * node-server (spec §11).
 */
// tva
import type { Express, Response } from 'express';
import { createLoopbackHostGuard } from './cup-api.js';
import type { LickBridge } from './lick-bridge.js';
import type { LickbackRegistry } from './lickback-registry.js';

/** Route prefix the lick-back API owns; the Host guard is scoped to it. */
const LICKBACK_PREFIX = '/api/lickback';

/** The MVP ships one channel; the API is shaped so more slot in later. */
const DEFAULT_CHANNEL = 'chat';

/** SSE keepalive cadence. Must stay well under undici's 300s default bodyTimeout
 *  (the consumer's `fetch` aborts an idle body at 300s and mis-reads it as
 *  cup-death) — 25s gives ~12x margin. Overridable for tests. */
function pingIntervalMs(): number {
  return Number.parseInt(process.env.LICKBACK_PING_MS ?? '', 10) || 25_000;
}

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
  // brain, so reject any request whose `Host` header isn't loopback. Shares the
  // cup-api factory; scoped to `/api/lickback` so the rest of `/api` is untouched.
  app.use(createLoopbackHostGuard([LICKBACK_PREFIX], 'lick-back API'));

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

    // Keepalive: a `: ping` SSE comment resets the consumer's undici bodyTimeout
    // so an idle wait reaches its own cap (idle re-run) instead of throwing
    // `terminated` and mis-reporting the live cup as gone. `.unref()` so it can
    // never keep the process alive; cleared together with the drain on close.
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, pingIntervalMs());
    ping.unref?.();

    const sub = registry.subscribe(
      channel,
      session,
      (event) => {
        if (res.writableEnded) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      () => {
        // Operator stand-down (registry.stop): end THIS exact open response with
        // an intent-bearing control frame so the blocked long-poll consumer
        // returns and stands down (exit 4) WITHOUT the cup dying. The control
        // frame is an SSE `event:` field line — a browser-pushed event is always
        // written as a `data:` line, so it can never forge this.
        if (res.writableEnded) return;
        res.write('event: lickback-control\ndata: stop\n\n');
        res.end();
      }
    );
    if (!sub.ok) {
      // Defensive: isOwner passed synchronously above, so this is unreachable.
      clearInterval(ping);
      res.end();
      return;
    }
    res.on('close', () => {
      clearInterval(ping);
      sub.unsubscribe();
    });
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

  /**
   * POST /api/lickback/stop — body `{ channel? }`, header `X-Slicc-Session`.
   * Operator stand-down: release the channel's owner and end its open SSE so the
   * handler's blocked long-poll consumer returns and stops — WITHOUT killing the
   * cup. Replaces the channel-takeover workaround.
   *
   * Deliberately NOT owner-gated. The steering session that issues stop has a
   * different id than the handler that owns the channel, so an owner-gated release
   * would be unusable by the steerer (the exact gap the takeover hack worked
   * around). It is loopback-trusted (Host guard above) and session-present:
   * requiring the non-safelisted X-Slicc-Session header forces a CORS preflight
   * that the gate denies for non-allowlisted origins, so a cross-origin page can't
   * reach it — and the route is strictly less powerful than the claim route (any
   * loopback session can already take/displace the channel) and /api/shell/exec.
   * Do NOT "harden" this into owner-gating: that silently re-breaks the steerer's
   * kill switch.
   *
   * 200 `{ stopped: true }`  — an owner was released (its SSE, if open, was ended).
   * 200 `{ stopped: false }` — the channel was already unowned (idempotent).
   * 400                      — X-Slicc-Session missing.
   */
  app.post('/api/lickback/stop', (req, res) => {
    const session = req.header('X-Slicc-Session');
    if (requireSession(res, session)) return;
    const channel = pickChannel((req.body as { channel?: unknown } | undefined)?.channel);
    res.json(registry.stop(channel));
  });
}
