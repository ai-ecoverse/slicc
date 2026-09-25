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

export function isMain(metaUrl) {
  const entry = process.argv[1];
  return Boolean(entry) && metaUrl === pathToFileURL(entry).href;
}

export function joinFilePath() {
  return process.env.SLICC_GW_JOIN_FILE?.trim() || JOIN_FILE_PATH;
}

export function coneConfigPath() {
  return process.env.SLICC_GW_CONE_CONFIG_PATH?.trim() || CONE_CONFIG_PATH;
}

export function input(name, options = {}) {
  const key = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
  const value = process.env[key] ?? '';
  const text = options.raw ? value : value.trim();
  if (!text && options.required) throw new Error(`input "${name}" is required`);
  return text || (options.fallback ?? '');
}

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

export function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

export function statePath(home = homeDir()) {
  return join(home, 'state.json');
}

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

export async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(250);
  }
  return !isAlive(pid);
}

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
  } catch {}
  await waitForExit(pid, 2_000);
}

export function cliPath() {
  return process.env.SLICC_CLI?.trim() || 'slicc';
}

export function joinUrl() {
  const url = (process.env.SLICC_JOIN_URL ?? '').trim();
  if (!url) throw new Error('SLICC_JOIN_URL is required (pass the `join-url` input)');
  if (!/^https?:\/\//.test(url)) throw new Error('join-url must be an https://…/join/<token> link');
  addMask(url);
  return url;
}

export const CONNECT_FAILURE_RE = /tray connect timed out|tray attach|signaling|dial/i;
export const CONNECT_RETRIES = 3;
export const CONNECT_RETRY_DELAY_MS = 3_000;

export function isConnectFailure(status, stderr) {
  return status !== 0 && CONNECT_FAILURE_RE.test(stderr ?? '');
}

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

export function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
