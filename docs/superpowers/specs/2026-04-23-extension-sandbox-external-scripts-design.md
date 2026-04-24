# Extension Sandbox External Script Loading

## Problem

Three issues prevent external scripts from working in Chrome extension manifest sandbox pages:

1. **Sprinkle external scripts** — `<script src="https://unpkg.com/...">` blocked by sandbox CSP (`script-src 'self' 'unsafe-inline' 'unsafe-eval'`, no external origins)
2. **node -e ESM imports** — `import('https://esm.sh/...')` blocked by same CSP; blob URL fallback also blocked since `blob:` isn't in `script-src`
3. **Dynamic script injection in sprinkle-sandbox** — `document.createElement('script').src = 'slicc-editor.js'` fails at runtime because the sandbox's opaque origin (`null`) can't access `chrome-extension://` URLs dynamically (the same scripts work when loaded statically in `<head>` at page init)

Root cause: Chrome MV3 manifest sandbox pages get an opaque origin and a fixed CSP that can't be customized. `unsafe-inline` and `unsafe-eval` are allowed, but no external script sources.

## Fix 1: Fetch-and-inline external scripts in sprinkles

### Full-doc path (`sprinkle-renderer.ts`)

Extend the existing pattern in `renderInSandbox()` (lines 266-293) where `editorScript`/`diffScript`/`lucideScript` are fetched and inlined. Before sending HTML to the sandbox via `postMessage`:

1. Parse the HTML for all `<script src="...">` tags with `https:` URLs
2. Fetch each script's content via `fetch()` in the side panel (has network access)
3. Replace each tag with `<script>/* fetched content */</script>`, preserving document order
4. Send the modified HTML to the sandbox

**Execution order**: Fetch all scripts in parallel for speed, but replace them in document order. The HTML string manipulation preserves the relative position of external scripts vs inline scripts.

**URL filtering**: Only transform `https:` (and `http:`) external URLs. Skip relative paths (already handled), `data:` URLs, `javascript:` URLs, and `chrome-extension:` URLs.

**Error handling**: If a fetch fails, replace the script tag with `<script>console.error('Failed to load: URL')</script>` so the sprinkle gets feedback instead of silent failure.

### Partial-content path (`sprinkle-sandbox.html`)

The partial-content renderer (lines 416-458) sets `innerHTML` then re-creates `<script>` elements. External `src` attributes on these scripts fail in the sandbox's opaque origin.

Transform external scripts before the re-execution loop: scan `document.body` for `<script>` nodes with `https:` src, fetch their content (see fetch story below), and rewrite to inline before cloning into live script elements.

**Fetch story**: The sandbox has a null origin, so `fetch('https://...')` only works if the CDN sends permissive CORS headers. For reliability, add a small parent relay: sandbox sends `postMessage({ type: 'fetch-script', url })` to the parent (side panel), parent calls `fetch(url)`, returns `postMessage({ type: 'fetch-script-response', url, text })`. Same pattern as the existing VFS read/write relay. This guarantees the fetch works regardless of CORS policy.

### Security

This executes network-fetched code in a CSP-exempt sandbox. This is acceptable because sprinkle content is agent/user-authored (trusted), same as the existing pattern where sprinkle inline scripts already run with `unsafe-eval`. The trust boundary is the same — we're just removing a transport restriction, not expanding the trust model. The `unsafe-eval` capability is already part of Chrome's manifest sandbox CSP by design.

## Fix 2: esm.sh `?bundle` + eval for node -e

### Change in `node-command.ts`

In the `__loadModule` function (extension sandbox wrapper, lines 297-313), replace the blob URL import fallback:

**Before**: `fetch(url)` then `response.text()` then `Blob` then `URL.createObjectURL` then `import(blobUrl)`

**After**: `fetch(url + '?bundle')` then `response.text()` then evaluate the bundled IIFE text

The `?bundle` query param makes esm.sh return a self-contained IIFE with no ES module syntax. The sandbox already has `unsafe-eval` in its CSP (Chrome's default for manifest sandbox pages), which is what makes `node -e` work in the first place (the entire code string is evaluated dynamically). The bundled script text is evaluated using the same mechanism.

### Return value contract

The `?bundle` format from esm.sh wraps the module as a self-executing script that assigns to a global variable. The calling code currently expects `mod.default` or `mod` as a namespace object. After evaluating the bundle text:

- If the bundle attaches to `globalThis` (common for UMD-style output), extract the known global
- Alternatively, wrap the eval to capture exports
- Test with real packages (lodash, dayjs, chalk) to verify the return shape matches what `__requireCache` consumers expect

### URL details

The exact URL format matters for reproducibility. Use `https://esm.sh/PACKAGE@VERSION?bundle` when a version is specified in `require()`, or `https://esm.sh/PACKAGE?bundle` for unversioned. No additional query params needed unless specific issues arise.

### CLI path

The CLI path (non-extension) continues using `import('https://esm.sh/' + id)` directly since it runs in a regular page context with no CSP restrictions. The `?bundle` + eval path is extension-only.

## Fix 3: Remove broken dynamic script injection

Remove lines 430-441 in `sprinkle-sandbox.html` — the `customElements.get('slicc-editor')` / `customElements.get('slicc-diff')` checks and dynamic `<script src>` injection.

These custom element bundles are already loaded by the top-level `<script src="slicc-editor.js">` / `<script src="slicc-diff.js">` at lines 8-10 during page init. The dynamic fallback:

- Fails with opaque origin error in extension mode
- Is redundant since the elements are already registered from the initial load
- Costs nothing to remove since the initial load covers all cases

The top-level script tags load on every sandbox page load regardless of whether the sprinkle uses custom elements. This is a small cost (~30KB for editor + diff) but acceptable since the sandbox page is already loaded.

## Files changed

| File                                                              | Change                                                                                                                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/webapp/src/ui/sprinkle-renderer.ts`                     | Scan and fetch-inline external `https:` scripts in full-doc HTML before postMessage                                                                   |
| `packages/chrome-extension/sprinkle-sandbox.html`                 | Add fetch-script parent relay for partial path; remove dead dynamic CE injection (lines 430-441); transform external scripts before re-execution loop |
| `packages/webapp/src/shell/supplemental-commands/node-command.ts` | `?bundle` URL + eval fallback in `__loadModule`                                                                                                       |

## Testing

- Sprinkle with `<script src="https://cdn.jsdelivr.net/npm/lodash/lodash.min.js">` renders and `_.VERSION` is accessible in extension mode
- Script execution order: library loaded before inline script that uses it
- `node -e "const _ = require('lodash'); console.log(_.VERSION)"` works in extension mode
- Custom elements (slicc-editor, slicc-diff) still render in extension partial-content sprinkles
- CLI mode: no regression for sprinkles with external scripts
- CLI mode: no regression for `node -e require()`
- Fetch failure: sprinkle shows error in console, doesn't crash
