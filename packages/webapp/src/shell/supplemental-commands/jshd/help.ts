export const JSHD_HELP = `usage: jshd <command> [options]

Durable background jsh units: one realm worker each, restored on reload
when --enable is set. Keep-alive follows the realm (pending timers and
host-event subscriptions keep the unit up; a script that returns with
nothing pending exits and is subject to the restart policy).

Commands:
  start [-n <name>] [--enable] [--restart always|on-failure|no]
        [--cwd <dir>] [--env K=V] <script.jsh | skill-command> [args...]
                          Run a unit in the background (prints pid)
  ls [--json]             List units (name, pid, state, restarts, uptime, enabled)
  status <name>           Show one unit
  stop <name>             Stop a unit (does not restart)
  restart <name>          Stop then start a unit
  rm <name>               Stop and delete the unit record and its log
  logs <name> [-f] [-n <lines>]
                          Print the unit log (follow, last N lines)
  enable <name>           Start this unit again after a reload
  disable <name>          Do not restore this unit on reload (leave it running)

Notes:
  - Records live in /workspace/.jshd/<name>.json; logs in /workspace/.jshd/log/<name>.log.
  - ps lists the unit as kind jsh; kill <pid> stops it and does not restart.
  - Only the restart policy restarts. A crash-loop cap marks the unit errored
    and reports through a lick.
  - Where DedicatedWorker is unavailable (thin extension sandbox iframes)
    start still runs as best effort; ls says the unit is not durable there.
`;
