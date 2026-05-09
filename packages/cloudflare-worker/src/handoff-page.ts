/**
 * `/handoff` route handler.
 *
 * The response advertises a SLICC handoff via an RFC 8288 `Link` header.
 * SLICC clients (CDP navigation watcher in CLI/Electron, chrome.webRequest
 * observer in the extension) parse the header and emit a `navigate` lick
 * event; the user approves the action from inside SLICC.
 *
 * Accepted query forms:
 *
 *   ?upskill=<github-url>
 *     → Link: <github-url>; rel="https://www.sliccy.ai/rel/upskill"
 *
 *   ?handoff=<text>
 *     → Link: <>; rel="https://www.sliccy.ai/rel/handoff";
 *             title*=UTF-8''<percent-encoded text>
 *
 *   ?msg=verb:payload   (legacy URL shape — colon-prefix split server-side)
 *     verb ∈ {handoff, upskill}; payload is the same as the dedicated
 *     forms above. Lets clients that already build the legacy URL keep
 *     working without re-implementing query construction.
 *
 * The page body is a minimal informational preview; no payload parsing
 * happens client-side.
 */

const HANDOFF_REL = 'https://www.sliccy.ai/rel/handoff';
const UPSKILL_REL = 'https://www.sliccy.ai/rel/upskill';

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SLICC Handoff</title>
  <style>
    :root { color-scheme: dark; --bg:#11131a; --card:#191c24; --text:#f7f8fb; --muted:#b1b6c3; --accent:#ff5f72; --accent-2:#ff8f5f; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at top, rgba(255, 95, 114, 0.18), transparent 35%), linear-gradient(180deg, #161924 0%, var(--bg) 100%);
      color: var(--text);
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .shell {
      width: min(620px, 100%);
      background: var(--card);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 20px;
      padding: 28px;
      box-shadow: 0 24px 72px rgba(0,0,0,0.35);
    }
    h1 { margin: 0 0 10px; font-size: 28px; line-height: 1.1; }
    p { margin: 0; color: var(--muted); line-height: 1.6; }
    .payload {
      margin-top: 18px;
      padding: 14px 16px;
      border-radius: 14px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.06);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      word-break: break-word;
    }
    .cta {
      display: inline-flex;
      align-items: center;
      margin-top: 18px;
      padding: 11px 16px;
      border-radius: 999px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      color: white;
      text-decoration: none;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <main class="shell">
    <h1>SLICC handoff</h1>
    <p>This response advertises a <code>Link</code> header carrying a SLICC handoff rel. If SLICC is running, approve the prompt there to continue.</p>
    <div class="payload" id="payload">(no payload)</div>
    <a class="cta" href="https://chromewebstore.google.com/detail/slicc/akjjllgokmbgpbdbmafpiefnhidlmbgf" target="_blank" rel="noreferrer">Install SLICC</a>
  </main>
  <script>
    (function () {
      var params = new URLSearchParams(location.search);
      var msg = params.get('handoff') || params.get('upskill') || params.get('msg');
      if (msg) document.getElementById('payload').textContent = msg;
    })();
  </script>
</body>
</html>`;

const MAX_PAYLOAD_LEN = 4096;

interface ResolvedHandoff {
  verb: 'handoff' | 'upskill';
  /** Raw payload as received (URL for upskill, prose for handoff). */
  payload: string;
}

/**
 * Enforce that an upskill payload is a clean `https://github.com/…` URL.
 * Returns the URL parser's canonical form (which percent-encodes any CR/LF,
 * whitespace, or other characters that would otherwise let an attacker break
 * out of the `Link` header's URI-reference). Returns `null` for anything that
 * isn't a parseable URL on github.com over https.
 */
function sanitizeUpskillTarget(payload: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(payload);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== 'github.com') return null;
  const canonical = parsed.toString();
  // Defense in depth: refuse if `<`, `>`, or any control character somehow
  // survives URL canonicalization. `URL.toString()` percent-encodes these in
  // every shape we expect, but a belt-and-braces check is cheap.
  if (/[<>\x00-\x20\x7f]/.test(canonical)) return null;
  return canonical;
}

function resolveHandoff(url: URL): ResolvedHandoff | null {
  const handoff = url.searchParams.get('handoff');
  if (handoff && handoff.length > 0) {
    return { verb: 'handoff', payload: handoff.slice(0, MAX_PAYLOAD_LEN) };
  }
  const upskill = url.searchParams.get('upskill');
  if (upskill && upskill.length > 0) {
    const safe = sanitizeUpskillTarget(upskill.slice(0, MAX_PAYLOAD_LEN));
    if (safe) return { verb: 'upskill', payload: safe };
    return null;
  }
  // Legacy `?msg=verb:payload` — split the colon prefix server-side.
  const msg = url.searchParams.get('msg');
  if (msg && msg.length > 0) {
    const trimmed = msg.slice(0, MAX_PAYLOAD_LEN);
    const colon = trimmed.indexOf(':');
    if (colon > 0) {
      const verb = trimmed.slice(0, colon);
      const payload = trimmed.slice(colon + 1);
      if (verb === 'upskill') {
        const safe = sanitizeUpskillTarget(payload);
        if (safe) return { verb: 'upskill', payload: safe };
        return null;
      }
      if (verb === 'handoff') {
        return { verb, payload };
      }
    }
    // Verb missing or unknown — default to `handoff:` so users get the
    // approval prompt rather than a silent drop.
    return { verb: 'handoff', payload: trimmed };
  }
  return null;
}

/**
 * Build a single RFC 8288 link-value carrying the SLICC handoff. The verb is
 * encoded as the rel; the payload becomes the link href (upskill) or the
 * `title*` parameter (handoff). CR/LF and non-Latin1 are always RFC 8187
 * percent-encoded — header injection is impossible by construction.
 */
function buildHandoffLinkValue(handoff: ResolvedHandoff): string {
  if (handoff.verb === 'upskill') {
    // Payload is already canonicalized + allowlisted by `sanitizeUpskillTarget`,
    // so no header-injection or unintended-link payload is reachable here.
    return `<${handoff.payload}>; rel="${UPSKILL_REL}"`;
  }
  // handoff: target is the page itself (`<>` self-anchor); instruction in title*.
  return `<>; rel="${HANDOFF_REL}"; title*=UTF-8''${encodeRFC8187(handoff.payload)}`;
}

function encodeRFC8187(value: string): string {
  // attr-char per RFC 8187: ALPHA / DIGIT / "!#$&+-.^_`|~"
  const bytes = new TextEncoder().encode(value);
  let out = '';
  for (const byte of bytes) {
    if (
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x21 ||
      byte === 0x23 ||
      byte === 0x24 ||
      byte === 0x26 ||
      byte === 0x2b ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5e ||
      byte === 0x5f ||
      byte === 0x60 ||
      byte === 0x7c ||
      byte === 0x7e
    ) {
      out += String.fromCharCode(byte);
    } else {
      out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

export function buildHandoffResponse(request: Request): Response {
  const url = new URL(request.url);
  const handoff = resolveHandoff(url);

  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
  if (handoff) {
    headers.append('Link', buildHandoffLinkValue(handoff));
  }
  return new Response(PAGE_HTML, { status: 200, headers });
}
