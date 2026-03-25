# Migrate Page Sprinkle Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click "Migrate This Page" sprinkle that triggers the full EDS migration from the extension's active tab.

**Architecture:** Three new/modified files, zero TypeScript changes. The sprinkle `.shtml` file is auto-discovered by the existing VFS glob. The cone handles the lick event directly (carve-out from Rules 2/5) and pushes progress via `sprinkle send`. Recovery from panel-close uses `currentMigration` in the config file.

**Tech Stack:** HTML/JS (sprinkle), Markdown (SKILL.md), JSON (config). All existing bridge APIs.

**Spec:** `docs/superpowers/specs/2026-03-16-migrate-page-sprinkle-design.md`

---

## File Structure

| File                                                            | Action | Responsibility                                                                                                                  |
| --------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/vfs-root/shared/migrate-config.json`                       | Create | Default workspace config with `adobe/aem-boilerplate` repo and `currentMigration: null`                                         |
| `packages/vfs-root/shared/sprinkles/migrate-page/migrate-page.shtml` | Create | Sprinkle UI: 4 states (ready, migrating, done, error), bridge API integration, state recovery                                   |
| `packages/vfs-root/workspace/skills/migrate-page/SKILL.md`           | Modify | Add "Sprinkle Trigger" section (carve-out + lick handling) and `sprinkle send` / config-write commands at each phase transition |

No TypeScript source changes needed. The `import.meta.glob('/packages/vfs-root/**/*')` in `packages/webapp/src/scoops/skills.ts` auto-discovers all files under `packages/vfs-root/`.

---

## Chunk 1: Implementation

### Task 1: Create workspace config

**Files:**

- Create: `packages/vfs-root/shared/migrate-config.json`

- [ ] **Step 1: Create the config file**

```json
{
  "repo": "adobe/aem-boilerplate",
  "currentMigration": null
}
```

- [ ] **Step 2: Verify the file is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('packages/vfs-root/shared/migrate-config.json', 'utf8')); console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add packages/vfs-root/shared/migrate-config.json
git commit -m "feat(migrate): add default workspace config"
```

---

### Task 2: Create the migrate-page sprinkle

**Files:**

- Create: `packages/vfs-root/shared/sprinkles/migrate-page/migrate-page.shtml`

**Reference:**

- Existing sprinkle: `packages/vfs-root/shared/sprinkles/welcome/welcome.shtml`
- Bridge API: `slicc.lick()`, `slicc.readFile()`, `slicc.on('update')`, `slicc.getState()`, `slicc.setState()`, `slicc.close()`
- Component classes: `.sprinkle-stack`, `.sprinkle-card`, `.sprinkle-btn`, `.sprinkle-btn--primary`, `.sprinkle-progress-bar`, `.sprinkle-status-light`, `.sprinkle-badge`, `.sprinkle-heading`, `.sprinkle-body`, `.sprinkle-detail`, `.sprinkle-row`, `.sprinkle-btn-group`
- Design rule: No emoji in headings/labels. Use badges, status lights, and semantic color.

- [ ] **Step 1: Create the sprinkle file with HTML structure**

The sprinkle has one root `<div>` with `data-sprinkle-title="Migrate Page"`. Four state containers, shown/hidden via JavaScript. The structure:

