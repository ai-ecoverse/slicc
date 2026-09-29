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

# Automation

Events become **licks** routed to a work unit.

| Command    | Trigger                  | Use case                                                           |
| ---------- | ------------------------ | ------------------------------------------------------------------ |
| `webhook`  | HTTP                     | External callbacks                                                 |
| `crontask` | Cron                     | Recurring work                                                     |
| `fswatch`  | VFS create/modify/delete | Content changes                                                    |
| `jshd`     | Long-running `.jsh`      | Daemons (not a lick producer except crash-loop). See `jshd` skill. |

All three take `--scoop <target>` — scoop name, cone name, or folder (`cone-<slug>`, `<name>-scoop`). Omit → events to current unit (cone or scoop). Unknown target **refused at create** (exit 1, lists valid targets). Events are never re-routed when a target disappears.

**Omit `--scoop` — never hardcode `cone`.** The folder `cone` is not "me"; it moves between cones. Hardcoding it delivers callbacks to the wrong cone in multi-cone workspaces.

Stable `/wh/` `202` = **durably accepted**, not agent work finished. Home queues before forwarding (including while no leader). FIFO per webhook ID; at-least-once — make side effects idempotent. Missing/unresolved target: 3 rejections ≥30s apart → terminal dead letter; repair during grace to deliver normally. Operator archive keeps latest 100 terminal receipts. Queue limits: 100 events, 120 KiB storage, 64 KiB/body, 8 pending. `429 WEBHOOK_QUEUE_FULL` / `WEBHOOK_HOME_BUSY` → retry after 30s; `413` → shrink body. Home admission expires after 90 days without rebind.

Local-only/legacy: may return `404 WEBHOOK_NOT_REGISTERED`, `422 WEBHOOK_TARGET_UNRESOLVED`, `410 NO_LIVE_LEADER`. Old tray URLs may `308 TRAY_SUPERSEDED` + `Location`. Stable URL `coneId` is leader-session lineage, not a per-agent security boundary.

## `webhook`

```bash
webhook create --scoop pr-watcher --name gh-prs
webhook create --scoop Research --name inbox
webhook create --name inbox
webhook list && webhook delete wh-1
```

If a delivery URL leaks: `webhook rotate` on the connected leader, then `webhook list` and update senders. Rotation randomizes delivery + management secrets for **all** webhooks (not per ID); registrations and queued events stay. Old URLs stop authenticating. Prints no capability; transient failure preserves idempotent retry. `webhook rotate --help` never rotates. Needs stable tray + leader panel RPC.

`webhook delete <id>` revokes stable-home registration (`410 WEBHOOK_REVOKED`); queued events discarded, never replayed. If revocation fails, definition stays — reconnect and retry. `webhook delete <id> --help` has no side effects.

Flags: `--scoop <target>`, `--name <label>`, `--filter <js>` (falsy drops event).

## `crontask`

5-field cron.

```bash
crontask create --cron "0 * * * *" --scoop hourly-summary --name hourly
crontask create --cron "0 9 * * *" --name digest
crontask list && crontask delete ct-1   # `kill` alias
```

Flags: `--cron <expr>` (required), `--scoop <target>`, `--name <label>`, `--filter <js>`.

## `fswatch`

```bash
fswatch create --path /workspace --pattern "*.md" --scoop doc-watcher --name md-changes
fswatch create --path /workspace/src --pattern "*.ts"
fswatch list && fswatch delete fsw-1
```

Events: `create` / `modify` / `delete` + path.

## Don't

- Poll on cron for reactive work — use `fswatch`/`webhook`.
- Leave orphans — repair or `... list` + `... delete`.
- Register before scoop exists — `scoop_scoop create <name>` first.
- Fan one trigger to N near-identical entries.
