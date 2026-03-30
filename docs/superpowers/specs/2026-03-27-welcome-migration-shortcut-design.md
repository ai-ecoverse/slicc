# Welcome Sprinkle: "Migrate a page" Shortcut

**Date:** 2026-03-27
**Status:** Draft

## Problem

New users who come to slicc specifically to migrate a page must click through the full 5-step onboarding wizard before they can start. The migration skills (`aemcoder/skills/migration`) include a sprinkle with `data-sprinkle-autoopen` that provides a dedicated migration UI, but users have no way to reach it directly from the welcome screen.

## Solution

Add a "Migrate a page" purpose pill to the welcome sprinkle's first step. Selecting it short-circuits the onboarding flow: the welcome sprinkle shows a brief transition message, fires a dedicated lick, closes, and the agent installs the migration skills. The migrate-page sprinkle auto-opens after installation.

## Approach

Agent-driven (Approach A). The sprinkle fires a `shortcut-migrate` lick. `main.ts` handles UI lifecycle (set welcomed flag, close sprinkle). The welcome SKILL.md handles business logic (run upskill).

## Changes

### 1. welcome.shtml

Add `'migrate-page'` entry to the `PURPOSES` array:

```javascript
{ id: 'migrate-page', label: 'Migrate a page' }
```

In the purpose pill click handler, branch on `p.id === 'migrate-page'`. Instead of calling `goStep(2)`, call a new `startMigrationShortcut()` function that:

1. Shows the `sDone` completion state with text "Setting up migration tools..."
2. Hides dots, skip row, and banner
3. After a short delay (~500ms), fires `slicc.lick({ action: 'shortcut-migrate' })`

### 2. main.ts (extension mode, ~line 448)

Expand the welcome lick interception block:

```typescript
if (event.sprinkleName === 'welcome') {
  const action = (event.body as any)?.action;
  if (action === 'onboarding-complete' || action === 'shortcut-migrate') {
    localStorage.setItem('slicc-welcomed', '1');
  }
  if (action === 'shortcut-migrate') {
    sprinkleManager.close('welcome');
  }
}
```

The lick still routes to the cone via `client.sendSprinkleLick()`.

### 3. main.ts (CLI mode, ~line 1109)

Same logic as extension mode:

```typescript
if (isSprinkle && event.sprinkleName === 'welcome') {
  const action = (event.body as any)?.action;
  if (action === 'onboarding-complete' || action === 'shortcut-migrate') {
    localStorage.setItem('slicc-welcomed', '1');
  }
  if (action === 'shortcut-migrate') {
    sprinkleManager!.close('welcome');
  }
}
```

### 4. SKILL.md (welcome skill)

Add a `shortcut-migrate` handler section before "Handling follow-up licks":

```markdown
## Handling shortcut-migrate

When you receive a `[Sprinkle Event: welcome]` with `shortcut-migrate`:

1. Run `upskill aemcoder/skills --path migration --all` silently.
2. If it succeeds, do nothing further. The `migrate-page.shtml` sprinkle
   has `data-sprinkle-autoopen` and opens automatically after installation.
3. If it fails, tell the user the install failed and suggest they retry
   manually with the same command.

Do NOT save a profile, update CLAUDE.md, or write a greeting.
```

## Edge Cases

1. **Reload before agent processes lick** — `slicc-welcomed` is already set so welcome won't reopen. The lick is lost, but the user can run `upskill aemcoder/skills --path migration --all` manually.
2. **Migration skills already installed** — `upskill --all` is idempotent. `openNewAutoOpenSprinkles()` skips already-open sprinkles.
3. **No going back after click** — The transition message provides a moment of awareness. If unintended, the user closes the migrate-page sprinkle and uses slicc normally.
4. **Extension vs CLI** — Both code paths get the same treatment. No mode-specific behavior.

## Out of Scope

- No changes to the migration skills themselves
- No changes to the upskill command
- No changes to sprinkle-manager or sprinkle-discovery
- No new automated tests (welcome sprinkle is VFS content)

## Files Changed

| File                                                       | Change                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/vfs-root/shared/sprinkles/welcome/welcome.shtml` | Add migrate-page purpose, `startMigrationShortcut()` function  |
| `packages/webapp/src/ui/main.ts`                           | Handle `shortcut-migrate` lick in both extension and CLI paths |
| `packages/vfs-root/workspace/skills/welcome/SKILL.md`      | Add `shortcut-migrate` handler section                         |
