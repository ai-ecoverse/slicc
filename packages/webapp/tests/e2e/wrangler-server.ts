import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';

const wranglerArgs = process.argv.slice(2).filter((arg) => arg !== '--');

function envPort(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : fallback;
}

const leaderPort = envPort('SLICC_E2E_WRANGLER_PORT', 8787);

const supervisorPort = envPort('SLICC_E2E_WRANGLER_SUPERVISOR_PORT', leaderPort + 1);
const statusUrl = `http://127.0.0.1:${leaderPort}/status`;

const logDir = process.env['WRANGLER_LOG_PATH'] ?? resolve(process.cwd(), '.wrangler/e2e-logs');
const crashReportPath = resolve(logDir, 'crash-report.md');

const outputLogPath = resolve(logDir, 'wrangler-output.log');

const groupFilePath = resolve(logDir, `wrangler-groups-${leaderPort}.pid`);

const OUTPUT_TAIL_LINES = 60;
const outputTail: string[] = [];

let child: ChildProcess | null = null;

const spawnedGroups = new Set<number>();
let shuttingDown = false;

let restartInFlight: Promise<void> | null = null;
let restarts = 0;
let lastCrash: string | null = null;

let failedRestarts = 0;

let permanentFailure = false;

const MAX_FAILED_RESTARTS = 2;

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
    } catch {}
  }
  try {
    writeFileSync(groupFilePath, '');
  } catch {}
}

function recordGroup(pid: number): void {
  try {
    appendFileSync(groupFilePath, `${pid}\n`);
  } catch {}
}

let outputLog: ReturnType<typeof createWriteStream> | null = null;

function log(message: string): void {
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

async function waitForLeader(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isLeaderUp()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function signalSpawnedGroups(signal: NodeJS.Signals): void {
  for (const pid of spawnedGroups) {
    try {
      process.kill(-pid, signal);
    } catch {}
  }
}

async function killChain(): Promise<void> {
  child = null;
  signalSpawnedGroups('SIGTERM');
  await new Promise((r) => setTimeout(r, 1_000));
  signalSpawnedGroups('SIGKILL');
  spawnedGroups.clear();
  try {
    writeFileSync(groupFilePath, '');
  } catch {}
}

async function restart(reason: string): Promise<void> {
  if (restartInFlight !== null) return restartInFlight;
  restartInFlight = (async () => {
    restarts += 1;
    log(`restarting wrangler (reason=${reason}, restart #${restarts})`);
    await killChain();

    await new Promise((r) => setTimeout(r, 1_000));
    child = spawnWrangler();
    const ready = await waitForLeader(120_000);
    if (ready) {
      failedRestarts = 0;
      log(`wrangler ready again after restart #${restarts}`);
      return;
    }
    failedRestarts += 1;
    if (failedRestarts >= MAX_FAILED_RESTARTS) permanentFailure = true;
    log(
      `wrangler did NOT come back (failed restarts: ${failedRestarts}` +
        `${permanentFailure ? ', giving up — remaining specs abort immediately' : ''})`
    );
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
      failedRestarts,
      permanentFailure,
      lastCrash,
      logDir,
    });
    return;
  }
  if (path === '/restart' && req.method === 'POST') {
    if (permanentFailure) {
      respond(res, 503, { ok: false, permanentFailure, restarts, lastCrash, logDir });
      return;
    }
    await restart('requested');
    const alive = await isLeaderUp();
    respond(res, alive ? 200 : 503, { ok: alive, permanentFailure, restarts, lastCrash, logDir });
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

  setTimeout(() => {
    signalSpawnedGroups('SIGKILL');
    process.exit(0);
  }, 500).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

process.once('exit', () => {
  signalSpawnedGroups('SIGKILL');

  try {
    writeFileSync(groupFilePath, '');
  } catch {}
});
