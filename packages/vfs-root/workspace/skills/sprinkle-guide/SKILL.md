---
name: Sprinkle Guide
description: Inline cards, sprinkle chat, cone orchestration rules for UI panels
---

# Sprinkle Guide

## Inline Cards

Use ` ```shtml ` fenced code blocks to show interactive cards inline in chat. Cards render after your response completes. Only `slicc.lick()` is available (no state, no readFile).

Use for: choices, confirmations, progress, quick actions.
Use panel sprinkles for: dashboards, reports, editors, persistent UIs.

Example:

    ```shtml
    <div class="sprinkle-action-card">
      <div class="sprinkle-action-card__header">
        Deploy to production?
        <span class="sprinkle-badge sprinkle-badge--notice">staging passed</span>
      </div>
      <div class="sprinkle-action-card__body">Branch main, commit abc123</div>
      <div class="sprinkle-action-card__actions">
        <button class="sprinkle-btn sprinkle-btn--secondary" onclick="slicc.lick('cancel')">Cancel</button>
        <button class="sprinkle-btn sprinkle-btn--primary" onclick="slicc.lick({action:'deploy',data:{env:'prod'}})">Deploy</button>
      </div>
    </div>
    ```

When the user clicks a button, you receive the lick as a message. Respond conversationally.

Available components: all `.sprinkle-*` classes from the style guide (`read_file /workspace/skills/sprinkles/style-guide.md`).

## Sprinkle Chat: Blocking Inline Cards

`sprinkle chat` shows an inline card and **blocks until the user clicks**, returning the result as JSON. Use when a tool needs user input mid-execution.

```bash
sprinkle chat '<div class="sprinkle-action-card">
  <div class="sprinkle-action-card__header">Deploy to production?</div>
  <div class="sprinkle-action-card__actions">
    <button class="sprinkle-btn sprinkle-btn--secondary" onclick="slicc.lick({action:\"cancel\"})">Cancel</button>
    <button class="sprinkle-btn sprinkle-btn--primary" onclick="slicc.lick({action:\"deploy\",env:\"prod\"})">Deploy</button>
  </div>
</div>'
```

## Cone Orchestration Rules

### Rule 1: One scoop per sprinkle, named identically

Scoop name MUST match sprinkle name. Sprinkle `giro-winners` = scoop `giro-winners`.

### Rule 2: Cone never touches sprinkle files or commands

The cone MUST NOT: write/edit `.shtml` files, run `sprinkle open/close/send`, handle lick events directly. ALL sprinkle work goes through scoops via `feed_scoop`.

### Rules 3-5

See the sprinkles skill (`read_file /workspace/skills/sprinkles/SKILL.md`) for creating, modifying, and handling lick events.

**NEVER handle a lick in the cone. Always `feed_scoop`.**
