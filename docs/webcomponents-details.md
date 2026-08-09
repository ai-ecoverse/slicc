# `@slicc/webcomponents` — internals

Extended reference for `packages/webcomponents/CLAUDE.md`. Deep notes only;
see the package `CLAUDE.md` for commands, invariants, and the top-level map.

## Panel system

Per-file internals for `src/panel/` beyond the summary in the package guide.

- **`SliccPanel`** (`panel/slicc-panel.ts`) — base class for every panel (chat,
  both rails, the switcher, the floatbar, each tool panel, each sprinkle). Owns
  identity (`panelId`, falling back to static `panelMeta.id` so one class backs
  many ids), `visible` (inverse of native `hidden`, so a11y comes free),
  `locked`, `presentation`/`anchor`, and `onPanelShow`/`onPanelHide`/`onPanelResize`
  lifecycle. Light DOM; the shared stylesheet keys on a `data-slicc-panel` marker
  rather than the tag, because one rule set must cover runtime-registered
  subclasses. **Panels default to VISIBLE** — the opposite polarity from
  `<slicc-surface>`, since a panel is placed by the layout rather than being one
  of a show-one stack.
- **`panel-meta.ts`** — `PanelMeta`/`PanelSize`/`PanelPresentation` +
  `panelMetaOf`. DOM-free, exported as `@slicc/webcomponents/panel/meta` so the
  webapp and kernel worker can import metadata without the barrel (which
  registers every component and needs `CSSStyleSheet`).
- **`panel-registry.ts`** (`./panel/registry`) — id → `{ meta, source, origin }`
  for `builtin` / `sprinkle` / `agent` panels. A duplicate id REPLACES and
  returns `false`: every caller is a legitimate re-registration (HMR, discovery
  resync, the agent rewriting its own panel), so throwing would break boot and
  ignoring would leave stale code live. `panelRegistryEvents` lets a live
  add-panel menu re-render when kernel-gated discovery lands after first paint.
