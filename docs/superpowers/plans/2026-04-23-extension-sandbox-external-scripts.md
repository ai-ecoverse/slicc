# Extension Sandbox External Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make external CDN scripts work in extension sprinkles, fix `node -e require()` in extension mode, and clean up broken sandbox script injection.

**Architecture:** Four independent fixes: (1) fetch-and-inline external `<script src>` in sprinkle rendering pipeline, (2) esm.sh `?bundle` + `new Function` for node -e, (3) remove broken dynamic CE injection, (4) guard lucide MutationObserver against null body. Fixes 3 and 4 are small and independent; fixes 1 and 2 are the bulk of the work.

**Tech Stack:** TypeScript, Chrome Extension sandbox pages, postMessage relay, Vitest

**Spec:** `docs/superpowers/specs/2026-04-23-extension-sandbox-external-scripts-design.md`

---

### File Map

| File                                                              | Action | Responsibility                                                                               |
| ----------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| `packages/webapp/src/ui/lucide-icons.ts`                          | Modify | Guard MutationObserver against null body                                                     |
| `packages/chrome-extension/sprinkle-sandbox.html`                 | Modify | Remove dead CE injection; add fetch-script relay; transform external scripts in partial path |
| `packages/webapp/src/ui/sprinkle-renderer.ts`                     | Modify | Fetch-and-inline external scripts for full-doc; handle fetch-script relay from sandbox       |
| `packages/webapp/src/shell/supplemental-commands/node-command.ts` | Modify | `?bundle` URL + `new Function` fallback                                                      |

---

### Task 1: Fix lucide MutationObserver null body crash

**Files:**

- Modify: `packages/webapp/src/ui/lucide-icons.ts:75-106`

- [ ] **Step 1: Fix the observer initialization**

Replace lines 75-106 (the readyState check + observer setup) with a unified version that defers both render and observer to DOMContentLoaded:

```typescript
const observer = new MutationObserver((mutations) => {
  let hasNewIcons = false;
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (el.hasAttribute?.('data-lucide') || el.querySelector?.('[data-lucide]')) {
          hasNewIcons = true;
          break;
        }
      }
    }
    if (hasNewIcons) break;
  }
  if (hasNewIcons) {
    (window as any).LucideIcons.render();
  }
});

function startLucide() {
  (window as any).LucideIcons.render();
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startLucide);
} else {
  startLucide();
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: All pass (no existing lucide-specific tests, but no regressions)

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/webapp/src/ui/lucide-icons.ts
git add packages/webapp/src/ui/lucide-icons.ts
git commit -m "fix: guard lucide MutationObserver against null document.body

Loads in <head> before <body> exists in sprinkle-sandbox.html.
Defer observer.observe() to DOMContentLoaded alongside render()."
```

---

### Task 2: Remove broken dynamic CE injection

**Files:**

- Modify: `packages/chrome-extension/sprinkle-sandbox.html:427-441`

- [ ] **Step 1: Remove the dynamic injection block**

In `sprinkle-sandbox.html`, delete lines 427-441 (the `customElements.get()` checks and dynamic `<script src>` injection):

```javascript
// Lazy-load custom element bundles before executing sprinkle scripts.
// Uses synchronous script injection so elements are registered before use.
var contentStr = msg.content || '';
if (contentStr.indexOf('<slicc-editor') !== -1 && !customElements.get('slicc-editor')) {
  var edScript = document.createElement('script');
  edScript.src = 'slicc-editor.js';
  edScript.async = false;
  document.head.appendChild(edScript);
}
if (contentStr.indexOf('<slicc-diff') !== -1 && !customElements.get('slicc-diff')) {
  var dfScript = document.createElement('script');
  dfScript.src = 'slicc-diff.js';
  dfScript.async = false;
  document.head.appendChild(dfScript);
}
```

These bundles are already loaded at lines 8-10 via `<script src>` in `<head>`.

- [ ] **Step 2: Build extension to verify**

