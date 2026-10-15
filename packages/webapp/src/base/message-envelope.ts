/**
 * Envelope / lick-channel PARSING grammar — the pure string parsers that
 * recover a `[<time>] <sender>: <body>` envelope and classify its lick
 * channel. This lives in `base/` (next to {@link lick-channels}, its only
 * dependency) so BOTH the Scoops chat translator (`scoops/agent-message-to-
 * chat.ts`) AND the lower WorkUnit record ingest (`work-unit/conversation/
 * entries.ts`) can read it without a cross-layer runtime cycle. The
 * ChatMessage *construction* logic that consumes these parsers stays in
 * `scoops/` where it belongs.
 */

import { isLickChannel, LICK_CHANNELS, type LickChannel } from './lick-channels.js';

/**
 * Parse a *single* `[<time>] <senderName>: <body>` envelope —
 * intentionally non-greedy about the body so multi-envelope content
 * can be sliced apart by `splitEnvelopes`. Returns null when the text
 * doesn't open with `[` + a single-line bracketed prefix.
 *
 * Sender parsing anchors on the closed set of senders the orchestrator
 * actually emits today:
 *
 *   - `User`              — plain panel input
 *   - `<LICK_CHANNELS>:…` — lick events; eventName may contain spaces,
 *                           arrows, version numbers, etc.
 *   - anything else       — best-effort split at the first `: ` (used
 *                           for assistant-label scoop notifications,
 *                           tray peers, and any future sender we add)
 *
 * The first two anchors make the parser robust against senders whose
 * `eventName` contains `: ` (e.g. a webhook named `deploy: prod`)
 * because we know exactly where the channel prefix ends. Only fully
 * unknown senders fall back to the naive split.
 *
 * The shape is intentionally not pinned to a specific date format: any
 * `[...]` opener on a single line is accepted, so changes to the
 * orchestrator's `toLocaleString` arguments don't break the parser.
 */
export function unwrapMessageEnvelope(text: string): { sender: string; body: string } | null {
  if (!text.startsWith('[')) return null;
  const closeBracket = text.indexOf('] ');
  if (closeBracket <= 0) return null;
  // The bracketed prefix must not span newlines — otherwise we'd
  // happily strip a leading `[foo`-style label off a multi-line body.
  if (text.lastIndexOf('\n', closeBracket) !== -1) return null;
  const afterBracket = text.slice(closeBracket + 2);

  // Known-sender anchors. We try them in order; the first match wins.
  // `User: ` is exact; lick channels match `<channel>:` followed by
  // any eventName up to the next `: ` on the same line.
  const userPrefix = 'User: ';
  if (afterBracket.startsWith(userPrefix)) {
    return { sender: 'User', body: afterBracket.slice(userPrefix.length) };
  }
  for (const channel of LICK_CHANNELS) {
    const channelPrefix = `${channel}:`;
    if (!afterBracket.startsWith(channelPrefix)) continue;
    // Find the envelope `: ` *after* the channel prefix.
    //
    // The naive "first `: `" cuts senders like `webhook:deploy: prod`
    // in half. The structural anchor we lean on instead: lick bodies
    // formatted by `lick-formatting.ts` open with `[<Label>: <name>]`
    // — i.e. the body's first character is `[`. So when the body
    // starts on the same line, the envelope separator is the *last*
    // `: ` that appears before that `[`. When the body starts on a
    // new line (or doesn't open with `[`, e.g. session-reload's
    // mount-recovery prompt), fall back to the first `: ` after the
    // channel prefix.
    const nl = afterBracket.indexOf('\n');
    const firstLineEnd = nl === -1 ? afterBracket.length : nl;
    const firstLine = afterBracket.slice(0, firstLineEnd);

    let sepIdx = -1;
    // Look for a `[` after the channel prefix, on the first line —
    // that's the start of the lick body framing.
    const bracketIdx = firstLine.indexOf('[', channelPrefix.length);
    if (bracketIdx > channelPrefix.length) {
      // Walk back from the `[` to the most recent `: `.
      sepIdx = firstLine.lastIndexOf(': ', bracketIdx);
    }
    if (sepIdx < channelPrefix.length) {
      // No `[` body opener on the first line (e.g. session-reload
      // mount-recovery prompt). Use the first `: ` after the channel
      // prefix as the boundary — eventNames for these cases don't
      // contain `: ` in practice.
      sepIdx = afterBracket.indexOf(': ', channelPrefix.length);
    }
    if (sepIdx < 0 || sepIdx >= firstLineEnd) continue; // malformed — fall through
    const sender = afterBracket.slice(0, sepIdx);
    const body = afterBracket.slice(sepIdx + 2);
    return { sender, body };
  }

  // Unknown sender (e.g. an assistant label for a scoop notification
  // not routed through host.ts). Best-effort: first `: ` on the first
  // line wins. Any new sender shape that needs lossless replay should
  // be added to the anchor set above.
  const nl = afterBracket.indexOf('\n');
  const firstLineEnd = nl === -1 ? afterBracket.length : nl;
  const senderEnd = afterBracket.indexOf(': ');
  if (senderEnd <= 0 || senderEnd >= firstLineEnd) return null;
  const sender = afterBracket.slice(0, senderEnd);
  if (sender.includes('\n')) return null;
  return { sender, body: afterBracket.slice(senderEnd + 2) };
}

