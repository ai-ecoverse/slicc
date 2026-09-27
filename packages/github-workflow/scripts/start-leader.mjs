#!/usr/bin/env node
/**
 * Start a SLICC hosted leader on this runner and wait for its join URL.
 *
 * Runs `node-server --hosted` (the same mode the e2b cloud template boots)
 * with headless Chrome against the hosted UI origin, seeds credentials the
 * way cloud-core does — `/slicc/cone-config.json` for provider accounts and
 * `secrets.env` for domain-scoped secrets — and polls this leader's join file
 * (`$SLICC_GW_HOME/join.json`, or `SLICC_GW_JOIN_FILE`) until it has minted a
 * tray. node-server is told to write that same file via `SLICC_JOIN_FILE`.
 * Records pid, log, and deadline in the job state file for
 * `wait-for-deadline.mjs` / `stop-leader.mjs`.
 *
 * Inputs (env, mapped from action.yml): INPUT_SLICC_VERSION, INPUT_NODE_SERVER,
 * INPUT_PORT, INPUT_DURATION, INPUT_MOUNTS, INPUT_CONE_CONFIG,
 * INPUT_SECRETS_ENV, INPUT_MODEL, INPUT_EFFORT_LEVEL, INPUT_PROVIDER,
 * INPUT_PROVIDER_API_KEY, INPUT_PROVIDER_BASE_URL, INPUT_UI_ORIGIN,
 * INPUT_TRAY_WORKER_BASE_URL, INPUT_PIN_WEBAPP, INPUT_BOOT_TIMEOUT,
 * INPUT_MASK_JOIN_URL, INPUT_CDP_LAUNCH_TIMEOUT.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  PRODUCTION_TRAY_ORIGIN,
  parseBoolean,
  parseDuration,
  parseJoinFile,
  parseMountLines,
  parsePort,
  resolvePinnedWebapp,
} from './lib.mjs';

/** Install the published `sliccy` package (node-server) into a private prefix. */
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

/**
 * Remove the on-disk credential files. Called on a failed boot (before the
 * state file exists) and by `stop-leader.mjs` at teardown: on a persistent or
 * self-hosted runner, `/slicc/cone-config.json` would otherwise stay readable
 * by later jobs running as the same user. Also removes this leader's join
 * file: it holds the join URL.
 */
export function removeCredentialFiles(secretsFile, joinFile = joinFilePath()) {
  rmSync(coneConfigPath(), { force: true });
  if (secretsFile) rmSync(secretsFile, { force: true });
  if (joinFile) rmSync(joinFile, { force: true });
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

/**
 * Poll the join file until node-server has minted a tray. Fails fast if the
 * child exits first; kills it if the boot timeout elapses.
 */
export async function pollJoinFile({
  child,
  logPath,
  startedAt,
  timeoutMs,
  pollMs = 1000,
  file = joinFilePath(),
}) {
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
      text = readFileSync(file, 'utf8');
    } catch {
      // not written yet
    }
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
    pinWebapp: parseBoolean(input('pin-webapp'), false),
    mounts: parseMountLines(input('mounts', { raw: true }), homedir()),
  };
}

/**
 * Poll until the process we spawned answers `/__slicc_pin` with its token.
 * A 200 from some other listener, including an orphan of an earlier boot,
 * does not count. `exited()` is checked every pass so a child that died
 * with EADDRINUSE fails the boot instead of being mistaken for that orphan.
 */
export async function waitForWebapp(
  port,
  { timeoutMs = 15_000, fetchImpl = globalThis.fetch, token, exited } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    const code = exited?.();
    if (code != null) {
      throw new Error(`pinned webapp exited before it was ready (${code})`);
    }
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/__slicc_pin`, {
        signal: AbortSignal.timeout(1000),
      });
      const body = res.ok ? (await res.text()).trim() : '';
      if (res.ok && (!token || body === token)) return;
      last = res.ok ? 'listener is not the pinned webapp we started' : `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(100);
  }
  throw new Error(`pinned webapp on port ${port} did not claim the port (${last})`);
}

