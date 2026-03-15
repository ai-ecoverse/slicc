---
name: playground-sprinkles
description: Generate interactive playground sprinkles with controls, live preview, and bidirectional agent communication
allowed-tools: bash
---

# Playground Sprinkles

Generate interactive playground-style sprinkles with rich controls (sliders, chips, toggles, selects, color pickers, canvas) that send natural-language prompts to the agent on change.

## When to Use

Use playground sprinkles when the user wants to:
- Explore design options (colors, spacing, typography)
- Configure data queries (SQL, GraphQL, API calls)
- Map concepts and knowledge
- Review documents or diffs with configurable focus
- Visualize architecture or code structure

## The Pattern

Every playground sprinkle follows this structure:

1. **State object** — all control values in one place
2. **`updateAll()`** — reads controls into state, renders preview, generates prompt text
3. **Controls call `updateAll()` on change** — slider `oninput`, chip `onclick`, toggle `onchange`
4. **Debounced `slicc.lick()`** — auto-sends prompt after 500ms idle (or manual "Apply" for canvas)
5. **State persistence** — `slicc.setState(state)` on every change, restore via `slicc.getState()` on load

## Layout

Default: single-column vertical stack in the sidebar (~350px wide). For richer layouts:
- `.sprinkle-sidebar` — controls aside + main preview area
- `.sprinkle-split` — resizable horizontal/vertical panes
- `.sprinkle-tabs` — tabbed panels within the sprinkle
- Custom `<style>` blocks work in both CLI and extension modes

When expanded to full page, layout components get more room (max-width: 960px centered, sidebar: 280px).

## Lick Strategy

- **Simple controls** (sliders, chips, toggles, selects): Debounced auto-send (500ms). User tweaks controls freely, prompt fires when they pause.
- **Canvas/spatial tools**: Manual "Apply" button. User positions nodes, then clicks to send.
- **Critical: `_ready` guard**: Always suppress licks during initialization. Without this, state restoration on load fires a lick, the scoop starts processing, and user interactions fire more licks before the scoop finishes — the scoop gets stuck in processing state forever. Set `var _ready = false;` at the top, check `if (!_ready) return;` in `debouncedLick()`, and set `_ready = true;` after state restoration completes.

## State Persistence

Always persist state so the sprinkle survives close/reopen:

```javascript
// Save on every change
slicc.setState(state);

// Restore on load
var saved = slicc.getState();
if (saved) {
  Object.assign(state, saved);
  // restore control values from state, then updateAll()
}
```

## Bridge Integration

```javascript
// Send natural-language prompt to the agent
slicc.lick({ action: 'prompt-updated', data: promptText });

// Receive results from the agent (via sprinkle send)
slicc.on('update', function(data) {
  // render agent response in the sprinkle
});
```

## Full-Tab Playground Mode

HTML files opened via `open` or `serve` in preview tabs automatically get `window.slicc` injected — the same API as sidebar sprinkles. This means any playground can communicate bidirectionally with the agent without changes to the generated HTML.

**How it works**: The preview service worker injects a bridge script into every HTML response. The bridge uses `BroadcastChannel` to communicate back to the main app, which routes events through the existing lick handler.

**Agent workflow for full-tab playgrounds**:
1. Write an HTML file using `window.slicc` (lick, on, setState, etc.)
2. `open /shared/my-playground.html` — opens in a browser tab with bridge auto-injected
3. Stay in the loop — handle lick events arriving as `playground:/shared/my-playground.html:...`
4. Send updates back: `sprinkle send playground:/shared/my-playground.html '{"result": ...}'`

**Key difference from sidebar sprinkles**: `slicc.getState()` returns a `Promise` in playground mode (async via BroadcastChannel), so always `await` it:
```javascript
var saved = await slicc.getState();
```

## Building a Playground Sprinkle

1. `read_file /workspace/skills/playground-sprinkles/patterns.md` — reusable code patterns
2. `read_file /workspace/skills/playground-sprinkles/templates.md` — complete template examples
3. `read_file /workspace/skills/sprinkles/style-guide.md` — CSS component reference
4. Write the `.shtml` file combining patterns as needed
5. `sprinkle open <name>` — preview it
6. **Stay ready** — do NOT finish. Handle follow-up instructions and lick events.

## Available Templates

Reference examples in `templates.md` (read to see full code):

| Template | Controls | Use Case |
|----------|----------|----------|
| Design Playground | Range sliders, chips, toggles, color pickers | Explore visual design options |
| Data Explorer | Chips, selects, range, text fields | Build and configure data queries |
| Concept Map | Canvas (SVG), chips, text field | Map knowledge and relationships |
| Document Critique | Text field, chips, range | Configure document review parameters |
| Diff Review | Text fields, chips, toggles | Set up code diff review focus |
| Code Map | Text field, range, chips | Explore codebase architecture |