/**
 * Split a possibly-batched user-message body into its constituent
 * envelopes. The orchestrator joins multiple queued `ChannelMessage`s
 * with `\n` before sending to the agent, so one stored `AgentMessage`
 * can carry several `[<time>] <sender>: <body>` segments back-to-back.
 *
 * The splitter walks the lines and starts a new segment every time a
 * line both begins with `[` and successfully parses through
 * `unwrapMessageEnvelope`. Content that doesn't open with a bracketed
 * envelope is returned as a single segment with `sender: null` so the
 * caller renders it as a plain user bubble unchanged — this also
 * covers pre-envelope history that predates the orchestrator wrapper.
 */
export function splitEnvelopes(text: string): Array<{ sender: string | null; body: string }> {
  if (text.length === 0) return [];
  const lines = text.split('\n');

  // Trivial single-segment fast path: input doesn't look like an
  // envelope-prefixed batch.
  if (!lines[0].startsWith('[')) return [{ sender: null, body: text }];

  type Pending = { firstLine: string; rest: string[] } | null;
  const segments: Array<{ sender: string | null; body: string }> = [];
  let cur: Pending = null;

  const flush = () => {
    if (!cur) return;
    const joined = cur.rest.length > 0 ? `${cur.firstLine}\n${cur.rest.join('\n')}` : cur.firstLine;
    const env = unwrapMessageEnvelope(joined);
    if (env) {
      segments.push({ sender: env.sender, body: env.body });
    } else {
      // Bracket-shaped but doesn't unwrap (unknown sender, malformed):
      // emit as a plain segment so we never lose content.
      segments.push({ sender: null, body: joined });
    }
    cur = null;
  };

  for (const ln of lines) {
    if (ln.startsWith('[') && /^\[[^\]\n]+\] /.test(ln) && ln.includes(': ')) {
      // Possible envelope opener. Only commit to splitting if the line
      // actually parses — otherwise treat it as body of the current
      // segment (e.g. an inner `[Sprinkle Event: x]` line shouldn't
      // start a new envelope).
      const provisional = unwrapMessageEnvelope(ln);
      if (provisional) {
        flush();
        cur = { firstLine: ln, rest: [] };
        continue;
      }
    }
    if (cur) cur.rest.push(ln);
    else cur = { firstLine: ln, rest: [] };
  }
  flush();

  // If nothing parsed, fall back to the whole text as a single
  // unenveloped segment so callers don't drop data.
  if (segments.length === 0) return [{ sender: null, body: text }];
  return segments;
}

/**
 * Map an envelope sender name back to its `LickChannel`. Lick senders
 * are formatted by `host.ts` as `<channel>:<eventName>`; the channel
 * portion is the segment before the first colon and must be one of
 * the registered `LICK_CHANNELS`. Plain user input (`User`) and other
 * non-lick senders return null.
 */
export function lickChannelFromSenderName(sender: string): LickChannel | null {
  const colon = sender.indexOf(':');
  if (colon <= 0) return null;
  const channel = sender.slice(0, colon);
  return isLickChannel(channel) ? channel : null;
}

/**
 * Classify a lick by its BODY header when the sender carries no channel
 * prefix. Scoop lifecycle messages are sent with `senderName:
 * assistantLabel` (no `<channel>:` prefix), so the sender anchor can't see
 * them — but their bodies open with distinctive markers:
 *
 *   - `[@<scoop> completed]…`    — scoop-notify (a scoop finished its work)
 *   - `[@<scoop> idle]…`         — scoop-idle (the idle nag)
 *   - `[@<scoop> sudo-request]…` — sudo-request (a scoop is asking the cone
 *                                  to approve a gated action; emitted by
 *                                  `Orchestrator.formatSudoRequestNotification`)
 *   - `[scoop_wait completed]…` / `[scoop_wait timeout]…` — scoop-wait
 *
 * Without this, the live UI rendered them as lick cards (the broadcast
 * carries `channel`) but a history replay turned them into plain bubbles.
 */
export function lickChannelFromBody(body: string): LickChannel | null {
  const scoopMarker = /^\[@[^\]\s]+ (completed|idle)\]/.exec(body);
  if (scoopMarker) return scoopMarker[1] === 'idle' ? 'scoop-idle' : 'scoop-notify';
  if (/^\[@[^\]\s]+ sudo-request\]/.test(body)) return 'sudo-request';
  if (/^\[scoop_wait [^\]]+\]/.test(body)) return 'scoop-wait';
  if (body.startsWith('[Session Reload]')) return 'session-reload';
  return null;
}

/**
 * Recover an actionable lick id from a reconstructed lick body. Live cards
 * stamp `lickId` on the ChannelMessage; Pi history only has the body, which
 * carries `Lick ID:` (current sudo-request / upgrade / navigate envelopes)
 * or the older `Request ID:` sudo-request line. Does not set `lickState` —
 * the decision is not in Pi history (#3004).
 */
export function lickIdFromBody(body: string): string | undefined {
  return /^(?:Lick ID|Request ID): (\S+)/m.exec(body)?.[1];
}
