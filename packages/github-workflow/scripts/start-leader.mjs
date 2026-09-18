#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  addMask,
  coneConfigPath,
  ensureDir,
  fail,
  group,
  homeDir,
  input,
  isMain,
  joinFilePath,
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
  parseBoolean,
  parseDuration,
  parseJoinFile,
  parseMountLines,
  parsePort,
} from './lib.mjs';

export function installNodeServer(home, version, exec = execFileSync) {
  const prefix = join(home, 'leader');
  ensureDir(prefix);
  const spec = `sliccy@${version || 'latest'}`;
  console.log(`[start-leader] installing ${spec} into ${prefix}`);
  exec(
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

export function resolveNodeServer(home, exec = execFileSync) {
  const explicit = input('node-server');
  if (explicit) {
    const entry = resolve(explicit);
    if (!existsSync(entry)) throw new Error(`node-server entry not found: ${entry}`);
    console.log(`[start-leader] using local node-server ${entry}`);
    return entry;
  }
  return installNodeServer(home, input('slicc-version', { fallback: 'latest' }), exec);
}

export function removeCredentialFiles(secretsFile) {
  rmSync(coneConfigPath(), { force: true });
  if (secretsFile) rmSync(secretsFile, { force: true });
}

export function writeCredentialFiles(home) {
  const { coneConfigJson, secretsEnv, summary } = buildConeConfigFiles({
    coneConfigJson: input('cone-config', { raw: true }),
    secretsEnvText: input('secrets-env', { raw: true }),
    model: input('model'),
    effortLevel: input('effort-level'),
    apiKeyAccount: {
      providerId: input('provider'),
      apiKey: input('provider-api-key'),
      baseUrl: input('provider-base-url'),
    },
  });
  const secretsFile = join(ensureDir(home), 'secrets.env');
  writeFileSync(secretsFile, secretsEnv, { mode: 0o600 });
  const target = coneConfigPath();
  if (coneConfigJson) {
    try {
      ensureDir(dirname(target));
      writeFileSync(target, coneConfigJson, { mode: 0o600 });
    } catch (err) {
      throw new Error(
        `cannot write ${target} (${err.code ?? err}); the start-leader action runs ` +
          '`sudo mkdir -p /slicc && sudo chown "$(id -u)" /slicc` first — is sudo available on this runner?'
      );
    }
  } else {
    rmSync(target, { force: true });
  }
  console.log(
    `[start-leader] credentials: model=${summary.model ?? '(default)'} effort=${summary.effortLevel ?? '(default)'} ` +
      `accounts=[${summary.accountProviderIds.join(', ')}] secrets=[${summary.secretNames.join(', ')}]`
  );
  return { secretsFile, coneConfigWritten: Boolean(coneConfigJson), summary };
}

export async function pollJoinFile({ child, logPath, startedAt, timeoutMs, pollMs = 1000 }) {
  const deadline = Date.now() + timeoutMs;
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  const file = joinFilePath();
  while (Date.now() < deadline) {
    if (exited) {
      group('leader log (tail)', logTail(logPath, 80));
      throw new Error(
        `node-server exited before minting a join URL (code=${exited.code} signal=${exited.signal})`
      );
    }
    let text = null;
    try {
      text = readFileSync(file, 'utf8');
    } catch {}
    const parsed = parseJoinFile(text, startedAt);
    if (parsed) return parsed;
    await sleep(pollMs);
  }
  group('leader log (tail)', logTail(logPath, 80));
  await terminate(child.pid, 5_000);
  throw new Error(`leader did not report a join URL within ${Math.round(timeoutMs / 1000)}s`);
}

export function readBootInputs() {
  return {
    port: parsePort(input('port')),
    durationMs: parseDuration(input('duration', { fallback: '30m' })),
    bootTimeoutMs: parseDuration(input('boot-timeout', { fallback: '180s' })),
    cdpLaunchTimeoutMs: parseDuration(input('cdp-launch-timeout', { fallback: '60s' })),
    maskJoinUrl: parseBoolean(input('mask-join-url'), true),
    mounts: parseMountLines(input('mounts', { raw: true }), homedir()),
  };
}

export async function bootLeader(opts) {
  const { home, entry, port, durationMs, bootTimeoutMs, cdpLaunchTimeoutMs, maskJoinUrl, mounts } =
    opts;
  const { secretsFile, coneConfigWritten } = writeCredentialFiles(home);
  const profileDir = ensureDir(join(home, 'profile'));
  const logPath = join(home, 'leader.log');
  rmSync(joinFilePath(), { force: true });

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
    pollMs: opts.pollMs,
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
      secretsFile,
      coneConfigPath: coneConfigWritten ? coneConfigPath() : null,
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
  return { pid: child.pid, ...joinInfo, deadline };
}

export async function main(options = {}) {
  const home = ensureDir(homeDir());
  const inputs = readBootInputs();
  const entry = resolveNodeServer(home, options.exec);
  const secretsFile = join(home, 'secrets.env');
  try {
    return await bootLeader({ home, entry, ...inputs, pollMs: options.pollMs });
  } catch (err) {
    removeCredentialFiles(secretsFile);
    throw err;
  }
}

/* v8 ignore start */
if (isMain(import.meta.url)) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
/* v8 ignore stop */
