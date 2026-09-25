/**
 * Runner-side I/O shared by the orchestrator scripts: action inputs, the
 * `$GITHUB_OUTPUT` / `$GITHUB_ENV` / `$GITHUB_PATH` files, workflow
 * annotations, the per-job state file, and process liveness. Nothing here is
 * pure — the pure half lives in `lib.mjs`.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONE_CONFIG_PATH, formatGithubOutput, JOIN_FILE_PATH, tailLines } from './lib.mjs';

/**
 * True when `metaUrl` (a script's `import.meta.url`) is the entry point of
 * this process. Every orchestrator script exports its `main` and only runs
 * it behind this guard, so tests can import the module without side effects.
 */
export function isMain(metaUrl) {
  const entry = process.argv[1];
  return Boolean(entry) && metaUrl === pathToFileURL(entry).href;
}

/** `/tmp/slicc-join.json` unless overridden (test seam — node-server itself always writes the default). */
export function joinFilePath() {
  return process.env.SLICC_GW_JOIN_FILE?.trim() || JOIN_FILE_PATH;
}

/** `/slicc/cone-config.json` unless overridden (test seam — node-server itself always reads the default). */
export function coneConfigPath() {
  return process.env.SLICC_GW_CONE_CONFIG_PATH?.trim() || CONE_CONFIG_PATH;
}

/**
 * Read a composite-action input. Composite actions do not populate `INPUT_*`
 * themselves, so every `action.yml` maps `inputs.<name>` to
 * `INPUT_<NAME>` explicitly in the step's `env`.
 *
 * @param {string} name kebab-case input name
 * @param {{ required?: boolean; fallback?: string; raw?: boolean }} options
 * @returns {string}
 */
export function input(name, options = {}) {
  const key = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
  const value = process.env[key] ?? '';
  const text = options.raw ? value : value.trim();
  if (!text && options.required) throw new Error(`input "${name}" is required`);
  return text || (options.fallback ?? '');
}

/** Per-job scratch root: state file, install dirs, logs, profile. */
export function homeDir() {
  return process.env.SLICC_GW_HOME || join(process.env.RUNNER_TEMP || tmpdir(), 'slicc-gw');
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

function appendCommandFile(envName, line) {
  const file = process.env[envName];
  if (file) appendFileSync(file, line);
  else process.stdout.write(`[${envName}] ${line}`);
}

export function setOutput(name, value) {
  appendCommandFile('GITHUB_OUTPUT', formatGithubOutput(name, value));
}

export function exportEnv(name, value) {
  appendCommandFile('GITHUB_ENV', formatGithubOutput(name, value));
}

export function addPath(dir) {
  appendCommandFile('GITHUB_PATH', `${dir}\n`);
}

/** Register a value as a secret so the runner redacts it from every log line. */
export function addMask(value) {
  if (value) console.log(`::add-mask::${value}`);
}

export function notice(message) {
  console.log(`::notice::${message}`);
}

export function warning(message) {
  console.log(`::warning::${message}`);
}

export function group(title, body) {
  console.log(`::group::${title}`);
  console.log(body);
  console.log('::endgroup::');
}

/** Print an error annotation and exit non-zero. */
export function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

export function statePath(home = homeDir()) {
  return join(home, 'state.json');
}

/** @returns {Record<string, any> | null} */
export function readState(home = homeDir()) {
  const path = statePath(home);
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let state;
  try {
    state = JSON.parse(contents);
  } catch (error) {
    throw new Error(`invalid runner state at ${path}: ${error.message}`, { cause: error });
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error(`invalid runner state at ${path}: expected a JSON object`);
  }
  return state;
}

export function writeState(state, home = homeDir()) {
  ensureDir(home);
  const temporaryPath = join(home, `.state-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporaryPath, statePath(home));
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function isAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function logTail(path, n = 60) {
  if (!path || !existsSync(path)) return '';
  return tailLines(readFileSync(path, 'utf8'), n);
}

/** Wait until `pid` is gone or `timeoutMs` elapses; resolves to whether it exited. */
export async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(250);
  }
  return !isAlive(pid);
}

/** SIGTERM, then SIGKILL after `graceMs`. Never throws. */
export async function terminate(pid, graceMs = 15_000) {
  if (!isAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  if (await waitForExit(pid, graceMs)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
  await waitForExit(pid, 2_000);
}

/**
 * Absolute path of the Go follower CLI. `install-cli.mjs` exports `SLICC_CLI`
 * so later steps never depend on PATH order (the npm `sliccy` package also
 * installs a `slicc` bin — that one is node-server, not the follower).
 */
export function cliPath() {
  return process.env.SLICC_CLI?.trim() || 'slicc';
}

/** The join URL every CLI-wrapping action needs; never logged. */
export function joinUrl() {
  const url = (process.env.SLICC_JOIN_URL ?? '').trim();
  if (!url) throw new Error('SLICC_JOIN_URL is required (pass the `join-url` input)');
  if (!/^https?:\/\//.test(url)) throw new Error('join-url must be an https://…/join/<token> link');
  addMask(url);
  return url;
}

/**
 * The Go CLI reports a failed WebRTC dial before anything reaches the leader.
 * Those failures are safe to retry — nothing was executed — and they do
 * happen on a busy runner when execs are issued back to back.
 */
export const CONNECT_FAILURE_RE = /tray connect timed out|tray attach|signaling|dial/i;
export const CONNECT_RETRIES = 3;
export const CONNECT_RETRY_DELAY_MS = 3_000;

export function isConnectFailure(status, stderr) {
  return status !== 0 && CONNECT_FAILURE_RE.test(stderr ?? '');
}

/**
 * Run one command in the leader's virtual shell synchronously and return its
 * stdout bytes. stderr is forwarded to the job log; a non-zero status throws.
 * A dial failure is retried up to `CONNECT_RETRIES` times. Used by the
 * byte-exact copy paths (`vfs-file.mjs`, `inject-files.mjs`,
 * `export-session.mjs`) — the streaming `prompt`/`exec` path is `slicc-run.mjs`.
 *
 * @param {string} url
 * @param {string} command
 * @param {{ stdin?: string | Buffer; timeoutMs: number; retries?: number; retryDelayMs?: number }} options
 * @returns {Buffer}
 */
export function execOnLeader(url, command, options) {
  const retries = options.retries ?? CONNECT_RETRIES;
  const delay = options.retryDelayMs ?? CONNECT_RETRY_DELAY_MS;
  for (let attempt = 1; ; attempt += 1) {
    const result = spawnSync(cliPath(), [url, 'exec', command], {
      input: options.stdin,
      maxBuffer: 512 * 1024 * 1024,
      timeout: options.timeoutMs,
      env: { ...process.env, SLICC_NO_TUI: '1', NO_COLOR: '1' },
    });
    if (result.error) throw result.error;
    const stderr = result.stderr?.toString('utf8') ?? '';
    if (stderr.trim()) process.stderr.write(stderr);
    if (result.status === 0) return result.stdout ?? Buffer.alloc(0);
    if (isConnectFailure(result.status, stderr) && attempt < retries) {
      warning(`leader dial failed (attempt ${attempt}/${retries}); retrying in ${delay / 1000}s`);
      sleepSync(delay);
      continue;
    }
    throw new Error(`leader command failed (status ${result.status}): ${command}`);
  }
}

/** Blocking sleep for the synchronous exec path. */
export function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