```html
<div
  data-sprinkle-title="Migrate Page"
  class="sprinkle-stack"
  style="padding: 16px; max-width: 480px; margin: 0 auto;"
>
  <!-- Ready state -->
  <div id="state-ready">
    <div class="sprinkle-row" style="align-items: center; gap: 8px; margin-bottom: 12px;">
      <span class="sprinkle-status-light sprinkle-status-light--positive"></span>
      <span class="sprinkle-detail" id="repo-label">loading...</span>
    </div>
    <button
      class="sprinkle-btn sprinkle-btn--primary"
      style="width: 100%;"
      onclick="handleMigrate()"
    >
      Migrate This Page
    </button>
    <div class="sprinkle-detail" style="text-align: center; margin-top: 8px;">
      Targets the active browser tab
    </div>
  </div>

  <!-- No config state -->
  <div id="state-no-config" style="display: none;">
    <div
      class="sprinkle-card"
      style="border-color: var(--s2-color-warning, #e68a00); margin-bottom: 12px;"
    >
      <div class="sprinkle-body" style="color: var(--s2-color-warning, #e68a00);">
        No repo configured
      </div>
      <div class="sprinkle-detail">Click below — the agent will ask in chat</div>
    </div>
    <button
      class="sprinkle-btn sprinkle-btn--primary"
      style="width: 100%;"
      onclick="handleMigrate()"
    >
      Migrate This Page
    </button>
  </div>

  <!-- Migrating state -->
  <div id="state-migrating" style="display: none;">
    <div class="sprinkle-row" style="justify-content: space-between; margin-bottom: 12px;">
      <span class="sprinkle-detail" id="migrating-url">...</span>
      <span class="sprinkle-badge sprinkle-badge--informative" id="migrating-phase-badge"
        >Phase 1/4</span
      >
    </div>

    <div class="sprinkle-stack" style="gap: 10px;" id="phase-list">
      <!-- Phases rendered by JavaScript -->
    </div>

    <div class="sprinkle-progress-bar" style="margin-top: 16px;">
      <div class="fill" id="progress-fill" style="width: 0%;"></div>
    </div>
  </div>

  <!-- Done state -->
  <div id="state-done" style="display: none; text-align: center;">
    <div class="sprinkle-heading" style="color: var(--s2-color-positive, #4ade80);">
      Migration Complete
    </div>
    <div class="sprinkle-detail" id="done-url" style="margin-top: 4px;">...</div>
    <div class="sprinkle-btn-group" style="justify-content: center; margin-top: 16px;">
      <button class="sprinkle-btn sprinkle-btn--primary" id="preview-btn" onclick="handlePreview()">
        Preview
      </button>
      <button class="sprinkle-btn sprinkle-btn--secondary" onclick="handleReset()">
        New Migration
      </button>
    </div>
  </div>

  <!-- Error state -->
  <div id="state-error" style="display: none; text-align: center;">
    <div class="sprinkle-heading" style="color: var(--s2-color-negative, #f87171);">
      Migration Failed
    </div>
    <div class="sprinkle-detail" id="error-message" style="margin-top: 4px;">...</div>
    <button
      class="sprinkle-btn sprinkle-btn--secondary"
      style="margin-top: 16px;"
      onclick="handleReset()"
    >
      Try Again
    </button>
  </div>
</div>
```

- [ ] **Step 2: Add the JavaScript logic**

Appended as a `<script>` block after the HTML. Handles state transitions, bridge API calls, and recovery.

