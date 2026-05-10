---
name: automation
description: |
  Use this when setting up event-driven automation in SLICC — webhooks, cron
  tasks, or filesystem watchers that route events to scoops. Covers `webhook`,
  `crontask`, and `fswatch` shell commands. Read this BEFORE wiring up anything
  that should fire on a schedule, an HTTP call, or a VFS change.
allowed-tools: bash
---

# Automation: webhooks, cron, filesystem watchers

SLICC's automation primitives turn external or VFS-internal events into **licks** — messages routed to a scoop (or to the cone if no scoop is named). Three shell commands set them up:

| Command    | Trigger                           | Use case                                 |
| ---------- | --------------------------------- | ---------------------------------------- |
| `webhook`  | Inbound HTTP request              | Receive callbacks from external services |
| `crontask` | Cron schedule                     | Recurring background work                |
| `fswatch`  | VFS file create / modify / delete | React to authored content changes        |

All three deliver events as licks. If `--scoop <name>` is set, the lick goes to that scoop; otherwise it goes to the cone.

## `webhook`

Receive HTTP callbacks. The event lick carries the request method, path, headers, and body.

```bash
webhook create --path /github-pr --scoop pr-watcher --name gh-prs
webhook list
webhook delete wh-1
```

## `crontask`

Run a scoop on a cron schedule. Standard 5-field cron (minute hour day month weekday).

```bash
crontask create --schedule "0 * * * *" --scoop hourly-summary --name hourly
crontask list
crontask delete ct-1
```

## `fswatch`

Watch a VFS path; deliver events as licks when files matching the pattern are created, modified, or deleted.

```bash
# Route .md changes under /workspace to a scoop.
fswatch create --path /workspace --pattern "*.md" --scoop doc-watcher --name md-changes

# Untargeted: route to the cone.
fswatch create --path /workspace/src --pattern "*.ts"

fswatch list
fswatch delete fsw-1
```

Events include the change type (`create`, `modify`, `delete`) and the file path.

## Don't

- Don't poll on a `crontask` to do work the cone could do reactively. Cron is for genuinely recurring jobs (digests, refreshes); reactive work belongs on `fswatch` or `webhook`.
- Don't leave watchers/webhooks/crons orphaned. If the owning scoop is gone, the lick has nowhere to go — `... list` and `... delete` to clean up.
- Don't fan a single trigger out to multiple scoops by registering N near-identical entries. Register once, let the receiving scoop dispatch.
