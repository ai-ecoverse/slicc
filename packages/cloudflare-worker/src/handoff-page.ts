/**
 * `/handoff` route handler.
 *
 * When visited, the response carries an `x-slicc` header with the opaque
 * instruction string taken from the `msg` query parameter. SLICC clients
 * observe that header on main-frame navigations and emit a `navigate` lick
 * event; the user approves the action from inside SLICC.
 *
 * The response body is a minimal informational page describing what is
 * happening. No payload parsing happens server-side — the header value is
 * passed through verbatim.
 */

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
    <p>This response carried an <code>x-slicc</code> header. If SLICC is running, approve the prompt there to continue.</p>
    <div class="payload" id="payload">(no payload)</div>
    <a class="cta" href="https://chromewebstore.google.com/detail/slicc/akjjllgokmbgpbdbmafpiefnhidlmbgf" target="_blank" rel="noreferrer">Install SLICC</a>
  </main>
  <script>
    (function () {
      var params = new URLSearchParams(location.search);
      var msg = params.get('msg');
      if (msg) document.getElementById('payload').textContent = msg;
    })();
  </script>
</body>
</html>`;

/**
 * Build the `/handoff` response.
 *
 * The `msg` query parameter is percent-encoded before being written to the
 * `x-slicc` response header. This avoids `Headers.set` rejecting non-Latin1
 * input (emoji, CJK, etc.) and neutralises CR/LF header-injection attempts.
 * SLICC clients `decodeURIComponent` the value on read.
 *
 * Missing or empty `msg` falls back to an informational page with no header.
 */
export function buildHandoffResponse(request: Request): Response {
  const url = new URL(request.url);
  const rawMsg = url.searchParams.get('msg') ?? '';
  const msg = rawMsg.slice(0, 4096);

  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
  if (msg.length > 0) {
    headers.set('x-slicc', encodeURIComponent(msg));
  }

  return new Response(PAGE_HTML, { status: 200, headers });
}
