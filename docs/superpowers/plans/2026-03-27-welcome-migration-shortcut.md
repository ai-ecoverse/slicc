# Welcome Migration Shortcut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Migrate a page" shortcut to the welcome sprinkle that bypasses onboarding, installs migration skills, and auto-opens the migration UI.

**Architecture:** The sprinkle fires a `shortcut-migrate` lick. `main.ts` handles UI cleanup (set welcomed flag, close sprinkle) in both extension and CLI paths. The welcome SKILL.md tells the agent to run `upskill` when it receives the lick.

**Tech Stack:** Vanilla JS (sprinkle), TypeScript (main.ts), Markdown (SKILL.md)

**Spec:** `docs/superpowers/specs/2026-03-27-welcome-migration-shortcut-design.md`

---

### Task 1: Add "Migrate a page" purpose and shortcut function to welcome.shtml

**Files:**

- Modify: `packages/vfs-root/shared/sprinkles/welcome/welcome.shtml`

- [ ] **Step 1: Add the new purpose to the PURPOSES array**

In `welcome.shtml`, add `migrate-page` as the first entry in the `PURPOSES` array (line 329):

```javascript
var PURPOSES = [
  { id: 'migrate-page', label: 'Migrate a page' },
  { id: 'work', label: 'Work' },
  { id: 'school', label: 'School' },
  { id: 'personal', label: 'Personal' },
  { id: 'side-project', label: 'Side project' },
  { id: 'exploring', label: 'Just exploring' },
];
```

- [ ] **Step 2: Add the `startMigrationShortcut()` function**

Add this function after the `skipStep()` function (after line 538), before the closing `</script>` tag:

```javascript
function startMigrationShortcut() {
  document.getElementById('s' + cur).classList.remove('active');
  document.getElementById('sDone').classList.add('active');
  document.querySelector('#sDone .step-heading').textContent = 'Setting up migration tools\u2026';
  document.getElementById('dots').style.display = 'none';
  document.getElementById('banner').style.display = 'none';
  document.getElementById('skipRow').style.display = 'none';
  setTimeout(function () {
    if (window.slicc) {
      slicc.lick({ action: 'shortcut-migrate' });
    }
  }, 500);
}
```

- [ ] **Step 3: Branch the purpose pill click handler**

Replace the pill `onclick` handler (lines 414-420) to branch on `migrate-page`:

```javascript
btn.onclick = function () {
  profile.purpose = p.id;
  purposeEl.querySelectorAll('.pill').forEach(function (el) {
    el.classList.remove('selected');
  });
  btn.classList.add('selected');
  if (p.id === 'migrate-page') {
    setTimeout(function () {
      startMigrationShortcut();
    }, 300);
  } else {
    setTimeout(function () {
      goStep(2);
    }, 300);
  }
};
```

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/vfs-root/shared/sprinkles/welcome/welcome.shtml
git add packages/vfs-root/shared/sprinkles/welcome/welcome.shtml
git commit -m "feat(welcome): add 'Migrate a page' purpose shortcut"
```

---

### Task 2: Handle shortcut-migrate lick in main.ts (extension mode)

**Files:**

- Modify: `packages/webapp/src/ui/main.ts:446-455`

- [ ] **Step 1: Expand the welcome lick interception block**

Replace the existing block at lines 446-455:

```typescript
if (event.type === 'sprinkle') {
  // Mark onboarding complete so welcome sprinkle doesn't reappear
  if (event.sprinkleName === 'welcome' && (event.body as any)?.action === 'onboarding-complete') {
    localStorage.setItem('slicc-welcomed', '1');
  }
  client.sendSprinkleLick(event.sprinkleName!, event.body);
}
```

With:

```typescript
if (event.type === 'sprinkle') {
  // Handle welcome sprinkle lifecycle events
  if (event.sprinkleName === 'welcome') {
    const action = (event.body as any)?.action;
    if (action === 'onboarding-complete' || action === 'shortcut-migrate') {
      localStorage.setItem('slicc-welcomed', '1');
    }
    if (action === 'shortcut-migrate') {
      sprinkleManager.close('welcome');
    }
  }
  client.sendSprinkleLick(event.sprinkleName!, event.body);
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/webapp/src/ui/main.ts
git add packages/webapp/src/ui/main.ts
git commit -m "feat(welcome): handle shortcut-migrate lick in extension mode"
```

---

### Task 3: Handle shortcut-migrate lick in main.ts (CLI mode)

**Files:**

- Modify: `packages/webapp/src/ui/main.ts:1109-1116`

- [ ] **Step 1: Expand the CLI-mode welcome lick interception block**

Replace the existing block at lines 1109-1116:

```typescript
// Mark onboarding complete so welcome sprinkle doesn't reappear
if (
  isSprinkle &&
  event.sprinkleName === 'welcome' &&
  (event.body as any)?.action === 'onboarding-complete'
) {
  localStorage.setItem('slicc-welcomed', '1');
}
```

With:

```typescript
// Handle welcome sprinkle lifecycle events
if (isSprinkle && event.sprinkleName === 'welcome') {
  const action = (event.body as any)?.action;
  if (action === 'onboarding-complete' || action === 'shortcut-migrate') {
    localStorage.setItem('slicc-welcomed', '1');
  }
  if (action === 'shortcut-migrate') {
    sprinkleManager?.close('welcome');
  }
}
```

Note: `sprinkleManager?.close` uses optional chaining because the CLI-mode variable is `SprinkleManager | null`.

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/webapp/src/ui/main.ts
git add packages/webapp/src/ui/main.ts
git commit -m "feat(welcome): handle shortcut-migrate lick in CLI mode"
```

---

### Task 4: Add shortcut-migrate handler to welcome SKILL.md

**Files:**

- Modify: `packages/vfs-root/workspace/skills/welcome/SKILL.md`

- [ ] **Step 1: Add the shortcut-migrate handler section**

Insert the following section before the existing `## Handling follow-up licks` section (before line 68):

````markdown
## Handling shortcut-migrate

When you receive a `[Sprinkle Event: welcome]` with `shortcut-migrate`, follow these steps:

1. Run this command silently (do NOT show the output to the user):

```bash
upskill aemcoder/skills --path migration --all
```
````

2. If it succeeds, do nothing further. The `migrate-page.shtml` sprinkle has `data-sprinkle-autoopen` and opens automatically after installation.
3. If it fails, tell the user the install failed and suggest they retry manually with `upskill aemcoder/skills --path migration --all`.

Do NOT save a profile, update `/shared/CLAUDE.md`, or write a greeting.

````

- [ ] **Step 2: Commit**

```bash
npx prettier --write packages/vfs-root/workspace/skills/welcome/SKILL.md
git add packages/vfs-root/workspace/skills/welcome/SKILL.md
git commit -m "feat(welcome): add shortcut-migrate handler to welcome skill"
````

---

### Task 5: Verify full build

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 2: Run tests**

Run: `npm run test`
Expected: PASS, no regressions.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS, clean build output.

- [ ] **Step 4: Run extension build**

Run: `npm run build -w @slicc/chrome-extension`
Expected: PASS, clean build output.