```html
<script>
  // --- State management ---
  var PHASES = ['extraction', 'decomposition', 'blocks', 'assembly'];
  var PHASE_LABELS = {
    extraction: 'Extraction',
    decomposition: 'Decomposition',
    blocks: 'Generating Blocks',
    assembly: 'Assembly',
  };
  var PHASE_PROGRESS = { extraction: 25, decomposition: 50, blocks: 75, assembly: 90 };
  var currentState = 'ready';
  var previewUrl = '';

  function showState(name) {
    currentState = name;
    var states = ['ready', 'no-config', 'migrating', 'done', 'error'];
    for (var i = 0; i < states.length; i++) {
      var el = document.getElementById('state-' + states[i]);
      if (el) el.style.display = states[i] === name ? '' : 'none';
    }
  }

  function renderPhases(currentPhase, status, detail) {
    var list = document.getElementById('phase-list');
    if (!list) return;
    var html = '';
    var currentIdx = PHASES.indexOf(currentPhase);
    for (var i = 0; i < PHASES.length; i++) {
      var phase = PHASES[i];
      var label = PHASE_LABELS[phase];
      var icon,
        color,
        sub = '';
      if (i < currentIdx || (i === currentIdx && status === 'done')) {
        icon = '&#10003;';
        color = 'var(--s2-color-positive, #4ade80)';
      } else if (i === currentIdx && status === 'running') {
        icon = '&#9672;';
        color = 'var(--s2-color-informative, #60a5fa)';
        if (detail)
          sub =
            '<div class="sprinkle-detail" style="color: var(--s2-color-informative, #60a5fa);">' +
            detail +
            '</div>';
      } else {
        icon = '&#9675;';
        color = 'var(--s2-color-gray-500, #555)';
      }
      html +=
        '<div class="sprinkle-row" style="align-items: flex-start; gap: 10px;">' +
        '<span style="color:' +
        color +
        '; font-size: 14px; line-height: 1.4;">' +
        icon +
        '</span>' +
        '<div><div style="font-size: 13px; color:' +
        color +
        ';">' +
        label +
        '</div>' +
        sub +
        '</div></div>';
    }
    list.innerHTML = html;

    // Update phase badge
    var badge = document.getElementById('migrating-phase-badge');
    if (badge) badge.textContent = 'Phase ' + (currentIdx + 1) + '/4';

    // Update progress bar
    var fill = document.getElementById('progress-fill');
    if (fill) {
      var pct = PHASE_PROGRESS[currentPhase] || 0;
      if (status === 'done' && currentPhase === 'assembly') pct = 100;
      fill.setAttribute('data-value', pct);
      fill.style.width = pct + '%';
    }
  }

  // --- Event handlers ---
  function handleMigrate() {
    showState('migrating');
    renderPhases('extraction', 'running', null);
    var urlEl = document.getElementById('migrating-url');
    if (urlEl) urlEl.textContent = 'Starting...';
    slicc.lick({ action: 'migrate-page' });
  }

  function handlePreview() {
    if (previewUrl) window.open(previewUrl, '_blank');
  }

  function handleReset() {
    previewUrl = '';
    showState('ready');
    loadConfig();
  }

  // --- Update handler (cone -> sprinkle) ---
  function handleUpdate(data) {
    if (!data || !data.phase) return;
    slicc.setState(data);

    if (data.phase === 'done') {
      previewUrl = data.previewUrl || '';
      var doneUrl = document.getElementById('done-url');
      if (doneUrl) doneUrl.textContent = data.url || 'Migration complete';
      showState('done');
      return;
    }

    if (data.phase === 'error') {
      var errMsg = document.getElementById('error-message');
      if (errMsg) errMsg.textContent = data.message || 'Unknown error';
      showState('error');
      return;
    }

    // Active migration phase update
    showState('migrating');
    var urlEl = document.getElementById('migrating-url');
    if (urlEl && data.url) urlEl.textContent = data.url;
    renderPhases(data.phase, data.status || 'running', data.detail || null);
  }

  slicc.on('update', handleUpdate);

  // --- Config loading ---
  function loadConfig() {
    slicc
      .readFile('/shared/migrate-config.json')
      .then(function (content) {
        try {
          var config = JSON.parse(content);
          var label = document.getElementById('repo-label');
          if (label) label.textContent = config.repo || 'no repo set';

          // Check for in-progress migration (recovery)
          if (config.currentMigration && config.currentMigration.phase) {
            handleUpdate(config.currentMigration);
            return;
          }

          if (!config.repo) {
            showState('no-config');
          } else {
            showState('ready');
          }
        } catch (e) {
          showState('no-config');
        }
      })
      .catch(function () {
        showState('no-config');
      });
  }

  // --- Init ---
  // Restore from persisted state first, then config
  var saved = slicc.getState();
  if (saved && saved.phase && saved.phase !== 'done' && saved.phase !== 'error') {
    handleUpdate(saved);
    loadConfig(); // Also check config for authoritative state
  } else {
    loadConfig();
  }
</script>
```

- [ ] **Step 3: Verify the build includes the new sprinkle**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds (exit 0). The `import.meta.glob('/packages/vfs-root/**/*')` auto-discovers the file.

Run: `npm run build:extension 2>&1 | tail -5`
Expected: Build succeeds (exit 0).

- [ ] **Step 4: Verify the sprinkle is discoverable**

