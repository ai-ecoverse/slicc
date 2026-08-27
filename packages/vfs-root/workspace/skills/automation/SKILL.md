---
name: automation
description: |
  Use this when setting up event-driven automation in SLICC — webhooks, cron
  tasks, or filesystem watchers that route events to a scoop or cone. Covers
  `webhook`,
  `crontask`, and `fswatch` shell commands. Read this BEFORE wiring up anything
  that should fire on a schedule, an HTTP call, or a VFS change.
allowed-tools: bash
---

# Automation: webhooks, cron, filesystem watchers

SLICC's automation primitives turn external or VFS-internal events into **licks** — messages routed to a work unit. Three shell commands set them up:

| Command    | Trigger                      | Use case                          |
| ---------- | ---------------------------- | --------------------------------- |
| `webhook`  | Inbound HTTP request         | Callbacks from external services  |
| `crontask` | Cron schedule                | Recurring background work         |
| `fswatch`  | VFS create / modify / delete | React to authored content changes |

All three take `--scoop <target>`, which names **a unit, not a species**: a scoop name, a cone name, or a folder (`cone-<slug>`, `<name>-scoop`). Omit it and events come back to whichever unit you are — the cone you are in, or the scoop itself if you are one. A target naming no live unit is dropped, never re-routed.

**If you want your own events, omit `--scoop` — never hardcode `cone`.** All three commands behave identically here, so omitting the flag is always available, and it works the same whether you are a cone or a scoop. The literal folder `cone` is not a synonym for "me": it belongs to whichever cone currently holds it, and it is handed to the next new cone after the original one is dropped. A skill that hardcodes it delivers its callbacks into another cone's chat in exactly the multi-cone workspaces where the target matters.

## `webhook`

Receive HTTP callbacks. The lick carries the request method, path, headers, and body; `create` allocates a path and prints the URL.

```bash
webhook create --scoop pr-watcher --name gh-prs
webhook create --scoop Research --name inbox   # a cone, by name
webhook create --name inbox                    # your own cone
webhook list && webhook delete wh-1
```

Flags:

- `--scoop <target>` — scoop name, cone name, or folder. Omit for your own cone.
- `--name <label>` — label shown in `webhook list`.
- `--filter <js>` — JS expression per request; falsy drops the event before the agent sees it.

## `crontask`

Run on a cron schedule. Standard 5-field cron (minute hour day month weekday).

```bash
crontask create --cron "0 * * * *" --scoop hourly-summary --name hourly
crontask create --cron "0 9 * * *" --name digest   # your own cone
crontask list && crontask delete ct-1   # `kill` is an alias for `delete`
```

Flags:

- `--cron <expr>` — required; 5-field cron expression.
- `--scoop <target>` — scoop name, cone name, or folder. Omit for your own cone.
- `--name <label>` — label.
- `--filter <js>` — JS expression evaluated each tick; falsy skips that fire.

## `fswatch`

Watch a VFS path; deliver a lick when a matching file is created, modified, or deleted.

```bash
fswatch create --path /workspace --pattern "*.md" --scoop doc-watcher --name md-changes
fswatch create --path /workspace/src --pattern "*.ts"   # your own cone
fswatch list && fswatch delete fsw-1
```

Events carry the change type (`create`, `modify`, `delete`) and the path.

## Don't

- Don't poll on a `crontask` for work the cone could do reactively. Cron is for genuinely recurring jobs (digests, refreshes); reactive work belongs on `fswatch`/`webhook`.
- Don't leave watchers/webhooks/crons orphaned. If the owning unit is gone, the lick is dropped — `... list` and `... delete` to clean up.
- Don't fan one trigger out to N near-identical entries. Register once, let the receiver dispatch.