Run: `npm run build -w @slicc/chrome-extension`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/chrome-extension/sprinkle-sandbox.html
git add packages/chrome-extension/sprinkle-sandbox.html
git commit -m "fix: remove broken dynamic CE script injection in sprinkle-sandbox

The dynamic createElement('script').src fails with opaque origin error.
Custom elements are already loaded from <head> at page init (lines 8-10)."
```

---

### Task 3: Fetch-and-inline external scripts for full-doc sprinkles

**Files:**

- Modify: `packages/webapp/src/ui/sprinkle-renderer.ts:266-314`

- [ ] **Step 1: Add the external script inlining function**

Add this function before the `SprinkleRenderer` class (near the top of the file, after the imports):

```typescript
const EXTERNAL_SCRIPT_RE =
  /<script\b([^>]*)\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']([^>]*)><\/script>/gi;

async function inlineExternalScripts(html: string): Promise<string> {
  const matches: { full: string; url: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = EXTERNAL_SCRIPT_RE.exec(html)) !== null) {
    matches.push({ full: match[0], url: match[2], index: match.index });
  }
  EXTERNAL_SCRIPT_RE.lastIndex = 0;
  if (matches.length === 0) return html;

  const fetched = await Promise.all(
    matches.map(async (m) => {
      try {
        const resp = await fetch(m.url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return { ...m, text: await resp.text() };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ...m, text: `console.error('[sprinkle] Failed to load ${m.url}: ${msg}')` };
      }
    })
  );

  let result = html;
  for (let i = fetched.length - 1; i >= 0; i--) {
    const { full, text } = fetched[i];
    const escaped = text.replace(/<\/script/gi, '<\\/script');
    result = result.replace(full, `<script>${escaped}</script>`);
  }

  return result;
}
```

Key details:

- Regex matches only `https://` and `http://` src URLs (skips relative, data:, javascript:)
- Fetches all in parallel for speed
- Replaces in reverse order to preserve string indices
- Escapes closing script tags in fetched text to prevent premature tag termination
- On fetch failure, inlines a `console.error` so the sprinkle author gets feedback

- [ ] **Step 2: Call it in renderInSandbox before postMessage**

In the `renderInSandbox` method, after the existing editor/diff/lucide fetch block (around line 292, after `await Promise.all(fetches)`) and before the `postMessage`, add the inlining call. The `content` parameter to `render()` flows through to `renderInSandbox()`. Check whether it's reassignable — if not, use a new variable:

```typescript
// Inline external CDN scripts (CSP blocks remote src in sandbox)
const processedContent = fullDoc ? await inlineExternalScripts(content) : content;
```

Then use `processedContent` instead of `content` in the `postMessage` call on the `content` field.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/webapp/src/ui/sprinkle-renderer.ts
git add packages/webapp/src/ui/sprinkle-renderer.ts
git commit -m "feat: fetch-and-inline external scripts for full-doc sprinkles

Extension sandbox CSP blocks <script src='https://...'>.
Scans HTML for external script tags, fetches in parallel, replaces
with inline <script> blocks preserving document order."
```

---

### Task 4: Fetch-script relay for partial-content sprinkles

**Files:**

- Modify: `packages/webapp/src/ui/sprinkle-renderer.ts` (message handler in renderInSandbox)
- Modify: `packages/chrome-extension/sprinkle-sandbox.html` (partial-content script re-execution)

- [ ] **Step 1: Add fetch-script relay handler in sprinkle-renderer.ts**

In the `renderInSandbox` method's message handler (the `this.messageHandler = (event: MessageEvent) => { ... }` block), add a new handler for `sprinkle-fetch-script` messages. Add it alongside the existing `sprinkle-readfile` handler:

```typescript
      } else if (msg.type === 'sprinkle-fetch-script') {
        const url = msg.url as string;
        const id = msg.id as string;
        fetch(url)
          .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((text) => {
            iframe.contentWindow?.postMessage(
              { type: 'sprinkle-fetch-script-response', id, url, text },
              '*'
            );
          })
          .catch((err: unknown) => {
            iframe.contentWindow?.postMessage(
              {
                type: 'sprinkle-fetch-script-response',
                id,
                url,
                error: err instanceof Error ? err.message : String(err),
              },
              '*'
            );
          });
```

- [ ] **Step 2: Transform external scripts in sprinkle-sandbox partial path**

In `sprinkle-sandbox.html`, replace the script re-execution block (the `deadScripts` loop, currently around lines 443-458 after removing the CE block in Task 2) with an async version that resolves external scripts via the parent relay:

```javascript
var deadScripts = Array.from(document.body.querySelectorAll('script'));
var __fid = 0;

function fetchScriptViaRelay(url) {
  return new Promise(function (resolve, reject) {
    var id = 'fs-' + ++__fid;
    function handler(event) {
      if (
        event.data &&
        event.data.type === 'sprinkle-fetch-script-response' &&
        event.data.id === id
      ) {
        removeEventListener('message', handler);
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.text);
      }
    }
    addEventListener('message', handler);
    parent.postMessage({ type: 'sprinkle-fetch-script', id: id, url: url }, '*');
  });
}