Run: `npx vitest run packages/webapp/src/ui/sprinkle-discovery.test.ts 2>&1 | tail -10`
Expected: Existing tests still pass. (New sprinkle doesn't break discovery — it just adds a new `.shtml` file to the VFS.)

- [ ] **Step 5: Commit**

```bash
git add packages/vfs-root/shared/sprinkles/migrate-page/migrate-page.shtml
git commit -m "feat(migrate): add migrate-page sprinkle with 4-state UI"
```

---

### Task 3: Add Sprinkle Trigger section to SKILL.md

**Files:**

- Modify: `packages/vfs-root/workspace/skills/migrate-page/SKILL.md` (insert after line 23, before "## Four Phases")

- [ ] **Step 1: Add the Sprinkle Trigger section**

Insert after the "Triggers" section (line 23) and before "## Four Phases" (line 25):

````markdown
## Sprinkle Trigger

**EXCEPTION TO RULES 2 AND 5:** When this skill is triggered via a sprinkle
lick event, the cone handles the lick directly and runs `sprinkle send`
commands for progress updates. This overrides the general prohibition on
cone-direct lick handling and `sprinkle send` usage. The cone is the natural
orchestrator because it creates scoops in Phase 3 (scoops cannot create
scoops).

When you receive a lick from the `migrate-page` sprinkle:

1. Run `playwright-cli tab-list` and find the entry with `active: true`.
   Extract its URL. If no active HTTP(S) tab exists, send an error:
   ```bash
   sprinkle send migrate-page '{"phase":"error","message":"No page to migrate — navigate to a webpage first"}'
   ```
````

2. Read the workspace config:
   ```bash
   read_file /shared/migrate-config.json
   ```
   Parse the `repo` field. If the file is missing or `repo` is empty, ask
   the user in chat for the repo (`owner/repo`), then write the config:
   ```bash
   write_file /shared/migrate-config.json
   {"repo":"owner/repo-name","currentMigration":null}
   ```
3. Start Phase 1 with the extracted URL and repo. Follow the standard
   4-phase flow below.

### Progress Reporting

At each phase transition, run BOTH of these (the `sprinkle send` updates the
live UI; the `write_file` persists state for recovery if the side panel
closes):

```bash
sprinkle send migrate-page '{"phase":"PHASE","status":"STATUS","detail":"DETAIL","url":"SOURCE_URL"}'
```

```bash
write_file /shared/migrate-config.json
{"repo":"REPO","currentMigration":{"phase":"PHASE","status":"STATUS","detail":"DETAIL","url":"SOURCE_URL"}}
```

**Phase transition points** (add these commands at each point):

| When                       | phase           | status    | detail                          |
| -------------------------- | --------------- | --------- | ------------------------------- |
| Phase 1 starts             | `extraction`    | `running` | —                               |
| Phase 1 complete           | `extraction`    | `done`    | —                               |
| Phase 2 starts             | `decomposition` | `running` | —                               |
| Phase 2 complete           | `decomposition` | `done`    | `{N} blocks identified`         |
| Phase 3 starts             | `blocks`        | `running` | block names                     |
| Phase 3 scoop completes    | `blocks`        | `running` | `name1, name2 ({done}/{total})` |
| Phase 3 complete           | `blocks`        | `done`    | —                               |
| Phase 4 starts             | `assembly`      | `running` | —                               |
| Phase 4 complete (success) | `done`          | —         | set `url` and `previewUrl`      |
| Any phase fails            | `error`         | —         | set `message`                   |

On completion, clear `currentMigration`:

```bash
sprinkle send migrate-page '{"phase":"done","url":"SOURCE_URL","previewUrl":"PREVIEW_URL"}'
```

```bash
write_file /shared/migrate-config.json
{"repo":"REPO","currentMigration":null}
```

````

- [ ] **Step 2: Verify SKILL.md is well-formed**

Run: `head -80 packages/vfs-root/workspace/skills/migrate-page/SKILL.md`
Expected: Frontmatter intact, "Sprinkle Trigger" section appears between "Triggers" and "Four Phases".

- [ ] **Step 3: Commit**

```bash
git add packages/vfs-root/workspace/skills/migrate-page/SKILL.md
git commit -m "feat(migrate): add sprinkle trigger and progress reporting to SKILL.md"
````

---

### Task 4: Verify full build pipeline

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: No errors (no TypeScript files changed, but verifying nothing broke).

- [ ] **Step 2: Run all tests**

Run: `npm run test`
Expected: All tests pass.

- [ ] **Step 3: Run production build**

Run: `npm run build`
Expected: Build succeeds. The new files in `packages/vfs-root/shared/` are included via `import.meta.glob`.

- [ ] **Step 4: Run extension build**

Run: `npm run build:extension`
Expected: Build succeeds.

- [ ] **Step 5: Manual verification (extension mode)**

Load the built extension from `dist/extension/` in Chrome:

1. Open `chrome://extensions` → Load unpacked → select `dist/extension/`
2. Open the side panel
3. Click [+] in the sprinkle picker → "Migrate Page" should appear
4. Open the sprinkle → should show Ready state with `adobe/aem-boilerplate` repo indicator
5. Navigate to any webpage, click "Migrate This Page" → should trigger lick and transition to Migrating state
