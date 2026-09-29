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
allowed-tools: bash, read_file, write_file, edit
---

# Sprinkles

`.shtml` in `/shared/sprinkles/` → interactive UI panels.

## Two rendering modes

- **Fragment** (default): HTML fragments in sidebar. No `<!DOCTYPE>`, `<html>`, custom CSS — use `.sprinkle-*` classes. `slicc` bridge auto-injected.
- **Full-document**: `<!DOCTYPE html>` or `<html>` → sandboxed iframe. Custom CSS, layouts, canvas/SVG. Bridge + S2 tokens injected. Sandbox: `allow-popups` (sized popup via `window.open(url, name, 'popup=yes,width=1280,height=800')`); no top navigation.

Pick full-document for custom CSS, complex layouts, canvas/SVG.

## Light & dark mode

Automatic. Parent injects S2 tokens + toggles `.theme-light` on sprinkle root. Use `var(--s2-*)` tokens — see `style-guide.md`. One-off colors: `light-dark(<light>, <dark>)` + `color-scheme: light dark` on ancestor. **No `@media (prefers-color-scheme)`** for app-theme colors.

## Layout & viewport

| Float                | Viewport                     | Multi-column? |
| -------------------- | ---------------------------- | ------------- |
| Desktop sidebar      | ≈360px rail                  | No            |
| Desktop pop-out      | Full window                  | Yes           |
| iOS / Sliccstart     | Full-width, single-column UX | No            |
| Extension side panel | ≈360px fixed                 | No            |

**Default single-column.** Multi-column only useful full-screen on desktop. If needed: full-document mode + `@media (max-width: 600px)` collapse + tell user to pop out. Prefer vertical `.sprinkle-card` stack over grids.

## `layout` command

```bash
layout list / layout set <preset> / layout save <name> / layout load <name>
layout open <surfaceId> <zone>    # top|left|middle|right|bottom
layout move <surfaceId> <zone> / layout close <surfaceId>
layout size <surfaceId> [--width <px|%>] [--height <px|%>]
layout chat <zone> / layout reset
```

One shipped preset (default). `layout save` captures current arrangement. Zones = Java BorderLayout inside fixed chrome (`top` below scoop/budget strip; `left`/`right` inboard of rails). Two panels in same zone stack.

Hand-write JSON — only author `zones`:

```jsonc
{
  "version": 1,
  "id": "my-layout",
  "base": {
    "docks": [...],  // DO NOT AUTHOR — fixed chrome; copy verbatim or omit
    "zones": {
      "top": ["sprinkle:status-panel"],
      "left": ["chat"],
      "right": ["sprinkle:main-window"],
      "sizes": { "top": "180px", "left": "40%" }
    }
  }
}
```

Status bar across top = `zones.top`, NOT a `docks` entry. Prefer `layout save` over hand-editing. User drag persists across reloads — don't re-issue to "restore". ≤700px collapses to chat alone.

## Panel types

| Kind     | Who   | How                                        |
| -------- | ----- | ------------------------------------------ |
| Sprinkle | you   | `.shtml` + `sprinkle open`                 |
| Built-in | SLICC | chat, rails, files/terminal/memory/monitor |
| Layout   | you   | JSON + `layout save`/`load`                |

Sprinkle tied to scoop (lifetime + licks). Layout is not. Ship layouts at `/workspace/layouts/<name>.json`.

## Creating a sprinkle

1. `read_file /workspace/skills/sprinkles/style-guide.md` — **always first**.
2. Pick rail icon (see below).
3. `write_file` → `/shared/sprinkles/<name>/<name>.shtml`.
4. `sprinkle open <name>`.
5. **Do NOT finish** — you own it for lifetime; `feed_scoop` delivers follow-ups.

Discovery: `sprinkle list` scans `/shared`, `/workspace`, `/scoops`, `/home` ≤6 levels deep; skips `node_modules`, `dist`, `build`, `coverage`, dot-dirs. `/tmp`, `/mnt`, `/etc` not listed. `open /path/file.shtml` opens any path.

### Updating / lick events

Edit `.shtml` → `sprinkle reload <name>` (not close+open unless closed). On lick: `sprinkle send <name> '{"key":"value"}'` or edit+reload. Don't finish.

## Sprinkle icon

Each sprinkle gets a rail glyph. Declare in `<head>` (full-doc) or first element (fragment):

```html
<link rel="icon" href="music" />
<!-- Lucide name (preferred) -->
<link rel="icon" href="/shared/sprinkles/<name>/icon.svg" />
<!-- SVG file, viewBox 0 0 24 24 -->
<link rel="icon" href="data:image/svg+xml;utf8,<svg …>" />
<!-- inline; single-quote href -->
```

