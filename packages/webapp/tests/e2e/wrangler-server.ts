/**
 * Supervisor for the E2E leader origin (`wrangler dev` → workerd).
 *
 * Playwright's `webServer` spawns a command once and never revives it. workerd
 * dies mid-suite often enough to matter (#2372: four sightings in three days —
 * `kj::getCaughtExceptionAsKj … Broken pipe` under parallel contexts + tray
 * websockets), and when it does, every remaining spec fails in ~200 ms with
 * `ERR_CONNECTION_REFUSED`: an 18-casualty pile-up that reads as unrelated test
 * failures and evicts the PR from the merge queue.
 *
 * So the `webServer` entry starts this supervisor instead of wrangler directly.
 * It:
 *   - spawns `npx wrangler <argv after -->` and re-spawns it if it exits
 *     without being asked to,
 *   - exposes a tiny control plane on {@link supervisorPort} that the
 *     `leaderAlive` fixture uses to force a restart and wait for readiness
 *     (`POST /restart`, `GET /health`),
 *   - records every crash — exit code, signal, and the tail of workerd's own
 *     output — into `crash-report.md` inside the wrangler log directory, which
 *     CI uploads as an artifact.
 *
 * Usage (see `playwright.config.ts`):
 *   npx tsx wrangler-server.ts -- dev --config <path> --port <n> ...
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';

/** Wrangler argv: everything after the `--` separator. */
const wranglerArgs = process.argv.slice(2).filter((arg) => arg !== '--');

function envPort(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : fallback;
}

/** Port wrangler serves the leader origin on — probed for readiness. */
const leaderPort = envPort('SLICC_E2E_WRANGLER_PORT', 8787);
/** Control-plane port. Defaults to `leaderPort + 1`, so an isolated
 *  `SLICC_E2E_WRANGLER_PORT` moves the supervisor with it. */
const supervisorPort = envPort('SLICC_E2E_WRANGLER_SUPERVISOR_PORT', leaderPort + 1);
const statusUrl = `http://127.0.0.1:${leaderPort}/status`;

/** Directory wrangler writes `wrangler-<ts>.log` into (`WRANGLER_LOG_PATH`),
 *  and where this supervisor appends its crash report next to them. */
const logDir = process.env['WRANGLER_LOG_PATH'] ?? resolve(process.cwd(), '.wrangler/e2e-logs');
const crashReportPath = resolve(logDir, 'crash-report.md');
/** Durable copy of everything wrangler prints. cloudflare/workers-sdk#15202:
 *  when `wrangler dev`'s stdout is a pipe whose consumer stops draining or
 *  closes it, workerd dies mid-run with
 *  `kj/async-io-unix.c++: … write(): Broken pipe` — the exact signature in
 *  #2372. Playwright's `webServer` capture is such a pipe, so this supervisor
 *  owns wrangler's output instead: it always drains it and mirrors it to a file
 *  that outlives the process.
 *
 *  This is also the evidence trail — CI uploads this directory. */
const outputLogPath = resolve(logDir, 'wrangler-output.log');
/** Process groups this supervisor owns, recorded on disk so a run that is
 *  SIGKILLed (Playwright's default `webServer` shutdown) cannot leak a workerd
 *  that then squats the leader port. Keyed by leader port so two harnesses on
 *  isolated `SLICC_E2E_*` ports never reap each other. */
const groupFilePath = resolve(logDir, `wrangler-groups-${leaderPort}.pid`);

/** Keep the tail of workerd's output so a crash report carries the lines that
 *  preceded it — wrangler's own log file is the full record, this is the part
 *  that fits in a CI job log. */
const OUTPUT_TAIL_LINES = 60;
const outputTail: string[] = [];

let child: ChildProcess | null = null;
/** PIDs of every wrangler chain this supervisor has started. Each is a process
 *  group leader (see `detached` in {@link spawnWrangler}); a crashed shim can
 *  leave workerd alive in that group still holding the listen socket, so the
 *  next spawn must reap the group, not just the process it saw exit. */
const spawnedGroups = new Set<number>();
let shuttingDown = false;
/** Set while a restart is in flight so concurrent `POST /restart` calls (and a
 *  crash landing mid-restart) join the same attempt instead of racing. */
let restartInFlight: Promise<void> | null = null;
let restarts = 0;
let lastCrash: string | null = null;

/** SIGKILL any process group left behind by a previous run of this harness. */
function reapStaleGroups(): void {
  let recorded: string;
  try {
    recorded = readFileSync(groupFilePath, 'utf8');
  } catch {
    return;
  }
  for (const line of recorded.split('\n')) {
    const pid = Number.parseInt(line, 10);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    try {
      process.kill(-pid, 'SIGKILL');
      process.stderr.write(`[e2e-wrangler] reaped stale wrangler process group ${pid}\n`);
    } catch {
      /* already gone — the common case */
    }
  }
  try {
    writeFileSync(groupFilePath, '');
  } catch {
    /* best effort */
  }
}

function recordGroup(pid: number): void {
  try {
    appendFileSync(groupFilePath, `${pid}\n`);
  } catch {
    /* best effort */
  }
}

let outputLog: ReturnType<typeof createWriteStream> | null = null;

function log(message: string): void {
  // stderr: Playwright forwards a webServer's stderr to the run log, while its
  // stdout is suppressed unless `stdout: 'pipe'` is set (which would drown the
  // log in `WRANGLER_LOG=debug` request noise).
  process.stderr.write(`[e2e-wrangler] ${message}\n`);
}

function recordTail(chunk: Buffer): void {
  outputLog?.write(chunk);
  for (const line of chunk.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    outputTail.push(line);
    if (outputTail.length > OUTPUT_TAIL_LINES) outputTail.shift();
  }
}