- **`layout-schema.ts`** (`./panel/layout-schema`) — the document and its pure
  resolution. TWO layers: `docks[]` is FIXED CHROME pinned to an edge at an
  exact size (fr-only zones can't say "44px"); `zones` is the working area the
  docks leave over — five BorderLayout regions (`ZoneName`:
  top/left/center/right/bottom). Nesting inside what the docks left puts `top`
  below the scoop strip and the side zones inboard of the rails, so chrome and
  zones never overlap; `center` is the remainder. A zone holds ANY NUMBER of
  panels along its `axis` (`zoneAxis` — wide bands default `row`, tall ones
  `col`): the simplicity is the five DESTINATIONS, not the capacity. Ops are
  list edits (`moveToZone`/`removeFromZones`/`zoneOfPanel`). Replaced a split
  tree that expressed more but nothing a user could aim at; `zonesFromCenter`
  flattens a legacy `center`. `sizeToFlex`: number/`fr` → grow factor, zero
  basis; `px`/`%` → fixed. Variants REPLACE a section; `panels` overrides merge
  per id.
- **`center-ops.ts`** (`./panel/center-ops`) — just `liveArrangement`: which
  section (a matched variant, else `base`) owns the working area on screen, and
  therefore what a drag edits.
- **`layout-interaction.ts`** — the pointer gestures: hover-reveal corner grip,
  the five-zone drop compass, divider drag. Grabbing PAINTS the five
  destinations from the WORKING AREA's box, so a badge appears where the panel
  lands, and hit-tests them — the drop is what was aimed at; a zone's area
  works too. Overlays and pointer capture live on the HOST, not a slot: a slot
  is rebuilt every render (including every resize frame), and a captured
  element removed from the DOM loses capture per spec — which once left resize
  stuck to the mouse. TWO seam kinds: between panels in a zone (weights) and
  between ZONES (px — a thickness is absolute; a weight would rubber-band an
  edge band on window resize). The zone clamp reserves for EVERY element in the
  run — fixed zones at actual width, the flexible one at a 48px floor;
  reserving one floor let a drag crush the center to 0px. No grip on
  locked/docked panels; no seam beside an empty or locked zone.
- **Stories** (`panel/*.stories.ts`) — needed for PR screenshots to cover
  panels at all (the affected-story heuristic is directory-level). Includes
  `Stacked Docks`, which shows a dock spanning OVER the rails vs `zones.top`
  between them — the distinction that gets layouts authored wrong.
- **`<slicc-layout>`** (`panel/slicc-layout.ts`) — renders a document by MOVING
  matched `SliccPanel` children into slots. Unplaced panels are parked
  offstage, not destroyed, so a panel keeps its scroll position / live terminal
  session across variant switches; `getPlacedPanelIds()` reports what actually
  rendered, not what the document mentions. Re-resolves on HOST resize (not
  window — a nested layout must react to its own box), rAF-debounced and
  skipped when the matched variant set is unchanged. Rebuilds target a stable
  inner root: replacing the host's own children would re-enter its
  `MutationObserver` forever.

## Dock-tree

Extended notes for `slicc-dock-tree` (`src/workbench/slicc-dock-tree.ts`).

- **Model**: a fixed skeleton of 5 zones (`ZoneName`:
  `top`/`left`/`middle`/`right`/`bottom`), each holding a recursive `DockNode`
  — either a `leaf` (one surface) or a `split` (`dir: 'row' | 'col'`, children
  - relative `sizes`). A zone whose node is `null` collapses entirely (no
    space, no divider) in normal rendering; a private dragging flag reveals
    collapsed zones as drop-target placeholders for the duration of any drag.
- **API**: `setTree`/`getTree` (full serialization incl. sizes),
  `getSurfaceIds`, `placeSurface(surfaceId, zone)`, `removeSurface`,
  `moveSurfaceToZone` (detach-then-reinsert, bypassing the pinned guard —
  needed for `chat`), `setSurfaceSize(surfaceId, size)` (exact px or percent of
  the sibling group, the programmatic counterpart to dragging a divider),
  `beginExternalDrag(surfaceId, pointerId?)` (a drag started outside the
  component enters the same state machine). Per-method contracts are in the
  source doc comments.
- **Chat as a movable panel**: `CHAT_SURFACE_ID = 'chat'` is the reserved
  surfaceId the webapp composes the live `<slicc-chatpane>` into at boot (see
  `packages/webapp/CLAUDE.md`'s Layouts section). `labelForSurface(surfaceId)`
  derives a tile's friendly label — `'Chat'` for `CHAT_SURFACE_ID`, otherwise
  the id with any `sprinkle:` prefix stripped — surfaced as the move button's
  `title`/`aria-label`, not a visible text bar. `setPinned(surfaceIds:
string[])` marks leaves as pinned (runtime-only — never serialized by
  `getTree()`/persisted); a pinned leaf's `removeSurface` is a no-op
  (defense-in-depth so chat can never be orphaned even if a caller mis-calls
  remove) — dragging a pinned leaf still moves it normally.
- **Locking**: `DockTreeSpec.locked` (tree-wide) and `DockNode.locked`
  (per-leaf or per-split, inherited down to every descendant) block drag,
  resize, and `removeSurface` for the affected node(s). A locked leaf renders
  no move button at all — there's nothing to click, matching "cannot drag"
  literally. Used by embedders (e.g. Cherry) to push a fixed, unmovable
  arrangement — see `packages/webapp/CLAUDE.md`'s Layouts section.
- **Drag-drop interaction**: `tilesMovable` / `tiles-movable` defaults off and
  locking still wins. It remains an opt-in embedder/test contract but is
  dormant in the shipped webapp: flag-off keeps it off, while flag-on replaces
  the dock-tree with `<slicc-layout>`. Full `DropRegion` and no-op contracts:
  `docs/layouts.md`.
- **Resize**: every skeleton divider (between shown blocks/zones) and every
  in-zone split divider is pointer-drag-resizable, moving `fr` weight (or a
  split's `sizes`) between adjacent slots, clamped to 2% of the dragged pair's
  combined weight — the floor `setSurfaceSize` enforces. Pointer capture is
  held on the host, not the divider (see the panel system's note above: a
  captured element removed from the DOM loses capture per spec).
- **Events**: `dock-tree-change` (composed + bubbling, `detail: { tree }`)
  fires after a drag-drop (internal or external), `placeSurface`, or
  `removeSurface` mutates the tree; `dock-tree-resize` (same shape) fires on
  divider-drag `pointerup` or a `setSurfaceSize` call that actually changed
  something. Neither event persists anything itself — see
  `packages/webapp/CLAUDE.md`'s Layouts section for the webapp's
  `wireDockTreePersistence` listener.

## Composer push-to-talk

Extended reference for the `<slicc-composer ptt>` bullet in the package guide.

The composer owns the hold-to-dictate GESTURE but never the audio stack:

- **3s hold-to-enable permission stage** — first press must be held for 3s to
  trigger a mic-permission request; a shorter tap is ignored so accidental
  brushes don't prompt.
- **Recording overlay** — caption line (live transcript), mic picker, and
  engine-status line while recording; release appends the transcript and
  submits.
- **Speech contract** — hosts inject a `ComposerSpeech` controller via the
  `speech` property. The contract and a built-in Web Speech fallback live in
  `composer/speech.ts`, also exported as the DOM-free subpath
  `@slicc/webcomponents/composer/speech` (safe for node/worker realms; the
  barrel is not — it registers every component and needs `CSSStyleSheet`).
  The webapp injects its whisper-upgradable controller there.
- **Dictation source tag** — dictated submits carry `detail.source ===
'dictation'` (via the input card's `submit(source?)`) so hosts can speak
  the reply back to spoken input.

## Storybook PR screenshots

Extended reference for the workflow summary in the package guide.

**Trigger.** `.github/workflows/storybook-screenshots.yml` is event-filtered to
`packages/webcomponents/**`, its screenshot tooling, and the workflow
definition on a `pull_request` to `main`. Unrelated PRs do not start the
workflow.

**Affected-story heuristic** (directory-level, intentionally coarse — easy to
reason about, no module-graph plumbing):

- A changed `src/<area>/**/*.stories.ts` selects only the stories declared in
  that file (matched by Storybook's `importPath`).
- Any other changed file under `src/<area>/` selects **all** stories whose
  `importPath` lives under that `<area>`.
- Files outside `packages/webcomponents/src/<area>/` (no area subdir, or
  outside the package) contribute nothing.

Each affected story is screenshotted at the desktop viewport (1280×900) for
both the `light` and `dark` theme globals.

**Hosting.** PNGs are uploaded to the Cloudflare R2 bucket
`slicc-pr-screenshots` under the key `pr-<number>/<head-sha>/<file>.png` and
embedded inline in the comment via the public r2.dev base URL. The bucket has
a 30-day object lifecycle rule (`expire-30d`) so screenshots self-clean.

**Fork PRs / missing secret.** When `CLOUDFLARE_API_TOKEN` is unavailable
(typical for fork PRs) the job degrades to attaching the PNGs as a workflow
artifact and the comment links to the run instead of embedding images. The
artifact upload always runs, R2 or not, and the R2 upload step is
`continue-on-error: true` so a single failed object put still leaves the
artifact + comment intact.

**Ops secrets/vars.** The repo needs `CLOUDFLARE_API_TOKEN` (R2 read+write on
the `slicc-pr-screenshots` bucket) as an Actions secret. The account ID,
bucket name, and public base URL have sensible defaults baked into the
workflow but can be overridden via the `CLOUDFLARE_ACCOUNT_ID`, `R2_BUCKET`,
and `R2_PUBLIC_BASE_URL` repo variables.

**Manifest** (`<out>/manifest.json`, schema v1, consumed by the workflow's
comment builder):

```json
{
  "version": 1,
  "generatedAt": "<ISO8601>",
  "viewport": { "width": 1280, "height": 900 },
  "shots": [
    {
      "storyId": "pill-pill--cone-open-idle",
      "title": "Pill/Pill",
      "name": "Cone Open Idle",
      "area": "pill",
      "importPath": "./src/pill/slicc-pill.stories.ts",
      "theme": "light",
      "file": "pill-pill--cone-open-idle.light.png",
      "triggeredBy": ["packages/webcomponents/src/pill/slicc-pill.ts"]
    }
  ]
}
```

The schema is **flat**: one `shots[]` entry per (story × theme). Consumers
group by `storyId` themselves (no `stories[].screenshots[]` nesting). The
capture script is the source of truth for the schema and the CLI; the
workflow YAML follows.

**R2 upload — dedupe + retry.** Uploads are driven by
`packages/dev-tools/tools/storybook-screenshots-upload.mjs` (+ pure lib
`storybook-screenshots-upload-lib.mjs`). Sequential per-file `wrangler`
subprocess spawns previously took ~4s/file and timed out CI on large PRs,
so uploads run through an injectable `r2` client with bounded concurrency
(`--concurrency`, default 4) and content-hash deduplication. Each shot
retries up to 5 times with jittered exponential backoff, since R2
rate-limits upload bursts with `429` / code 971. Driven by the workflow's
"Upload screenshots to Cloudflare R2" step.