Lucide only inherit `currentColor`; custom SVGs via `<img>` — set explicit colors. Fallback: Sparkles glyph.

Common Lucide picks: `music`, `code`, `terminal`, `chart-bar`, `chart-line`, `calendar`, `calendar-clock`, `clock`, `image`, `file-text`, `globe`, `book-open`, `compass`, `gauge`, `wrench`, `palette`, `bug`, `flask-conical`, `database`, `cloud`, `package`, `shopping-cart`, `dollar-sign`, `mail`, `message-square`, `bell`, `users`, `user`, `settings`, `sparkles`, `bike`.

## Cone orchestration rules

1. **Scoop name = sprinkle name.** `giro-winners` sprinkle → `giro-winners` scoop.
2. **Cone never touches** `.shtml`, `sprinkle open/close/send`, or licks. All via `feed_scoop`. **Never handle a lick in the cone.**
3. **Create** — `scoop_scoop` + self-contained brief:

```
scoop_scoop("giro-winners")
feed_scoop("giro-winners", "You own sprinkle 'giro-winners'.
1. read_file /workspace/skills/sprinkles/style-guide.md
2. Research last 3 Giro d'Italia winners
3. Rail icon: <link rel=\"icon\" href=\"bike\" /> in <head>
4. write_file /shared/sprinkles/giro-winners/giro-winners.shtml
5. sprinkle open giro-winners
6. Do NOT finish — stay ready for follow-ups and lick events via feed_scoop.")
```

4. **Modify** — feed **existing** scoop, don't create new:

```
feed_scoop("giro-winners", "Modify YOUR sprinkle at /shared/sprinkles/giro-winners/giro-winners.shtml:
Add 'Add Previous Year' button onclick=\"slicc.lick({action:'add-year'})\"
sprinkle reload giro-winners. Stay ready.")
```

5. **Licks** — forward to owning scoop:

```
feed_scoop("giro-winners", "Lick on YOUR sprinkle: action 'add-year'.
Look up next previous year's winner. sprinkle send or edit+reload. Stay ready.")
```

## Bash commands

```bash
sprinkle list [--runtime <id>]
sprinkle open <name> / sprinkle close <name>
sprinkle send <name> '<json>'              # broadcast all instances; exits non-zero if none
sprinkle send <name> '<json>' --runtime <id>  # one runtime (from `host`; `leader` = local)
sprinkle chat '<html>'                     # inline chat prompt; blocks until click; JSON result
open /path/to/file.shtml
```

```bash
sprinkle chat '<div class="sprinkle-action-card">
  <div class="sprinkle-action-card__header">Deploy to production?</div>
  <div class="sprinkle-action-card__actions">
    <button class="sprinkle-btn sprinkle-btn--secondary" onclick="slicc.lick({action:\"cancel\"})">Cancel</button>
    <button class="sprinkle-btn sprinkle-btn--primary" onclick="slicc.lick({action:\"deploy\",data:{env:\"prod\"}})">Deploy</button>
  </div>
</div>'
```

Unknown flags rejected — exit 0 on probe means flag honoured. `sprinkle send` broadcasts to every open instance (leader + followers); `--runtime <id>` targets one follower `request-load` answer.

## Bridge API (`slicc`)

- `slicc.lick(event)` — send lick to cone (routes to scoop). String shortcut: `slicc.lick('cancel')` → `{action:'cancel'}`. `target` overrides sprinkle route (cone/scoop name or folder alias); without it, click goes to cone that opened the panel.

> **Payload shape:** cone reads `event.data` as payload — top-level extras outside `action`, `data`, `target` silently dropped. Use `slicc.lick({ action:'deploy', data:{ env:'prod' } })`, not `slicc.lick({ action:'deploy', env:'prod' })`.