/**
 * Start `serve-webapp.mjs` detached so it outlives this process. A bench
 * restart calls start-leader again; stop-leader kills the pid in the state file.
 */
export async function launchPinnedWebapp({
  root,
  port,
  logPath,
  upstream = PRODUCTION_TRAY_ORIGIN,
  spawnImpl = spawn,
  waitImpl = waitForWebapp,
}) {
  const index = join(root, 'index.html');
  if (!existsSync(index)) {
    throw new Error(
      `pin-webapp: ${index} is missing. The published sliccy package ships dist/ui next to dist/node-server.`
    );
  }
  const script = fileURLToPath(new URL('./serve-webapp.mjs', import.meta.url));
  const token = randomBytes(16).toString('hex');
  const logFd = openSync(logPath, 'a');
  const child = spawnImpl(
    process.execPath,
    [script, '--root', root, '--port', String(port), '--upstream', upstream, '--identity', token],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    }
  );
  let exitCode = null;
  child.on?.('exit', (code, signal) => {
    exitCode = code ?? signal ?? 'exit';
  });
  child.unref?.();
  try {
    await waitImpl(port, { token, exited: () => exitCode });
  } catch (err) {
    if (child.pid) await terminate(child.pid, 2_000);
    const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-500) : '';
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(tail ? `${message}\n${tail}` : message);
  }
  console.log(`[start-leader] pinned webapp pid=${child.pid} http://localhost:${port}`);
  return { pid: child.pid, logPath };
}

export async function bootLeader(opts) {
  const {
    home,
    entry,
    port,
    durationMs,
    bootTimeoutMs,
    cdpLaunchTimeoutMs,
    maskJoinUrl,
    mounts,
    uiOrigin,
    trayWorkerBaseUrl,
    bridgeDevAllowedOrigins,
    uiServer,
  } = opts;
  const { secretsFile, coneConfigWritten } = writeCredentialFiles(home);
  const profileDir = ensureDir(join(home, 'profile'));
  const logPath = join(home, 'leader.log');
  const file = joinFilePath(home);
  rmSync(file, { force: true });

  const env = buildLeaderEnv({
    base: process.env,
    port,
    secretsFile,
    profileDir,
    uiOrigin: uiOrigin ?? input('ui-origin'),
    trayWorkerBaseUrl: trayWorkerBaseUrl ?? input('tray-worker-base-url'),
    bridgeDevAllowedOrigins,
    cdpLaunchTimeoutMs,
    joinFile: file,
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
    file,
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
      joinFile: file,
      joinUrl: joinInfo.joinUrl,
      trayId: joinInfo.trayId,
      sliccVersion: joinInfo.sliccVersion,
      uiServer: typeof uiServer === 'number' ? uiServer : null,
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
  const pin = resolvePinnedWebapp({
    pin: inputs.pinWebapp,
    entry,
    bridgePort: inputs.port,
    uiOrigin: input('ui-origin'),
    trayWorkerBaseUrl: input('tray-worker-base-url'),
  });
  const secretsFile = join(home, 'secrets.env');
  let ui = null;
  try {
    if (pin) {
      ui = await launchPinnedWebapp({
        root: pin.root,
        port: pin.uiPort,
        logPath: join(home, 'ui-server.log'),
        upstream: pin.trayWorkerBaseUrl,
        spawnImpl: options.spawnImpl,
        waitImpl: options.waitForWebapp,
      });
    }
    return await bootLeader({
      home,
      entry,
      ...inputs,
      pollMs: options.pollMs,
      uiOrigin: pin?.uiOrigin,
      trayWorkerBaseUrl: pin?.trayWorkerBaseUrl,
      bridgeDevAllowedOrigins: pin?.bridgeDevAllowedOrigins,
      uiServer: ui?.pid,
    });
  } catch (err) {
    if (ui?.pid) await terminate(ui.pid, 2_000);
    removeCredentialFiles(secretsFile);
    throw err;
  }
}

// The direct-run trampoline: unreachable in-process (tests import `main`), so
// it is excluded from coverage rather than faked through a subprocess.
/* v8 ignore start */
if (isMain(import.meta.url)) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
/* v8 ignore stop */
