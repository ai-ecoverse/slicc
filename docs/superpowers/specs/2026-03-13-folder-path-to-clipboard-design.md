# Copy VFS Path to Clipboard from File Browser

## Problem

When working in slicc, users frequently need to reference VFS paths in chat messages or terminal commands. Currently there is no way to copy a file or folder path from the file browser — the user must type it manually, which is error-prone for deep paths.

## Design

### Interaction Model

Row selection + Cmd/Ctrl+C. No new buttons, no context menus, no behavior changes to existing interactions.

1. **Click any row** (file or folder) — the row receives a visual selection highlight and its full VFS path is stored internally. For folders, this happens alongside the existing expand/collapse toggle.
2. **Cmd/Ctrl+C** — if no text is currently selected in the document (`window.getSelection()?.isCollapsed !== false`), the stored path is written to the clipboard via `navigator.clipboard.writeText()`. If text IS selected, the browser handles the event normally (native copy).
3. **Selection persists** until a different row is clicked. Switching to another panel (Chat, Terminal, Memory) does not clear the selection.
4. **Brief visual feedback** on successful copy — the selected row background briefly flashes `var(--s2-positive)` at low opacity, then fades back (150ms transition).

### What Gets Copied

| Item   | Copied path                                        |
| ------ | -------------------------------------------------- |
| Folder | `/workspace/skills/migrate-page/` (trailing slash) |
| File   | `/workspace/skills/migrate-page/SKILL.md`          |

Trailing slash on folders distinguishes them from files and matches shell conventions.

### Keyboard Event Handling

A `keydown` listener is registered on the file browser container element. Using `keydown` (not the `copy` event) because the `copy` event does not reliably fire on focused non-editable divs across browsers. The handler checks `(e.metaKey || e.ctrlKey) && e.key === 'c'`.

Scoping to the container means the listener only fires when a file browser element has DOM focus:

- **Terminal focused** (xterm.js has focus): Ctrl+C sends SIGINT as usual. The keydown never reaches the file browser container.
- **Chat input focused** with text selected: Native copy fires. The file browser's listener never fires.
- **File browser row focused**: The listener fires, checks `window.getSelection()?.isCollapsed !== false` and `selectedPath !== null`, writes the path, and calls `e.preventDefault()` to suppress the browser's default empty-selection copy.

To make keyboard events reach the file browser, the selected row receives `tabindex="0"` and `focus()` on click.

### Selection Survival Across Refresh

The file browser auto-refreshes every 3 seconds via `refresh()`, which rebuilds the DOM when content changes. Without care, this destroys the focused/selected row.

Strategy: after DOM replacement in `refresh()`, if `selectedPath` is set, find the row matching that path, apply the `.file-browser__item--selected` class, set `tabindex="0"`, and call `focus()` (only if the file browser container previously held focus — checked via `document.activeElement` before the DOM swap). This keeps selection and focus stable across refreshes.

The same re-apply logic runs after the folder expand/collapse toggle calls `refresh()`.

### Visual Design

Selection follows existing file browser styling patterns:

- Selected row: `background: var(--s2-bg-elevated)` with an inset left accent — `box-shadow: inset 2px 0 0 var(--s2-accent)`. Using `box-shadow` instead of `border-left` avoids a 2px layout shift.
- Hover on non-selected rows: `background: var(--s2-bg-elevated)` (unchanged). The inset accent shadow distinguishes selected from merely hovered.
- Copy feedback: selected row background briefly flashes `var(--s2-positive)` with opacity, then fades back (150ms transition).
- `cursor: default` on rows (already the case).

### State

Single piece of state added to `FileBrowserPanel`:

```ts
private selectedPath: string | null = null;
```

No persistence needed — selection is ephemeral, session-only.

### Error Handling

`navigator.clipboard.writeText()` is wrapped in try/catch. On failure, log a warning via `console.warn('[FileBrowser] Clipboard write failed:', err)`. No user-facing error — the visual feedback simply doesn't trigger, which signals the copy didn't work.

### Extension Considerations

The existing chat copy button (`layout.ts:595`) already uses `navigator.clipboard.writeText()` from a user-initiated event (click) in the extension side panel. A keyboard-triggered copy (keydown from Cmd+C) also provides transient user activation, so the same API should work. The `clipboardWrite` permission is not required for `navigator.clipboard.writeText()` with user activation in Manifest V3 side panels, but if manual testing reveals issues, add it to `manifest.json` permissions.

### Scope

- **In scope**: File browser panel (`src/ui/file-browser-panel.ts`), styles in `index.html`
- **Out of scope**: Drag-and-drop to chat/terminal (potential future enhancement), multi-selection, right-click context menus

## Files Changed

| File                           | Change                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/file-browser-panel.ts` | Add `selectedPath` state, selection on row click, `keydown` listener, clipboard write, visual feedback, selection re-apply in `refresh()`, listener cleanup in `dispose()` |
| `index.html`                   | Add `.file-browser__item--selected` and copy-feedback CSS                                                                                                                  |

## Testing

- Unit test: verify `selectedPath` is set on row click and updates when a different row is clicked
- Unit test: verify selection survives a `refresh()` cycle (row still has `.file-browser__item--selected` class after refresh)
- Unit test: verify `keydown` listener is removed on `dispose()`
- Manual test: Cmd/Ctrl+C copies path when row is selected and no text is selected elsewhere
- Manual test: Ctrl+C in terminal still sends SIGINT when a file browser row happens to be selected
- Manual test: native text copy still works when text is selected in chat or elsewhere
- Manual test: verify in extension side panel that clipboard write succeeds on Cmd/Ctrl+C