(async function executeScripts() {
  for (var j = 0; j < deadScripts.length; j++) {
    var dead = deadScripts[j];
    dead.remove();
    var live = document.createElement('script');
    for (var k = 0; k < dead.attributes.length; k++) {
      if (dead.attributes[k].name === 'src') continue;
      live.setAttribute(dead.attributes[k].name, dead.attributes[k].value);
    }
    if (dead.src && /^https?:\/\//.test(dead.src)) {
      try {
        var text = await fetchScriptViaRelay(dead.src);
        live.textContent = text;
      } catch (err) {
        live.textContent =
          "console.error('[sprinkle] Failed to load " +
          dead.src +
          ": ' + " +
          JSON.stringify(err.message) +
          ')';
      }
    } else if (!dead.src) {
      live.textContent = dead.textContent;
    }
    document.body.appendChild(live);
  }
  parent.postMessage({ type: 'sprinkle-rendered' }, '*');
})();
```

Important: remove the existing `parent.postMessage({ type: 'sprinkle-rendered' }, '*');` at the end of the partial block since `executeScripts()` now sends it after all scripts are resolved.

- [ ] **Step 3: Add relay types to forwarding arrays**

In the `responseTypes` array (around line 474), add `'sprinkle-fetch-script-response'`:

```javascript
var responseTypes = [
  'sprinkle-readfile-response',
  'sprinkle-writefile-response',
  'sprinkle-readdir-response',
  'sprinkle-exists-response',
  'sprinkle-stat-response',
  'sprinkle-mkdir-response',
  'sprinkle-rm-response',
  'sprinkle-fetch-script-response',
];
```

In the `bridgeTypes` array (around line 498-506), add `'sprinkle-fetch-script'`:

```javascript
var bridgeTypes = [
  'sprinkle-lick',
  'sprinkle-set-state',
  'sprinkle-close',
  'sprinkle-stop-cone',
  'sprinkle-open',
  'sprinkle-readfile',
  'sprinkle-writefile',
  'sprinkle-readdir',
  'sprinkle-exists',
  'sprinkle-stat',
  'sprinkle-mkdir',
  'sprinkle-rm',
  'sprinkle-storage-set',
  'sprinkle-storage-remove',
  'sprinkle-storage-clear',
  'inline-sprinkle-lick',
  'inline-sprinkle-height',
  'sprinkle-fetch-script',
];
```

- [ ] **Step 4: Run typecheck and build**

Run: `npm run typecheck && npm run build -w @slicc/chrome-extension`
Expected: Both PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/ui/sprinkle-renderer.ts packages/chrome-extension/sprinkle-sandbox.html
git add packages/webapp/src/ui/sprinkle-renderer.ts packages/chrome-extension/sprinkle-sandbox.html
git commit -m "feat: fetch-script relay for partial-content sprinkle external scripts

Sandbox can't fetch cross-origin (null origin, CORS). Add parent
relay: sandbox sends sprinkle-fetch-script, renderer fetches in
side panel, returns sprinkle-fetch-script-response. Scripts resolved
in document order before execution."
```

