export const HANDOFF_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SLICC Handoff</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #11131a;
      --card: #191c24;
      --card-border: rgba(255, 255, 255, 0.08);
      --text: #f7f8fb;
      --muted: #b1b6c3;
      --accent: #ff5f72;
      --accent-2: #ff8f5f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top, rgba(255, 95, 114, 0.18), transparent 35%),
        linear-gradient(180deg, #161924 0%, var(--bg) 100%);
      color: var(--text);
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .shell {
      width: min(760px, 100%);
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: 20px;
      padding: 28px;
      box-shadow: 0 24px 72px rgba(0, 0, 0, 0.35);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 30px;
      line-height: 1.1;
    }
    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.6;
    }
    .status {
      margin-top: 22px;
      padding: 14px 16px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.06);
      font-weight: 600;
    }
    .status--error {
      color: #ffd3d8;
      background: rgba(255, 95, 114, 0.12);
      border-color: rgba(255, 95, 114, 0.26);
    }
    .preview {
      margin-top: 18px;
      padding: 18px;
      border-radius: 16px;
      background: rgba(0, 0, 0, 0.18);
      border: 1px solid rgba(255, 255, 255, 0.06);
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.65;
      font-size: 14px;
    }
    .help {
      margin-top: 22px;
      display: grid;
      gap: 10px;
    }
    .cta {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 18px;
      padding: 11px 16px;
      border-radius: 999px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      color: white;
      text-decoration: none;
      font-weight: 700;
      width: fit-content;
    }
    .muted {
      color: var(--muted);
      font-size: 13px;
      margin-top: 12px;
    }
  </style>
</head>
<body>
  <main class="shell">
    <h1>SLICC handoff</h1>
    <p>This page previews the handoff payload encoded in the URL fragment. If the SLICC extension is installed, look for the approval prompt in the Chat tab.</p>
    <div id="status" class="status">Reading handoff payload…</div>
    <div id="preview" class="preview" hidden></div>
    <div class="help">
      <p>If you do not see the approval prompt, open the SLICC side panel and look for the Chat tab badge.</p>
      <a class="cta" href="https://chromewebstore.google.com/detail/slicc/akggccfpkleihhemkkikggopnifgelbk" target="_blank" rel="noreferrer">Install the SLICC extension</a>
      <p class="muted">This page does not submit the handoff anywhere. The URL fragment itself is the transport.</p>
    </div>
  </main>
  <script>
    (function () {
      var statusEl = document.getElementById('status');
      var previewEl = document.getElementById('preview');

      function setStatus(text, isError) {
        statusEl.textContent = text;
        statusEl.classList.toggle('status--error', !!isError);
      }

      function toBytes(base64url) {
        var normalized = base64url.replace(/-/g, '+').replace(/_/g, '/');
        var padding = normalized.length % 4;
        if (padding) normalized += '='.repeat(4 - padding);
        var binary = atob(normalized);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes;
      }

      function normalizePayload(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new Error('Payload must be a JSON object.');
        }
        if (typeof payload.instruction !== 'string' || !payload.instruction.trim()) {
          throw new Error('Payload must include a non-empty "instruction" string.');
        }
        var optionalStrings = ['title', 'context', 'notes'];
        for (var i = 0; i < optionalStrings.length; i += 1) {
          var key = optionalStrings[i];
          if (key in payload && typeof payload[key] !== 'string') {
            throw new Error('"' + key + '" must be a string when provided.');
          }
        }
        var optionalArrays = ['urls', 'acceptanceCriteria'];
        for (var j = 0; j < optionalArrays.length; j += 1) {
          var listKey = optionalArrays[j];
          if (listKey in payload) {
            if (!Array.isArray(payload[listKey]) || payload[listKey].some(function (item) { return typeof item !== 'string'; })) {
              throw new Error('"' + listKey + '" must be an array of strings when provided.');
            }
          }
        }
        return payload;
      }

      function formatPreview(payload) {
        var parts = [];
        if (payload.title) parts.push('# ' + payload.title);
        parts.push('Instruction\\n' + payload.instruction);
        if (payload.urls && payload.urls.length) parts.push('URLs\\n- ' + payload.urls.join('\\n- '));
        if (payload.context) parts.push('Context\\n' + payload.context);
        if (payload.acceptanceCriteria && payload.acceptanceCriteria.length) {
          parts.push('Acceptance Criteria\\n- ' + payload.acceptanceCriteria.join('\\n- '));
        }
        if (payload.notes) parts.push('Notes\\n' + payload.notes);
        return parts.join('\\n\\n');
      }

      var fragment = location.hash.replace(/^#/, '');
      if (!fragment) {
        setStatus('No handoff payload was found in the URL fragment.', true);
        return;
      }

      try {
        var bytes = toBytes(fragment);
        var json = new TextDecoder().decode(bytes);
        var payload = normalizePayload(JSON.parse(json));
        previewEl.hidden = false;
        previewEl.textContent = formatPreview(payload);
        setStatus('Handoff payload loaded. Check SLICC for the approval prompt.', false);
      } catch (error) {
        previewEl.hidden = true;
        setStatus('Invalid handoff payload: ' + (error && error.message ? error.message : String(error)), true);
      }
    })();
  </script>
</body>
</html>`;
