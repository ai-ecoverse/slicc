#!/usr/bin/env node
/**
 * Start a SLICC hosted leader on this runner and wait for its join URL.
 *
 * Runs `node-server --hosted` (the same mode the e2b cloud template boots)
 * with headless Chrome against the hosted UI origin, seeds credentials the
 * way cloud-core does — `/slicc/cone-config.json` for provider accounts and
 * `secrets.env` for domain-scoped secrets — and polls `/tmp/slicc-join.json`
 * until the leader has minted a tray. Records pid, log, and deadline in the
 * job state file for `wait-for-deadline.mjs` / `stop-leader.mjs`.
 *
 * Inputs (env, mapped from action.yml): INPUT_SLICC_VERSION, INPUT_NODE_SERVER,
 * INPUT_PORT, INPUT_DURATION, INPUT_MOUNTS, INPUT_CONE_CONFIG,
 * INPUT_SECRETS_ENV, INPUT_MODEL, INPUT_EFFORT_LEVEL, INPUT_UI_ORIGIN,
 * INPUT_TRAY_WORKER_BASE_URL, INPUT_BOOT_TIMEOUT, INPUT_MASK_JOIN_URL,
 * INPUT_CDP_LAUNCH_TIMEOUT.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  addMask,
  ensureDir,
  fail,
  group,
  homeDir,
  input,
  logTail,
  notice,
  setOutput,
  sleep,
  terminate,
  writeState,
} from './gh-io.mjs';
import {
  buildConeConfigFiles,
  buildLeaderArgs,
  buildLeaderEnv,
  CONE_CONFIG_PATH,
  JOIN_FILE_PATH,
  parseBoolean,
  parseDuration,
  parseJoinFile,
  parseMountLines,
  parsePort,
} from './lib.mjs';

/** Install the published `sliccy` package (node-server) into a private prefix. */
function installNodeServer(home, version) {
  const prefix = join(home, 'leader');
  ensureDir(prefix);
  const spec = `sliccy@${version || 'latest'}`;
  console.log(`[start-leader] installing ${spec} into ${prefix}`);
  execFileSync(
    'npm',
    [
      'install',
      '--prefix',
      prefix,
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--omit=dev',
      spec,
    ],
    { stdio: 'inherit' }
  );
  const entry = join(prefix, 'node_modules', 'sliccy', 'dist', 'node-server', 'index.js');
  if (!existsSync(entry)) throw new Error(`installed ${spec} but ${entry} is missing`);
  return entry;
}

function resolveNodeServer(home) {
  const explicit = input('node-server');
  if (explicit) {
    const entry = resolve(explicit);
    if (!existsSync(entry)) throw new Error(`node-server entry not found: ${entry}`);
    console.log(`[start-leader] using local node-server ${entry}`);
    return entry;
  }
  return installNodeServer(home, input('slicc-version', { fallback: 'latest' }));
}

function writeCredentialFiles(home) {
  const { coneConfigJson, secretsEnv, summary } = buildConeConfigFiles({
    coneConfigJson: input('cone-config', { raw: true }),
    secretsEnvText: input('secrets-env', { raw: true }),
    model: input('model'),
    effortLevel: input('effort-level'),
  });
  const secretsFile = join(home, 'secrets.env');
  writeFileSync(secretsFile, secretsEnv, { mode: 0o600 });
  if (coneConfigJson) {
    try {
      ensureDir(dirname(CONE_CONFIG_PATH));
      writeFileSync(CONE_CONFIG_PATH, coneConfigJson, { mode: 0o600 });
    } catch (err) {
      throw new Error(
        `cannot write ${CONE_CONFIG_PATH} (${err.code ?? err}); the start-leader action runs ` +
          '`sudo mkdir -p /slicc && sudo chown "$(id -u)" /slicc` first — is sudo available on this runner?'
      );
    }
  } else if (existsSync(CONE_CONFIG_PATH)) {
    rmSync(CONE_CONFIG_PATH, { force: true });
  }
  console.log(
    `[start-leader] credentials: model=${summary.model ?? '(default)'} effort=${summary.effortLevel ?? '(default)'} ` +
      `accounts=[${summary.accountProviderIds.join(', ')}] secrets=[${summary.secretNames.join(', ')}]`
  );
  return { secretsFile, summary };
}

