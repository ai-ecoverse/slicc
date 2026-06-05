---
name: sprinkles
description: |
  Use this when the user wants a persistent UI panel — a dashboard, form,
  editor, report, or visualization that lives alongside the chat. Sprinkles are
  `.shtml` files under `/shared/sprinkles/` rendered in the side rail or as a
  full-screen tab. For ephemeral inline widgets, use dips instead. Covers
  creation, modification, layout constraints, the cone-to-scoop orchestration
  rules, the `slicc.*` bridge API, and `sprinkle chat` for blocking inline
  prompts.
allowed-tools: bash, read_file, write_file, edit_file
---

# Sprinkles

`.shtml` files in `/shared/sprinkles/` become interactive UI panels. Use them for dashboards, forms, and visualizations that persist alongside the chat.

## Two rendering modes

- **Fragment mode** (default): plain HTML fragments injected into the sidebar. Do NOT use `<!DOCTYPE html>`, `<html>`, `<head>`, `<body>`, or custom CSS — use the built-in `.sprinkle-*` classes. Scripts get a `slicc` bridge object automatically.
- **Full-document mode**: complete HTML documents (starting with `<!DOCTYPE html>` or `<html>`) render inside sandboxed iframes. Use this for complex layouts with custom CSS, sidebars, split panes, modals, or canvas/SVG visualizations. The bridge script is auto-injected — `window.slicc` and `window.bridge` are available. The parent page's S2 theme tokens are injected automatically.

Pick full-document mode when you need custom CSS beyond `.sprinkle-*` classes, complex layouts (sidebar + main, split panes, tabs), or interactive canvas/SVG.

## Light & dark mode

Theming is **automatic**. The parent injects its S2 tokens into every sprinkle and toggles a `.theme-light` class on the sprinkle root — the iframe's `<html>` in full-document mode, or the outermost container injected into the sidebar in fragment mode — whenever the user flips the parent theme. All `var(--s2-*)` tokens swap in lockstep. **Never hard-code colors for one theme.**

- Use S2 tokens (`var(--s2-content-default)`, `var(--s2-bg-layer-2)`, etc.) for everything — see `style-guide.md` for the full reference.
- For one-off colors not covered by an S2 token, use CSS `light-dark(<light>, <dark>)` and set `color-scheme: light dark` on an ancestor (the root in full-document mode, the outermost container in fragment mode). `light-dark()` returns the dark value only when `color-scheme` is set. This intentionally follows the user's OS `color-scheme` preference for one-off custom colors; S2 tokens still track the parent app's class-based theme toggle in lockstep.
- **Do NOT use `@media (prefers-color-scheme: ...)`** to swap colors that should mirror the parent app's theme. The parent's theme toggle is a class on the sprinkle root, not the OS preference, so media queries desync from the actual app theme. Use S2 tokens (class-driven) or `light-dark()` (OS-driven, for one-off custom colors only) instead.

## Layout & viewport

Sprinkles open in **one of four viewport contexts**, and you must design for the narrowest:

| Float                            | Default viewport                       | Multi-column safe?      |
| -------------------------------- | -------------------------------------- | ----------------------- |
| Desktop (CLI / Electron) sidebar | Narrow rail (≈ 360 px)                 | No — single column only |
| Desktop full-screen pop-out      | Full window                            | Yes                     |
| iOS / Sliccstart app frame       | Full-width but always single-column UX | No                      |
| Chrome extension side panel      | Narrow (≈ 360 px, fixed by Chrome)     | No                      |

**Default to a single-column layout.** Multi-column layouts (sidebar + main, split panes, three-up grids) only render usefully when the user explicitly pops the sprinkle to full-screen on desktop. They look broken in the rail and on iOS.

If you genuinely need multi-column UI, do all of the following:

1. Build it in **full-document mode** so you can use grid / flex / media queries cleanly.
2. Use `@media (max-width: 600px)` (or similar) to collapse to single column at narrow widths so the sidebar/iOS view still works.
3. Tell the user in your reply that this sprinkle is "best viewed full-screen — pop it out from the rail header."

