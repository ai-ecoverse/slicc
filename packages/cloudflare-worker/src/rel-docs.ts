/**
 * Documentation pages for the SLICC custom RFC 8288 link relations.
 *
 * Per RFC 8288 §2.1.2, extension link relation types SHOULD be URIs that
 * resolve to documentation. These tiny static pages satisfy that.
 */

interface RelInfo {
  title: string;
  summary: string;
  example: string;
}

const RELS: Record<string, RelInfo> = {
  handoff: {
    title: 'rel: handoff',
    summary:
      "Used by SLICC to receive a free-form instruction handoff from another agent or page. The link target is the page itself (`<>` self-anchor); the prose instruction rides in the link's `title` parameter (RFC 8187 `title*=UTF-8\\'\\'…` for non-ASCII).",
    example:
      'Link: &lt;&gt;; rel="https://www.sliccy.ai/rel/handoff"; title*=UTF-8\\\'\\\'Continue%20the%20signup%20flow',
  },
  upskill: {
    title: 'rel: upskill',
    summary:
      'Used by SLICC to install a skill from a public GitHub repository. The link target is the GitHub repo URL.',
    example:
      'Link: &lt;https://github.com/slicc/skills-extra&gt;; rel="https://www.sliccy.ai/rel/upskill"',
  },
};

function pageHtml(name: string, info: RelInfo): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${info.title} — SLICC</title>
  <style>
    :root { color-scheme: dark; --bg:#11131a; --card:#191c24; --text:#f7f8fb; --muted:#b1b6c3; --accent:#ff5f72; --accent-2:#ff8f5f; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; font-family: ui-sans-serif, system-ui, sans-serif;
      background: radial-gradient(circle at top, rgba(255,95,114,0.18), transparent 35%), linear-gradient(180deg,#161924 0%, var(--bg) 100%);
      color: var(--text); display:grid; place-items:center; padding:24px; }
    .shell { width: min(720px, 100%); background: var(--card); border:1px solid rgba(255,255,255,0.08);
      border-radius:20px; padding:28px; box-shadow:0 24px 72px rgba(0,0,0,0.35); }
    h1 { margin:0 0 10px; font-size:26px; }
    p { margin:0 0 12px; color: var(--muted); line-height:1.6; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    pre { background: rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.06);
      border-radius:14px; padding:14px 16px; white-space: pre-wrap; word-break: break-all; }
    a { color: var(--accent-2); }
  </style>
</head>
<body>
  <main class="shell">
    <h1>${info.title}</h1>
    <p>${info.summary}</p>
    <p>Example header value:</p>
    <pre>${info.example}</pre>
    <p>Spec context: <a href="https://www.rfc-editor.org/rfc/rfc8288">RFC 8288</a> (Web Linking) and <a href="https://www.rfc-editor.org/rfc/rfc8187">RFC 8187</a> (parameter ext-value).</p>
    <p>SLICC overview: <a href="https://github.com/ai-ecoverse/slicc/blob/main/docs/slicc-handoff.md">docs/slicc-handoff.md</a>.</p>
  </main>
</body>
</html>`;
}

/** Build a response for `GET /rel/:name`. Returns 404 for unknown rels. */
export function buildRelResponse(name: string): Response {
  const info = RELS[name];
  if (!info) {
    return new Response('Unknown rel.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(pageHtml(name, info), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export const REL_NAMES = Object.keys(RELS);