async function pollJoinFile({ child, logPath, startedAt, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  while (Date.now() < deadline) {
    if (exited) {
      group('leader log (tail)', logTail(logPath, 80));
      throw new Error(
        `node-server exited before minting a join URL (code=${exited.code} signal=${exited.signal})`
      );
    }
    let text = null;
    try {
      text = readFileSync(JOIN_FILE_PATH, 'utf8');
    } catch {
      // not written yet
    }
    const parsed = parseJoinFile(text, startedAt);
    if (parsed) return parsed;
    await sleep(1000);
  }
  group('leader log (tail)', logTail(logPath, 80));
  await terminate(child.pid, 5_000);
  throw new Error(`leader did not report a join URL within ${Math.round(timeoutMs / 1000)}s`);
}

async function main() {
  const home = ensureDir(homeDir());
  const port = parsePort(input('port'));
  const durationMs = parseDuration(input('duration', { fallback: '30m' }));
  const bootTimeoutMs = parseDuration(input('boot-timeout', { fallback: '180s' }));
  const cdpLaunchTimeoutMs = parseDuration(input('cdp-launch-timeout', { fallback: '60s' }));
  const maskJoinUrl = parseBoolean(input('mask-join-url'), true);
  const mounts = parseMountLines(input('mounts', { raw: true }), homedir());

  const entry = resolveNodeServer(home);
  const { secretsFile } = writeCredentialFiles(home);
  const profileDir = ensureDir(join(home, 'profile'));
  const logPath = join(home, 'leader.log');
  rmSync(JOIN_FILE_PATH, { force: true });

  const env = buildLeaderEnv({
    base: process.env,
    port,
    secretsFile,
    profileDir,
    uiOrigin: input('ui-origin'),
    trayWorkerBaseUrl: input('tray-worker-base-url'),
    cdpLaunchTimeoutMs,
  });
  const args = [entry, ...buildLeaderArgs({ mounts })];
  for (const m of mounts) console.log(`[start-leader] mount ${m.hostPath} → ${m.path}`);

  const logFd = openSync(logPath, 'a');
  const startedAt = Date.now();
  const child = spawn(process.execPath, args, {
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  console.log(`[start-leader] node-server pid=${child.pid} port=${port} log=${logPath}`);

  const joinInfo = await pollJoinFile({
    child,
    logPath,
    startedAt: startedAt - 1000,
    timeoutMs: bootTimeoutMs,
  });
  if (maskJoinUrl) addMask(joinInfo.joinUrl);

  const deadline = startedAt + durationMs;
  writeState(
    {
      leader: child.pid,
      entry,
      port,
      logPath,
      profileDir,
      joinUrl: joinInfo.joinUrl,
      trayId: joinInfo.trayId,
      sliccVersion: joinInfo.sliccVersion,
      startedAt,
      deadline,
      followers: [],
      followerLogs: [],
    },
    home
  );

  setOutput('join-url', joinInfo.joinUrl);
  setOutput('tray-id', joinInfo.trayId ?? '');
  setOutput('slicc-version', joinInfo.sliccVersion ?? '');
  setOutput('pid', child.pid);
  setOutput('port', port);
  setOutput('log-path', logPath);
  setOutput('state-path', join(home, 'state.json'));
  setOutput('deadline', new Date(deadline).toISOString());
  notice(
    `SLICC leader ready (tray ${joinInfo.trayId ?? '?'}, version ${joinInfo.sliccVersion ?? '?'}); ` +
      `runs until ${new Date(deadline).toISOString()}`
  );
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