For dashboards with many widgets, prefer a vertical stack of `.sprinkle-card` blocks over a grid. The card stack is responsive by default and looks good in both rail and full-screen.

## Creating a sprinkle

1. `read_file /workspace/skills/sprinkles/style-guide.md` — **always read first** before writing any sprinkle.
2. **Pick a rail icon** that matches the sprinkle's purpose (see "Sprinkle icon" below). Every new sprinkle MUST declare an icon — the generic Sparkles default is reserved for sprinkles that genuinely have no thematic anchor.
3. `write_file` to `/shared/sprinkles/<name>/<name>.shtml` (follow the style guide templates).
4. `bash` → `sprinkle open <name>`.
5. **CRITICAL: do NOT finish or send a completion message.** You own this sprinkle for its entire lifetime. The cone will send you follow-up instructions (modifications, lick events) via `feed_scoop`. If you finish, you lose your context and cannot handle future work on this sprinkle.

### Updating a sprinkle (when you receive follow-up instructions)

1. Edit `/shared/sprinkles/<name>/<name>.shtml` with the requested changes.
2. Reload: `sprinkle close <name> && sprinkle open <name>`.
3. Do NOT finish — stay ready for more instructions.

### Handling lick events (when the cone forwards a user interaction)

The cone will send you a message with the lick action and your sprinkle name. Only modify YOUR sprinkle — the one matching your scoop name. Process the action and push updates:

- `bash` → `sprinkle send <name> '{"key":"value"}'` to push data to the sprinkle's `slicc.on('update', ...)` handler.
- Or edit the `.shtml` file and reload if the UI structure needs to change.
- Do NOT finish — stay ready for more events.

## Sprinkle icon

Each sprinkle gets its own glyph in the rail so users can tell them apart at a glance. Declare it in the `.shtml`. Three formats, in order of preference:

**1. Lucide icon name** (preferred — covers ~1500 icons from [lucide.dev/icons](https://lucide.dev/icons)):

```html
<link rel="icon" href="music" />
```

Use the kebab-case name from lucide.dev. Common picks: `music`, `code`, `terminal`, `chart-bar`, `chart-line`, `calendar`, `calendar-clock`, `clock`, `image`, `file-text`, `globe`, `book-open`, `compass`, `gauge`, `wrench`, `palette`, `bug`, `flask-conical`, `database`, `cloud`, `package`, `shopping-cart`, `dollar-sign`, `mail`, `message-square`, `bell`, `users`, `user`, `settings`, `sparkles`.

**2. SVG file in the sprinkle's directory** (when no Lucide icon fits):

```html
<link rel="icon" href="/shared/sprinkles/<name>/icon.svg" />
```

Author the SVG with `viewBox="0 0 24 24"`. Keep paths simple — the rail renders at 16×16. **Note**: only Lucide icons inherit `currentColor` from the rail; author-supplied SVGs render through `<img>` (script-disabled), so set explicit colors in the SVG itself.

**3. Inline SVG or data URL** (one-off icons, no extra file):

```html
<link
  rel="icon"
  href='data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="..."/></svg>'
/>
```

**Where to put it**: inside `<head>` for full-document mode, or as the very first element in fragment mode.

**Quoting tip**: when the `href` value contains quotes (inline-SVG data URLs do), wrap the attribute in single quotes: `href='data:image/svg+xml;utf8,<svg xmlns="...">...'`.

**Fallback**: if the icon spec is missing or unresolvable, the rail uses a generic Sparkles glyph.

## Cone orchestration rules

These are the rules the cone follows when sprinkles are involved. They are absolute.

### Rule 1: One scoop per sprinkle, named identically

Scoop name MUST match sprinkle name. Sprinkle `giro-winners` = scoop `giro-winners`.

### Rule 2: Cone never touches sprinkle files or commands

The cone MUST NOT: write/edit `.shtml` files, run `sprinkle open / close / send`, or handle lick events directly. ALL sprinkle work goes through scoops via `feed_scoop`. **Never handle a lick in the cone.**

### Rule 3: Creating sprinkles

Create a scoop, then feed it a complete, self-contained brief:

```
scoop_scoop("giro-winners")
feed_scoop("giro-winners", "You own the sprinkle 'giro-winners'. Your job:
1. Run: read_file /workspace/skills/sprinkles/style-guide.md
2. Research the last 3 Giro d'Italia winners
3. Pick a rail icon — for cycling, use <link rel=\"icon\" href=\"bike\" /> in <head>. See the sprinkles SKILL.md \"Sprinkle icon\" section for the full list.
4. Write the sprinkle to /shared/sprinkles/giro-winners/giro-winners.shtml
5. Run: sprinkle open giro-winners
6. IMPORTANT: After opening the sprinkle, do NOT finish. Stay ready — you will receive follow-up instructions and lick events for this sprinkle via feed_scoop. Do not send a completion message.")
```

### Rule 4: Modifying sprinkles

Feed the EXISTING scoop that owns it. Do NOT create a new scoop:

```
feed_scoop("giro-winners", "Modify YOUR sprinkle 'giro-winners' at /shared/sprinkles/giro-winners/giro-winners.shtml:
Add an 'Add Previous Year' button with onclick=\"slicc.lick({action: 'add-year'})\"
Then reload: sprinkle close giro-winners && sprinkle open giro-winners
Stay ready for more work.")
```

### Rule 5: Lick events

Forward to the owning scoop, never handle yourself:

```
feed_scoop("giro-winners", "Lick event on YOUR sprinkle 'giro-winners' (/shared/sprinkles/giro-winners/giro-winners.shtml):
Action: 'add-year'
Look up the next previous year's Giro d'Italia winner and update the sprinkle.
Use: sprinkle send giro-winners '<json>' to push data, or edit the .shtml and reload.
Stay ready for more lick events.")
```

## Cheap interactions via `agent`

When a sprinkle button needs to do real work but the owning scoop should NOT be pulled into a turn (it's busy, or the work is purely transactional), route the lick handler through `agent` instead.

Pattern:

1. User clicks → `slicc.lick({action: 'lookup', data: {q: 'foo'}})`.
2. Cone sees the lick, forwards to the owning scoop with `feed_scoop`.
3. The scoop's reply runs `agent` against a tight allow-list and writes the result back via `sprinkle send`.

```bash
# Inside the owning scoop's reply to a lick:
result=$(agent /tmp "curl,jq" "Look up '$Q' in <api>, return the price.")
sprinkle send giro-winners "$(jq -n --arg r "$result" '{result:$r}')"
```

Why this matters: a busy scoop that owns a sprinkle can shell to `agent` to handle a click without growing its own conversation. `agent` is **handoff-free** — the ephemeral sub-scoop doesn't notify the cone or the owning scoop on completion. See `/workspace/skills/delegation/SKILL.md` for the full `agent` reference.

This is the difference between "every click adds a turn to your owning scoop" (expensive, drifts) and "every click is a clean transaction" (predictable, cheap).

## Managing sprinkles via bash

- `sprinkle list` — see available sprinkles.
- `sprinkle open <name>` — show a sprinkle in the sidebar.
- `sprinkle close <name>` — remove it.
- `sprinkle send <name> '<json>'` — push data (single-quote the JSON!).
- `sprinkle chat '<html>'` — show inline HTML in the chat (for quick confirmations / choices). Blocks until the user clicks; returns the lick result as JSON. Use when a tool needs user input mid-execution.
- `open /path/to/file.shtml` — also opens as a sprinkle.

```bash
sprinkle chat '<div class="sprinkle-action-card">
  <div class="sprinkle-action-card__header">Deploy to production?</div>
  <div class="sprinkle-action-card__actions">
    <button class="sprinkle-btn sprinkle-btn--secondary" onclick="slicc.lick({action:\"cancel\"})">Cancel</button>
    <button class="sprinkle-btn sprinkle-btn--primary" onclick="slicc.lick({action:\"deploy\",data:{env:\"prod\"}})">Deploy</button>
  </div>
</div>'
```

## Bridge API

Available as `slicc` in `<script>` tags and `onclick` attributes:

- `slicc.lick(event)` — send a lick event to the cone (cone routes to the right scoop). Accepts a string shortcut (`slicc.lick('cancel')` → `{ action: 'cancel' }`) or `{ action, data? }`. See payload-shape note below.
- `slicc.on('update', function(data) {...})` — receive data sent via `sprinkle send`.

> **Payload shape:** the cone reads `event.data` as the payload — top-level extras outside `action` and `data` are silently dropped by the sprinkle bridge. Always use `slicc.lick({ action: 'deploy', data: { env: 'prod' } })`, not `slicc.lick({ action: 'deploy', env: 'prod' })`.

- `slicc.name` — the sprinkle's name.
- `slicc.close()` — close the sprinkle.
- `slicc.minimize()` — collapse the sprinkle panel (rail icon stays visible; user can click to reopen). Does not close or destroy the sprinkle.
- `slicc.stopCone()` — stop the cone agent.
- `slicc.readFile(path)` — read a VFS file (returns `Promise<string>`).
- `slicc.writeFile(path, content)` — write text content to a VFS file.
- `slicc.readDir(path)` — list directory entries (returns `Promise<Array<{name, type}>>`).
- `slicc.exists(path)` — check if path exists (returns `Promise<boolean>`).
- `slicc.stat(path)` — get file metadata (returns `Promise<{type, size}>`).
- `slicc.mkdir(path)` — create a directory (recursive).
- `slicc.rm(path)` — remove a file.
- `slicc.screenshot(selector?)` — capture sprinkle DOM as base64 PNG data URL. Note: the screenshot captures a DOM clone using SVG foreignObject. External stylesheets and some computed styles may not be fully reproduced. For best results, use inline styles on elements you intend to screenshot.
- `slicc.captureScreen()` — capture a screen, window, or browser tab via Chrome's native picker. Takes no arguments. Returns `Promise<{base64: string, width: number, height: number, mimeType: string}>`. The picker appears immediately; the Promise resolves once the user selects a target and the frame is grabbed. Rejects if the user cancels or screen capture is unavailable. Use `slicc.attachImage(shot.base64, 'screenshot.png', shot.mimeType)` to send the result to the agent. Key difference from `screenshot()`: this captures external content (any tab/window/screen), not the sprinkle's own DOM.

### Shell, agent, and jsh globals

The bridge also reaches the **same worker shell** that `.jsh` scripts and `node -e` run in, so a sprinkle can call any supplemental command, any `.jsh` script, or spawn a sub-scoop directly from a button. These are the same Tier 1 globals documented in `/workspace/skills/skill-authoring/jsh-runtime-extensions.md`.

- `slicc.exec(cmd)` — run a shell command in the worker shell. Returns `Promise<{stdout, stderr, exitCode}>`. A non-zero `exitCode` (or `127` when the shell bridge is unavailable) is returned in the result, never thrown. Use `slicc.exec.spawn(argv)` to bypass shell parsing for untrusted args.
- `slicc.agent(prompt, opts?)` — spawn a one-shot sub-scoop, feed it `prompt`, block until it completes, and resolve with its final message on `stdout`. Returns `Promise<{stdout, exitCode}>`. `opts`: `{cwd?, allowedCommands?, model?, thinking?, readOnly?}`. Sugar over `slicc.exec` building the `agent` command — the same handoff-free delegation as the `agent` shell command. On failure the error text comes back on `stdout` with a non-zero `exitCode`, never thrown.
- `slicc.fetch(url, init?)` — proxied, secret-injecting fetch (NOT the iframe's CORS-bound native fetch). Resolves to a native `Response` (with `.json()`/`.text()`/`.arrayBuffer()`/`.blob()` and `.ok`/`.status`/`.headers`/`.url`).
- `slicc.http.client(config)` — higher-level API client over the proxied fetch (`get`/`post`/`put`/`patch`/`delete`). `config`: `{baseUrl?, token?, headers?, retry?, timeoutMs?}`.
- `slicc.browser.*` — Playwright-style CDP surface (`findTab`, `ensureTab`, `eval`, `evalAsync`, `cookie`, `localStorage`, `fetch`), mirroring the jsh `browser` global.
- `slicc.fetchToFile(url, path)` — download a URL (via the proxied fetch) straight to a VFS file; resolves with the byte count.
- `slicc.readFileBinary(path)` / `slicc.writeFileBinary(path, bytes)` — binary VFS I/O (parity with the jsh `fs` global).
- `slicc.hid.*` / `slicc.serial.*` / `slicc.usb.*` — stateful device surfaces for WebHID / Web Serial / WebUSB (Chromium-only; absent in the cloud / hosted-leader float). Same opaque handles (`hid1`, `serial1`, `usb1`, …) as the `hid` / `serial` / `usb` shell commands and the realm globals — discover via `list()` or trigger the OS picker via `request()` (a button-click is a real user gesture). For HID, `open(handle)` auto-attaches the input-report stream so every `slicc.hid.on('inputreport', cb)` listener receives `{ handle, reportId, data: Uint8Array }` until `close(handle)` or sprinkle teardown. Use this for keyboard configurators, gamepad dashboards, ESP32 monitor panels — anything that needs a persistent device session across multiple button clicks. The realm bridge in `slicc.exec('node -e …')` resets per call, so push handle ops through `slicc.hid|serial|usb` instead.

```typescript
// HID — stateful across the sprinkle's lifetime
slicc.hid.list(): Promise<HidDeviceInfo[]>
slicc.hid.request(filters?): Promise<HidDeviceInfo[]>    // needs button-click gesture
slicc.hid.open(handle): Promise<void>                    // auto-subscribes inputreport
slicc.hid.close(handle): Promise<void>
slicc.hid.sendReport(handle, reportId, data: Uint8Array): Promise<void>
slicc.hid.on('inputreport', cb): void                    // cb: ({ handle, reportId, data })
slicc.hid.off('inputreport', cb): void

// Serial / USB — parity list/request/open/close; streaming I/O stays on the realm API.
slicc.serial.list() / request(filters?) / open(handle, options) / close(handle)
slicc.usb.list()    / request(filters?) / open(handle) / close(handle)
```

```html
<button
  id="connect"
  onclick="slicc.hid.request({vendorId:0x320f}).then(d => slicc.hid.open(d[0].handle))"
>
  Connect keyboard
</button>
<script>
  slicc.hid.on('inputreport', ({ reportId, data }) => {
    console.log('report', reportId, [...data].map((b) => b.toString(16)).join(' '));
  });
</script>
```

```html
<button
  onclick="slicc.exec('git status -s').then(r => slicc.lick({action: 'status', data: r.stdout}))"
>
  Refresh status
</button>
```

> Prefer `slicc.exec`/`slicc.agent` for transactional work that should NOT grow the owning scoop's conversation (see "Cheap interactions via `agent`" above). These run in the same worker shell, so all ~50 supplemental commands and any `.jsh` script are reachable.

**onclick attributes**: always use `slicc` — e.g. `onclick="slicc.lick({action: 'add-year'})"`. The `slicc` variable is automatically resolved per-sprinkle, so multiple sprinkles won't collide. Do NOT use `bridge` or any other variable name in onclick.

**CSS components**: do NOT write custom CSS. Use the built-in `.sprinkle-*` classes: cards, tables, badges, buttons, text fields, progress bars, meters, layout utilities, and more. For inputs use `class="sprinkle-text-field"`, never inline border/padding styles. Run `read_file /workspace/skills/sprinkles/style-guide.md` for the full component reference with markup examples.

## Built-in sprinkles

SLICC no longer ships with a catalog of pre-built sprinkles. The only `.shtml` under `/shared/sprinkles/` is `welcome/`, which backs the inline first-run welcome dip — not a panel sprinkle. **Always create sprinkles from scratch** for what the user is asking for, following the "Creating a sprinkle" flow above. Do not assume a built-in sprinkle name exists.