---

### Task 5: esm.sh `?bundle` + `new Function` for node -e

**Files:**

- Modify: `packages/webapp/src/shell/supplemental-commands/node-command.ts:297-313`

- [ ] **Step 1: Replace the \_\_loadModule function in the extension wrapper**

In `node-command.ts`, find the `__loadModule` function inside the `wrappedCode` template string (around line 297). Replace the entire function (lines 297-314):

Before:

```javascript
async function __loadModule(id) {
  const url = 'https://esm.sh/' + id;
  try {
    return await import(url);
  } catch (e) {
    // Fallback for sandbox/extension mode: fetch + blob URL
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' fetching ' + url);
    const text = await resp.text();
    const blob = new Blob([text], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    try {
      return await import(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }
}
```

After:

```javascript
async function __loadModule(id) {
  var parsedUrl = new URL('https://esm.sh/' + id);
  parsedUrl.searchParams.set('bundle', '');
  var url = parsedUrl.toString();
  try {
    return await import(url);
  } catch (e) {
    var resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' fetching ' + url);
    var text = await resp.text();
    var __mod = { exports: {} };
    new Function('module', 'exports', text)(__mod, __mod.exports);
    if (Object.keys(__mod.exports).length > 0) return __mod.exports;
    return __mod.exports;
  }
}
```

Key details:

- Uses `URL` parsing to safely append `?bundle` (handles IDs that already have query strings)
- First tries `import(url)` (works in CLI mode where CSP allows it)
- Fallback: fetches bundled IIFE, evaluates with `new Function` using a module/exports shim
- `new Function` requires `unsafe-eval` which the sandbox already has

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/webapp/src/shell/supplemental-commands/node-command.ts
git add packages/webapp/src/shell/supplemental-commands/node-command.ts
git commit -m "feat: esm.sh ?bundle + new Function for node -e in extension mode

import() and blob URL imports are blocked by sandbox CSP. Use ?bundle
to get a self-contained IIFE from esm.sh, evaluate with new Function
(unsafe-eval is allowed in sandbox). URL parsed safely for IDs with
existing query strings."
```

---

### Task 6: Verification

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Run full test suite**

Run: `npm run test`
Expected: All pass

- [ ] **Step 3: Build extension**

Run: `npm run build -w @slicc/chrome-extension`
Expected: PASS

- [ ] **Step 4: Build webapp (CLI)**

Run: `npm run build -w @slicc/webapp`
Expected: PASS

- [ ] **Step 5: Manual test — extension sprinkle with external script**

1. Load extension from `dist/extension/`
2. Create a sprinkle with `<script src="https://cdn.jsdelivr.net/npm/lodash@4/lodash.min.js"></script>` and inline script that uses `_.VERSION`
3. Verify it renders and the library is accessible

- [ ] **Step 6: Manual test — script execution order**

1. Create a sprinkle with external library `<script src>` followed by inline `<script>` that calls library code
2. Verify inline script runs after library is loaded (no "undefined" errors)

- [ ] **Step 7: Manual test — node -e require in extension**

1. In extension terminal: `node -e "const _ = require('lodash'); console.log(_.VERSION)"`
2. Verify output shows the lodash version

- [ ] **Step 8: Manual test — no MutationObserver error**

1. Open extension, check console for `TypeError: Failed to execute 'observe' on 'MutationObserver'`
2. Verify the error is gone

- [ ] **Step 9: Manual test — CLI mode regression**

1. Run `npm run dev`
2. Test sprinkle with external script — still works
3. Test `node -e "const _ = require('lodash'); console.log(_.VERSION)"` — still works

- [ ] **Step 10: Manual test — custom elements**

1. In extension, create a sprinkle that uses `<slicc-editor>`
2. Verify it renders (partial-content mode, no opaque-origin error in console)