- `slicc.on('update', fn)` — from `sprinkle send`.
- `slicc.name`, `slicc.close()`, `slicc.minimize()`, `slicc.stopCone()`.
- `slicc.selectScoop(target)` — switch view to running scoop/cone (switcher-chip equivalent). `'scoop:<name>'`, `'cone:<folder>'`, `'cone'`. `Promise<boolean>`: `true` when matched (including already selected); `false` when outside grammar, no match, or user typing in chat composer (non-empty draft — would hide half-written message). Click in panel never trips this. Ungated, sprinkle-only.
- `slicc.selectedScoop()` — read current selection same grammar. `Promise<string|null>`. Read-only — don't call `selectScoop` just to discover selection. `readDir('/scoops/')` lists retired folders, not liveness.
- VFS: `readFile`, `writeFile`, `readDir`, `exists`, `stat`, `mkdir`, `rm`.
- `slicc.screenshot(selector?)` — base64 PNG data URL. No arg = `document.body` (fragment: sprinkle container). Target needs non-zero width AND height. Works in hidden tab. Captures DOM clone via SVG `foreignObject` — external stylesheets/fonts may not reproduce; huge SVGs can fail. Prefer inline styles on capture targets.
- `slicc.captureScreen()` — Chrome native picker; `{base64, width, height, mimeType}`. On the leader page opens via `<slicc-permissions>` Grant prompt first (Allow click is the user gesture — `postMessage` drops transient activation), then the OS picker. Rejects on Grant/OS cancel or unavailable. Use `slicc.attachImage(shot.base64, 'screenshot.png', shot.mimeType)` to send to agent. Captures external content (any tab/window/screen), not sprinkle DOM.

### Shell / agent / jsh globals

Mirrors `require('sliccy:…')` from jsh (see `jsh-runtime-extensions.md`):

- `slicc.exec(cmd)` → `{stdout, stderr, exitCode}`. `.exec.spawn(argv)`.
- `slicc.agent(prompt, opts?)` → `{stdout, exitCode}`. `opts`: `cwd`, `allowedCommands`, `model`, `thinking`, `readOnly`.
- `slicc.fetch(url, init?)` — proxied (not iframe CORS fetch).
- `slicc.http.client(config)` — `get`/`post`/`put`/`patch`/`delete`.
- `slicc.browser.*` — `findTab`, `ensureTab`, `openWindow`, `windowBounds`, `setWindowBounds`, `eval`, `evalAsync`, `cookie`, `localStorage`, `fetch`.
- `slicc.fetchToFile`, `readFileBinary`, `writeFileBinary`.
- `slicc.hid.*` / `slicc.serial.*` / `slicc.usb.*` — WebHID/Serial/USB (Chromium-only; absent cloud/hosted-leader). Same handles as shell commands (`hid1`, `serial1`, `usb1`). On the leader page `request()` opens via `<slicc-permissions>` Grant prompt first (Allow click is the user gesture — `postMessage` drops transient activation), then the OS chooser. HID `open(handle)` auto-attaches `inputreport` until `close`/teardown. Prefer these over `slicc.exec('node -e …')` (realm bridge resets per call).

```typescript
slicc.hid.list() / request(filters?)  /* Grant → OS chooser */ / open(handle) / close(handle)
slicc.hid.sendReport(handle, reportId, data: Uint8Array)
slicc.hid.on('inputreport', cb)  // { handle, reportId, data: Uint8Array }
slicc.serial.list() / request() / open(handle, opts) / close(handle)
slicc.usb.list() / request()  /* Grant → OS chooser */ / open(handle) / close(handle, opts?) / reset(handle)
slicc.usb.claimInterface(handle, n) / releaseInterface(handle, n)
slicc.usb.transferIn(handle, endpoint, length) / transferOut(handle, endpoint, bytes)
slicc.usb.controlTransferIn(handle, setup, length) / controlTransferOut(handle, setup, bytes)
```

USB interface claims exclusive; `{ force: true }` on close displaces holder via `claim-lost`. Transfers on sprinkle surface (realm stdout buffers until run completes — streaming needs sprinkle-side device drive).

```html
<button
  onclick="slicc.exec('git status -s').then(r => slicc.lick({action:'status', data:r.stdout}))"
>
  Refresh
</button>
```

Prefer `slicc.exec`/`slicc.agent` for transactional work. **onclick**: always `slicc`, never `bridge`.

**CSS**: use `.sprinkle-*` classes only. `read_file style-guide.md` for reference.

## Cheap interactions via `agent` (detail)

When a sprinkle button needs real work but the owning scoop should NOT be pulled into a turn:

1. User clicks → `slicc.lick({action:'lookup', data:{q:'foo'}})`.
2. Cone forwards to owning scoop via `feed_scoop`.
3. Scoop runs `agent` with tight allow-list, writes back via `sprinkle send`.

```bash
result=$(agent "$TMPDIR" "curl,jq" "Look up '$Q' in <api>, return price.")
sprinkle send giro-winners "$(jq -n --arg r "$result" '{result:$r}')"
```

`agent` is handoff-free — ephemeral sub-scoop doesn't notify cone or owning scoop. Difference: every click as owning-scoop turn (expensive, drifts) vs clean transaction (predictable, cheap).

## Built-in sprinkles

Only `/shared/sprinkles/welcome/` ships (first-run welcome dip, not a panel sprinkle). **Create from scratch** — do not assume built-in sprinkle names exist.