function writeCrashReport(reason: string): void {
  const report = [
    `## workerd exit #${restarts + 1} (${reason})`,
    '',
    'Last lines of wrangler/workerd output before the exit:',
    '',
    '```',
    ...outputTail,
    '```',
    '',
  ].join('\n');
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(crashReportPath, `${report}\n`);
  } catch (error) {
    log(`could not write crash report: ${String(error)}`);
  }
  log(`workerd exited unexpectedly (${reason}); crash report → ${crashReportPath}`);
  for (const line of outputTail.slice(-20)) log(`  | ${line}`);
}

function spawnWrangler(): ChildProcess {
  // `detached` puts wrangler in its own process group. wrangler is a chain of
  // shims (`npx` → `.bin/wrangler` → `wrangler-dist/cli.js` → workerd), and
  // signalling only the direct child orphans the rest — which then keeps the
  // listen socket and makes the replacement fail with EADDRINUSE. Killing the
  // group takes the whole chain down.
  const proc = spawn('npx', ['wrangler', ...wranglerArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, WRANGLER_LOG_PATH: logDir },
  });
  if (proc.pid !== undefined) {
    spawnedGroups.add(proc.pid);
    recordGroup(proc.pid);
  }
  proc.stdout?.on('data', recordTail);
  proc.stderr?.on('data', (chunk: Buffer) => {
    recordTail(chunk);
    process.stderr.write(chunk);
  });
  proc.once('exit', (code, signal) => {
    if (proc !== child || shuttingDown) return;
    child = null;
    writeCrashReport(`code=${String(code)} signal=${String(signal)}`);
    lastCrash = `code=${String(code)} signal=${String(signal)}`;
    // Bring it back immediately: by the time the next spec's health check
    // runs, the origin may already be warm again.
    void restart('crash');
  });
  return proc;
}

async function isLeaderUp(): Promise<boolean> {
  try {
    const response = await fetch(statusUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
      headers: { 'cache-control': 'no-store' },
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Poll `/status` until the worker answers 200 — workerd binds its listen
 *  socket well before the worker module finishes loading, so a TCP probe would
 *  return "ready" during a window where navigations still fail. */
async function waitForLeader(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isLeaderUp()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Signal every wrangler process group this supervisor started. Groups whose
 *  members are all gone raise ESRCH, which is the success case. */
function signalSpawnedGroups(signal: NodeJS.Signals): void {
  for (const pid of spawnedGroups) {
    try {
      process.kill(-pid, signal);
    } catch {
      /* group already reaped */
    }
  }
}

/** Tear the current chain down — including a workerd orphaned by a shim that
 *  died on its own, which would otherwise win the listen socket back from its
 *  own replacement (`EADDRINUSE`, then a crash loop). */
async function killChain(): Promise<void> {
  child = null;
  signalSpawnedGroups('SIGTERM');
  await new Promise((r) => setTimeout(r, 1_000));
  signalSpawnedGroups('SIGKILL');
  spawnedGroups.clear();
  try {
    writeFileSync(groupFilePath, '');
  } catch {
    /* best effort */
  }
}

async function restart(reason: string): Promise<void> {
  if (restartInFlight !== null) return restartInFlight;
  restartInFlight = (async () => {
    restarts += 1;
    log(`restarting wrangler (reason=${reason}, restart #${restarts})`);
    await killChain();
    // Give the OS a moment to release the listen socket; workerd otherwise
    // loses the EADDRINUSE race with its own replacement.
    await new Promise((r) => setTimeout(r, 1_000));
    child = spawnWrangler();
    const ready = await waitForLeader(120_000);
    log(ready ? `wrangler ready again after restart #${restarts}` : 'wrangler did NOT come back');
  })().finally(() => {
    restartInFlight = null;
  });
  return restartInFlight;
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(payload);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/health') {
    respond(res, 200, {
      running: child !== null && child.exitCode === null,
      restarts,
      lastCrash,
      logDir,
    });
    return;
  }
  if (path === '/restart' && req.method === 'POST') {
    await restart('requested');
    const alive = await isLeaderUp();
    respond(res, alive ? 200 : 503, { ok: alive, restarts, lastCrash, logDir });
    return;
  }
  respond(res, 404, { error: 'not found' });
}

const control = createServer((req, res) => {
  void handle(req, res).catch((error: unknown) => {
    respond(res, 500, { error: String(error) });
  });
});
control.listen(supervisorPort, '127.0.0.1', () => {
  log(`supervisor control plane on 127.0.0.1:${supervisorPort} (logs → ${logDir})`);
});

mkdirSync(logDir, { recursive: true });
outputLog = createWriteStream(outputLogPath, { flags: 'a' });
// A supervisor killed by its own logging would defeat the point: swallow EPIPE
// on the (Playwright-owned) stderr pipe rather than dying with it.
process.stderr.on('error', () => {});
outputLog.on('error', () => {});
reapStaleGroups();
child = spawnWrangler();

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  child = null;
  signalSpawnedGroups('SIGTERM');
  control.close();
  // Escalate quickly: the `gracefulShutdown` budget Playwright grants this
  // supervisor is short, and anything still alive when it expires becomes a
  // port-squatting orphan.
  setTimeout(() => {
    signalSpawnedGroups('SIGKILL');
    process.exit(0);
  }, 500).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
// Best effort for the paths that skip `shutdown` (an uncaught throw, or a
// SIGKILL of the supervisor itself): a detached wrangler survives its parent,
// and a leaked workerd holds the port against the next run.
process.once('exit', () => {
  signalSpawnedGroups('SIGKILL');
  // Drop the ownership record so the next run does not signal a group whose
  // pid the OS may since have recycled.
  try {
    writeFileSync(groupFilePath, '');
  } catch {
    /* best effort */
  }
});
