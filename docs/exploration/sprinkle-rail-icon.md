# Sprinkle rail icon — `data-sprinkle-icon` support

## Status

**Pending.** The convention is referenced in code comments (`packages/webapp/src/ui/layout.ts:58-65`) but not implemented. The snowflake sprinkle in `ai-ecoverse/snowflake` already declares the attribute prospectively, so once this lands, that rail icon will switch from the default Sparkles to a snowflake glyph automatically.

## Context

Today, every sprinkle in slicc's right rail (and the extension's tab bar) shows the same default Lucide `Sparkles` icon. It's hardcoded in `packages/webapp/src/ui/layout.ts:64` as `SPRINKLE_DEFAULT_ICON`. The comment immediately above the constant already anticipates the convention this doc proposes:

> When sprinkles want a specific glyph, future work can wire up a `data-sprinkle-icon` attribute on the .shtml `<html>` element and surface that here.

## Proposed convention

Sprinkles opt into a custom rail icon by setting `data-sprinkle-icon` on the root `<html>` element. The value is the **full** SVG markup (`<svg>…</svg>`), in single-quoted attribute form, using `currentColor` so the icon adapts to the rail's theme states (idle / hover / active).

```html
<html
  data-sprinkle-autoopen
  data-sprinkle-icon='<svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="…"/></svg>'
></html>
```

Single-quoted is mandatory — the SVG payload uses double quotes for its own attributes.

## Implementation plan

Four files, ~10 lines of production code, no new dependencies.

### 1. `packages/webapp/src/ui/sprinkle-discovery.ts`

- Add `icon?: string` to the `Sprinkle` interface.
- Add an exported `extractIcon(content: string): string | undefined` helper, mirroring the existing `extractTitle` / `extractAutoOpen` exports.
- In `scanDir`, call `extractIcon(content)` and include it on the map entry.

### 2. `packages/webapp/src/ui/sprinkle-manager.ts`

- Add an optional `icon?: string` parameter to the `addSprinkle(...)` callback in `SprinkleManagerCallbacks` (around line 30).
- Pass `sprinkle.icon` at the call site (around line 185).

### 3. `packages/webapp/src/ui/layout.ts`

- Add an optional `icon?: string` parameter to the `addSprinkle` method.
- Use `icon ?? SPRINKLE_DEFAULT_ICON` where `SPRINKLE_DEFAULT_ICON` is currently passed (lines 1025 and 1067).

### 4. `packages/webapp/src/ui/main.ts`

- Thread the new parameter through the two callback wrappers (lines 1168-1169 and 2590-2591).

## Critical detail — regex form

The existing extractor at `sprinkle-discovery.ts:89` uses

```ts
const attrMatch = content.match(/data-sprinkle-title=["']([^"']+)["']/);
```

That pattern **cannot** be reused for `data-sprinkle-icon` because the value contains both quote types. Use a single-quote-only matcher:

```ts
export function extractIcon(content: string): string | undefined {
  const m = content.match(/data-sprinkle-icon='([^']*)'/);
  return m && m[1] ? m[1] : undefined;
}
```

Drop a code comment noting that `data-sprinkle-icon` MUST be single-quoted because its SVG value uses double quotes for its own attributes.

## Tests (~30 lines)

`packages/webapp/tests/ui/sprinkle-discovery.test.ts` already has parallel `describe('extractTitle')` and `describe('extractAutoOpen')` blocks. Add a third:

```ts
describe('extractIcon', () => {
  it('extracts an inline SVG from data-sprinkle-icon', () => {
    const html = `<html data-sprinkle-icon='<svg viewBox="0 0 24 24"><path d="M0 0"/></svg>'>`;
    expect(extractIcon(html)).toContain('<svg');
  });

  it('returns undefined when the attribute is absent', () => {
    expect(extractIcon('<html>')).toBeUndefined();
  });

  it('returns undefined for empty value', () => {
    expect(extractIcon(`<html data-sprinkle-icon=''>`)).toBeUndefined();
  });
});
```

`sprinkle-manager.test.ts` likely needs no change — its mock `addSprinkle` callback can ignore the new optional param.

## Manual verification

1. Build slicc (`npm run build -w @slicc/webapp` plus `npm run build -w @slicc/chrome-extension` for the extension float).
2. Open the snowflake sprinkle (`sprinkle close snowflake && sprinkle open snowflake`).
3. Confirm the rail/tab icon shows the snowflake glyph instead of the default Sparkles, and that hover/active rail states still recolor it via `currentColor`.

## Effort

**~60-90 minutes total** for production code, tests, and verification.

| Phase                                                         |  Estimate |
| ------------------------------------------------------------- | --------: |
| Production code (regex + callsite plumbing)                   | 30-40 min |
| Tests                                                         | 20-30 min |
| Rebuild + visual verification (CLI float and extension float) | 15-20 min |

## Risks

- **Type safety**: TypeScript should catch any missed callsite when the callback signature changes — low risk if `tsc --noEmit` runs in CI.
- **XSS via SVG `<script>`**: `btn.innerHTML = item.icon` (`rail-zone.ts:303`) will execute `<script>` tags embedded in the SVG. This matches the existing trust boundary — anyone with VFS write access can already do worse — but the rail code should grow a comment noting that sprinkle icons are trusted markup. No sanitization required for the trust model as it stands.
- **Backwards compatibility**: existing sprinkles without `data-sprinkle-icon` keep getting the default Sparkles icon. No migration needed.

## See also

- `packages/webapp/src/ui/layout.ts:58-65` — the existing comment that anticipates this work.
- `packages/webapp/src/ui/rail-zone.ts:303` — where the icon string is rendered (`btn.innerHTML = item.icon`).
- `ai-ecoverse/snowflake` repo, `.claude/skills/stardust-to-snowflake/snowflake.shtml` — first sprinkle to declare `data-sprinkle-icon` prospectively.
