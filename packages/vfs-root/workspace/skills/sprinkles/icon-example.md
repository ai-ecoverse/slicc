# Lucide Icons Example

This shows how to use Lucide icons in inline sprinkles instead of emojis.

## Simple confirmation card with icons

````shtml
<div class="sprinkle-action-card">
  <div class="sprinkle-action-card__header">
    <i data-lucide="check-circle" style="color: var(--uxc-positive-text)"></i>
    Task Completed
  </div>
  <div class="sprinkle-action-card__body">
    Your changes have been saved successfully.
  </div>
  <div class="sprinkle-action-card__actions">
    <button class="sprinkle-btn" onclick="slicc.lick('dismiss')">
      <i data-lucide="x"></i> Dismiss
    </button>
  </div>
</div>
````

## Status options with icons

````shtml
<div class="sprinkle-action-card">
  <div class="sprinkle-action-card__header">Select Status</div>
  <div class="sprinkle-action-card__body">
    <div class="sprinkle-stack">
      <button class="sprinkle-btn" onclick="slicc.lick({action:'status',value:'success'})">
        <i data-lucide="check-circle" style="color: var(--uxc-positive-text)"></i> Success
      </button>
      <button class="sprinkle-btn" onclick="slicc.lick({action:'status',value:'warning'})">
        <i data-lucide="alert-triangle" style="color: var(--uxc-notice-text)"></i> Warning
      </button>
      <button class="sprinkle-btn" onclick="slicc.lick({action:'status',value:'error'})">
        <i data-lucide="x-circle" style="color: var(--uxc-negative-text)"></i> Error
      </button>
      <button class="sprinkle-btn" onclick="slicc.lick({action:'status',value:'info'})">
        <i data-lucide="info" style="color: var(--uxc-accent-text)"></i> Info
      </button>
    </div>
  </div>
</div>
````

## Action menu with icons

````shtml
<div class="sprinkle-action-card">
  <div class="sprinkle-action-card__header">
    <i data-lucide="file-text"></i> Document Actions
  </div>
  <div class="sprinkle-action-card__body">
    <div class="sprinkle-stack">
      <button class="sprinkle-btn" onclick="slicc.lick({action:'edit'})">
        <i data-lucide="edit-3"></i> Edit
      </button>
      <button class="sprinkle-btn" onclick="slicc.lick({action:'download'})">
        <i data-lucide="download"></i> Download
      </button>
      <button class="sprinkle-btn" onclick="slicc.lick({action:'share'})">
        <i data-lucide="share-2"></i> Share
      </button>
      <button class="sprinkle-btn" onclick="slicc.lick({action:'delete'})">
        <i data-lucide="trash-2" style="color: var(--uxc-negative-text)"></i> Delete
      </button>
    </div>
  </div>
</div>
````

## Common icon names

**Status**: `check`, `check-circle`, `x`, `x-circle`, `alert-triangle`, `alert-circle`, `info`, `help-circle`

**Actions**: `edit`, `edit-2`, `edit-3`, `save`, `download`, `upload`, `trash`, `trash-2`, `plus`, `minus`, `search`

**Navigation**: `arrow-right`, `arrow-left`, `arrow-up`, `arrow-down`, `chevron-right`, `chevron-left`, `chevron-up`, `chevron-down`, `external-link`

**Files**: `file`, `file-text`, `folder`, `folder-open`, `image`, `code`

**UI**: `settings`, `menu`, `more-vertical`, `more-horizontal`, `eye`, `eye-off`, `lock`, `unlock`

Browse all icons at [lucide.dev/icons](https://lucide.dev/icons)
