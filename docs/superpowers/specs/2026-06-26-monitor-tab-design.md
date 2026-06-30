# Monitor Tab Design

A new built-in "monitor" tab in the SLICC workbench (alongside files, terminal, memory) that shows a read-only overview of all resources currently managed by SLICC.

## Problem

Users have no visibility into what SLICC is orchestrating without asking the agent or running shell commands (`crontask list`, `webhook list`, `workflow list`, etc.). A persistent dashboard surfaces this at a glance.

## Architecture

### Integration Point

The monitor tab follows the exact same pattern as the existing memory tab:

1. Add `{ id: 'monitor', label: 'monitor', kind: 'tool' }` to `BASE_TABS` in `wc-sprinkles.ts`
2. Add a `<slicc-surface surface-id="monitor" layout="flex">` containing a `<div class="wcui-monitor">` host in `wc-shell.ts`
3. Add a lazy activation handler in `wc-workbench.ts` that populates content on first open
4. Wire the host ref through `WcWorkbenchDeps` in `wc-live.ts`

### Data Flow

```
User clicks "monitor" dock icon
  → wireDockToWorkbench fires onSurfaceActivate('monitor')
  → createWorkbenchActivator handler runs
  → buildMonitorSections() queries all data sources
  → DOM sections rendered into monitorHost
  → Live subscriptions attached for scoops/workflows
```

On subsequent activations, the panel re-queries all data sources (cheap — all in-memory or single IDB reads).

## Sections

Seven collapsible sections, rendered top-to-bottom. Each section has:

- A header row: `▾`/`▸` toggle + section name + count badge
- Zero or more item rows with key info

### 1. Scoops

**Source:** `orchestrator.getScoops()` + `orchestrator.isProcessing(jid)`

| Column | Value                                    |
| ------ | ---------------------------------------- |
| Name   | `scoop.name`                             |
| Status | `processing` / `idle` / `init` / `error` |

Cone is listed first, marked with a subtle "(cone)" suffix. Scoops with `notifyOnComplete: false` (ephemeral agents) are excluded.

### 2. Cron Tasks

**Source:** `getLickManager().listCronTasks()`

| Column   | Value                           |
| -------- | ------------------------------- |
| Name     | `entry.name`                    |
| Schedule | `entry.cron` (raw expression)   |
| Target   | `entry.scoop` or "cone"         |
| Next Run | `entry.nextRun` (relative time) |

### 3. Webhooks

**Source:** `getLickManager().listWebhooks()`

| Column | Value                   |
| ------ | ----------------------- |
| Name   | `entry.name`            |
| Target | `entry.scoop` or "cone" |

URL is not shown inline (too long) but could be a tooltip or copy-on-click in future.

### 4. Workflows

**Source:** `globalThis.__slicc_workflows.listRuns()`

| Column   | Value                                   |
| -------- | --------------------------------------- |
| Name     | `run.name` or "unnamed"                 |
| Status   | `running` / `done` / `error` / `killed` |
| Progress | `agentsDone/agentsStarted`              |

Only show runs with status `running` or `paused` by default. Completed runs shown in a collapsed "Recent" sub-group (last 5).

### 5. Mounts

**Source:** `getAllMountEntries()` from `fs/mount-table-store.ts`

| Column | Value                 |
| ------ | --------------------- |
| Path   | `entry.targetPath`    |
| Kind   | `local` / `s3` / `da` |

### 6. MCP Servers

**Source:** `listServers()` from `shell/mcp/store.ts`

| Column | Value                  |
| ------ | ---------------------- |
| Name   | server key             |
| Tools  | count of `entry.tools` |

### 7. OAuth Accounts

**Source:** Provider settings / account registry

| Column   | Value       |
| -------- | ----------- |
| Provider | provider ID |

Collapsed by default (least frequently needed).

## Rendering

### DOM Structure

```html
<div class="wcui-monitor">
  <div class="monitor-section" data-section="scoops">
    <button class="monitor-section__header" aria-expanded="true">
      <span class="monitor-section__toggle">▾</span>
      <span class="monitor-section__title">Scoops</span>
      <span class="monitor-section__count">3</span>
    </button>
    <div class="monitor-section__body">
      <div class="monitor-row">
        <span class="monitor-row__dot monitor-row__dot--active"></span>
        <span class="monitor-row__name">cone</span>
        <span class="monitor-row__meta">processing</span>
      </div>
      <!-- ... more rows ... -->
    </div>
  </div>
  <!-- ... more sections ... -->
</div>
```

### Styling

- Follows the memory panel pattern: flex column, gap between sections, `overflow-y: auto`, `padding: 10px`
- Section headers: `font-size: 12px`, `font-weight: 600`, `color: var(--txt-2)`, uppercase
- Count badge: `background: var(--bg-3)`, `border-radius: 8px`, `padding: 0 6px`, `font-size: 11px`
- Item rows: `font-size: 12px`, `padding: 4px 0 4px 16px`, `display: flex`, `gap: 8px`
- Status dots: 8px circles — green (`#4caf50`) for active/processing, grey (`#666`) for idle, red (`#f44`) for error
- Empty sections: header only, count shows "0", body hidden, header text at 50% opacity
- Collapse state persisted in `localStorage['slicc_monitor_collapsed']` as JSON array of section IDs

### Live Updates

For scoops and workflows (the two most dynamic resources), attach observers:

- `orchestrator.observeScoop()` for each scoop — update status dot on change
- `globalThis.__slicc_workflows.observeRun()` for running workflows — update progress

Other sections (cron, webhooks, mounts, MCP, OAuth) are static enough to refresh only on tab activation.

## File Plan

| File                                        | Change                                             |
| ------------------------------------------- | -------------------------------------------------- |
| `packages/webapp/src/ui/wc/wc-sprinkles.ts` | Add monitor to BASE_TABS                           |
| `packages/webapp/src/ui/wc/wc-shell.ts`     | Add monitor surface + CSS                          |
| `packages/webapp/src/ui/wc/wc-workbench.ts` | Add monitor activation handler + deps              |
| `packages/webapp/src/ui/wc/wc-monitor.ts`   | **New** — `buildMonitorSections()` rendering logic |
| `packages/webapp/src/ui/wc/wc-live.ts`      | Wire monitorHost into activator deps               |

## Testing

- Unit test for `buildMonitorSections()` with mock data sources (verifies correct DOM output)
- Integration: activate monitor tab, verify sections render with live orchestrator data

## Out of Scope

- Actions (delete, stop, create) — stays read-only; use terminal for mutations
- Filtering or search within sections
- Real-time streaming updates for cron/webhooks/mounts (refresh on activate is sufficient)
- Custom ordering or pinning of sections
