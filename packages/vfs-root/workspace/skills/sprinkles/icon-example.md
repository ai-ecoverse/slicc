# Lucide Icons in Sprinkles

Use `data-lucide` instead of emojis. Browse [lucide.dev/icons](https://lucide.dev/icons).

## Confirmation card

```shtml
<div class="sprinkle-action-card">
  <div class="sprinkle-action-card__header">
    <i data-lucide="check-circle" class="sprinkle-icon" style="color: var(--uxc-positive-text)"></i>
    Task Completed
  </div>
  <div class="sprinkle-action-card__body">Your changes have been saved.</div>
  <div class="sprinkle-action-card__actions">
    <button class="sprinkle-btn" onclick="slicc.lick('dismiss')">
      <i data-lucide="x" class="sprinkle-icon"></i> Dismiss
    </button>
  </div>
</div>
```

## Action menu

```shtml
<div class="sprinkle-action-card">
  <div class="sprinkle-action-card__header"><i data-lucide="file-text" class="sprinkle-icon"></i> Document Actions</div>
  <div class="sprinkle-action-card__body">
    <div class="sprinkle-stack">
      <button class="sprinkle-btn" onclick="slicc.lick({action:'edit'})"><i data-lucide="edit-3" class="sprinkle-icon"></i> Edit</button>
      <button class="sprinkle-btn" onclick="slicc.lick({action:'download'})"><i data-lucide="download" class="sprinkle-icon"></i> Download</button>
      <button class="sprinkle-btn" onclick="slicc.lick({action:'delete'})"><i data-lucide="trash-2" class="sprinkle-icon" style="color: var(--uxc-negative-text)"></i> Delete</button>
    </div>
  </div>
</div>
```

## Common names

**Status**: `check`, `check-circle`, `x`, `x-circle`, `alert-triangle`, `info`
**Actions**: `edit-3`, `save`, `download`, `trash-2`, `plus`, `search`
**Navigation**: `arrow-right`, `chevron-right`, `external-link`
**Files**: `file-text`, `folder`, `image`, `code`
**UI**: `settings`, `menu`, `eye`, `lock`
