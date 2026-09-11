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

All three take `--scoop <target>`, which names **a unit, not a species**: a scoop name, a cone name, or a folder (`cone-<slug>`, `<name>-scoop`). Omit it and events come back to whichever unit you are — the cone you are in, or the scoop itself if you are one. A target naming no live unit is **refused at create time** (exit 1, listing the valid targets) — create the scoop first, then register the webhook / cron task / watcher against it. Events are never re-routed when a target disappears; stable-home webhook deliveries remain queued as described below.

**If you want your own events, omit `--scoop` — never hardcode `cone`.** All three commands behave identically here, so omitting the flag is always available, and it works the same whether you are a cone or a scoop. The literal folder `cone` is not a synonym for "me": it belongs to whichever cone currently holds it, and it is handed to the next new cone after the original one is dropped. A skill that hardcodes it delivers its callbacks into another cone's chat in exactly the multi-cone workspaces where the target matters.

A stable `/wh/` webhook's `202` means **durably accepted**, not that agent work finished.
The home queues before forwarding, including while no leader is connected. It replays FIFO,
removing an event only after explicit delivery/filter acknowledgement or registration
revocation. Delivery is at-least-once: make downstream side effects safe to retry.
A missing registration or unresolved target blocks the head and all later events until
you repair the registration/target or revoke that registration with `webhook delete`.
Accepted events are never evicted or aged out. Limits are 100 events, 120 KiB encoded
home storage, 64 KiB per body and eight pending home requests. `429 WEBHOOK_QUEUE_FULL`
or `WEBHOOK_HOME_BUSY` means retry after 30 seconds; `413` means reduce the body.
Blocked replay retries by durable alarm after 30 seconds; successful replay continues
backlog after one second. Home admission expires after 90 days without rebind, not an
event-retention TTL.

Stable URLs survive tray resets without redirects. Local-only/legacy delivery is not
this durable queue: it can report `404 WEBHOOK_NOT_REGISTERED`,
`422 WEBHOOK_TARGET_UNRESOLVED` or `410 NO_LIVE_LEADER` directly. Old tray-scoped
URLs may return `308 TRAY_SUPERSEDED` plus `Location`; configure senders to follow
POST redirects if still using them. Retry transient failures, not permanent revocation.

The stable URL's `coneId` is the **leader-session lineage**, shared by its WorkUnits,
not a per-agent cone security boundary. Tray reset preserves this identity and its
private management credentials across failed attempts and reloads. A reset that cannot
complete required transfer work fails rather than silently replacing a stable URL;
retry it to resume the same replacement. Management credentials are never available
through the agent filesystem, public tray status, or followers.

## `webhook`

Receive HTTP callbacks. The lick carries the request method, path, headers, and body; `create` allocates a path and prints the URL.

```bash
webhook create --scoop pr-watcher --name gh-prs
webhook create --scoop Research --name inbox   # a cone, by name
webhook create --name inbox                    # your own cone
webhook list && webhook delete wh-1
```

If a delivery URL leaks, run `webhook rotate` on the connected leader, then
`webhook list` and update every external sender. Rotation replaces the delivery
secret for **all** webhooks, not an individual ID; the cone identity, webhook
registrations, and queued events stay intact. Old URLs stop authenticating.
The command prints no capability. A failed/lost response can be retried safely;
`webhook rotate --help` never rotates. This needs a stable tray home and the
leader panel RPC (standalone or hosted extension leader), not a local-only URL.

`webhook delete <id>` permanently revokes that stable-home registration before
removing its local definition. Valid-secret deliveries then return permanent
`410 WEBHOOK_REVOKED`; queued events for that ID are discarded, never replayed.
If revocation fails, the definition stays intact: reconnect the leader and retry
the same delete. Local-only and legacy registrations retain local deletion.
`webhook delete <id> --help` has no side effects.

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
- Don't leave watchers/webhooks/crons orphaned. Stable-home webhooks with missing targets block replay; repair them or use `... list` and `... delete` to clean up. Other trigger licks are dropped, never re-routed.
- Don't register against a scoop you have not created yet. `--scoop` is resolved when you create the entry, so a forward reference exits 1; run `scoop_scoop create <name>` first.
- Don't fan one trigger out to N near-identical entries. Register once, let the receiver dispatch.
