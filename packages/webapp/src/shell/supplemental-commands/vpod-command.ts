/**
 * `vpod` — run Linux commands in a WebAssembly sandbox
 * (capsule-run/vpod: a real 64-bit kernel + userland compiled to wasm,
 * not a shell reimplementation). Install-gated like `v86` / `biome`:
 * the whole SDK comes from an ipk-installed `@capsule-run/vpod` (see
 * `vpod-loader.ts`); nothing is bundled and there is no CDN fallback.
 *
 * Interaction model: pods are non-interactive — no TTY, no output
 * streaming; each `commands.run` returns the complete result when the
 * guest command exits. That maps 1:1 onto a shell command, so unlike
 * `v86` there is no screenshot/keyboard surface: `vpod start` boots a
 * named background pod (module-level registry in `vpod-pods.ts`,
 * ProcessManager-registered so `ps` sees it and `kill` stops it) and
 * `vpod run` executes commands in it. `vpod run` auto-boots the
 * default pod so the one-shot path needs no ceremony.
 *
 * Guest networking rides on SharedArrayBuffer, which needs a
 * cross-origin-isolated runtime. SLICC does not use COOP/COEP (the
 * kernel's sync-FS bridge was deliberately built without them, see
 * `docs/kernel/process-model.md`); isolation arrives per-document via
 * `Document-Isolation-Policy` on the leader route (#2036), which the
 * command feature-detects at runtime. Offline pods work either way;
 * `vpod net` reports what the guest can reach and why.
 */

import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { ProcessManager } from '../../kernel/process-manager.js';
import {
  getVpodModule,
  type IpkResolutionContext,
  tryResolveVpodFromNodeModules,
  VPOD_NOT_INSTALLED,
  VPOD_PACKAGE,
  VPOD_PINNED_VERSION,
  type VpodModule,
} from './vpod-loader.js';
import { getPod, listPods, type PodRecord, registerPod, unregisterPod } from './vpod-pods.js';

type CmdResult = { stdout: string; stderr: string; exitCode: number };

const DEFAULT_POD_NAME = 'pod0';

const HELP = `vpod - run Linux commands in a WebAssembly sandbox (capsule-run/vpod)

Requires: ipk add ${VPOD_PACKAGE}@${VPOD_PINNED_VERSION}

Usage:
  vpod start [--name <n>] [--snapshot <s>] [--net]  Boot a pod in the background
  vpod run [--name <n>] [--timeout <secs>] <cmd...> Run a command in the pod
  vpod ls                                           List running pods
  vpod net [--name <n>] [--port <p>]                Guest network capabilities
  vpod stop [--name <n>]                            Close the pod
  vpod --version                                    Installed SDK version

Notes:
  - \`vpod run\` auto-boots '${DEFAULT_POD_NAME}' when it is not running yet.
  - Real 64-bit Linux userland; the default snapshot ships git, curl,
    node, and python3 baked in. First boot pulls the snapshot from the
    vpod registry and caches it in origin-private storage.
  - Non-interactive: no TTYs (vim, top, REPLs time out), no streaming —
    each run returns complete stdout/stderr when the command exits.
  - Guest networking (\`--net\`) requires a cross-origin-isolated
    runtime; \`vpod net\` reports the current backend and why. Without
    isolation expect backend 'none' — use the host's \`curl\`/\`fetch\`
    and share files with the pod instead.
`;

/** Boot configuration parsed from `vpod start` args. */
export interface ParsedStartArgs {
  name: string;
  snapshot?: string;
  net: boolean;
}

/** Parse `vpod start` args. Returns an error result on unknown flags. */
export function parseStartArgs(
  args: readonly string[]
): { parsed: ParsedStartArgs } | { error: string } {
  const parsed: ParsedStartArgs = { name: DEFAULT_POD_NAME, net: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '-n':
      case '--name': {
        const v = args[++i];
        if (!v) return { error: `${arg} requires a value` };
        parsed.name = v;
        break;
      }
      case '--snapshot': {
        const v = args[++i];
        if (!v) return { error: '--snapshot requires a value' };
        parsed.snapshot = v;
        break;
      }
      case '--net':
        parsed.net = true;
        break;
      default:
        return { error: `unknown start option '${arg}' — see \`vpod --help\`` };
    }
  }
  return { parsed };
}

/** Pull a `-n <name>` / `--name <name>` pair out of subcommand args. */
export function extractPodName(args: readonly string[]): { name: string; rest: string[] } {
  const rest: string[] = [];
  let name = DEFAULT_POD_NAME;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n' || args[i] === '--name') {
      const v = args[i + 1];
      if (v) {
        name = v;
        i++;
        continue;
      }
    }
    rest.push(args[i]);
  }
  return { name, rest };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an {@link IpkResolutionContext} from a command's `ctx`. Mirrors
 * `createIpkContextFromCtx` in `v86-command.ts` / `ffmpeg-command.ts`
 * so every float wires the loader the same way.
 */
export function createIpkContextFromCtx(ctx: CommandContext): IpkResolutionContext {
  return {
    reader: {
      exists: (path) => ctx.fs.exists(path),
      isDirectory: async (path) => {
        try {
          return (await ctx.fs.stat(path)).isDirectory;
        } catch {
          return false;
        }
      },
      readFile: (path) => ctx.fs.readFile(path),
    },
    readBytes: (path) => ctx.fs.readFileBuffer(path),
    fromDir: ctx.cwd,
  };
}

/**
 * Quote one argv token for the guest `/bin/sh`. The host shell already
 * consumed the user's quotes, so rejoining argv with plain spaces would
 * hand the guest bare metacharacters (`vpod run python3 -c "print(1)"`
 * → `python3 -c print(1)` → guest syntax error). Mirrors `quoteArg` in
 * `builtin-shadow-map.ts`. Guest-side pipes/redirects go through
 * `vpod run sh -c "..."`, which survives this quoting by construction.
 */
function shellQuoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@%^,+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function fail(msg: string): CmdResult {
  return { stdout: '', stderr: `vpod: ${msg}\n`, exitCode: 1 };
}

function ok(msg = ''): CmdResult {
  return { stdout: msg, stderr: '', exitCode: 0 };
}

function requirePod(name: string): PodRecord | CmdResult {
  const record = getPod(name);
  if (!record) {
    return fail(`no pod named '${name}' — boot one with \`vpod start --name ${name}\``);
  }
  return record;
}

function isCmdResult(value: PodRecord | CmdResult): value is CmdResult {
  return 'exitCode' in value;
}

// ---------------------------------------------------------------------------
// SDK dependency injection (tests)
// ---------------------------------------------------------------------------

export interface VpodCommandDeps {
  /**
   * Override the SDK loader. Tests inject a fake returning a stub
   * Sandbox; production resolves through `getVpodModule` (ipk-gated).
   */
  loadSdk?: (ipk: IpkResolutionContext) => Promise<VpodModule>;
  /**
   * Inject a `ProcessManager`. When omitted, looks up
   * `globalThis.__slicc_pm` at exec time (same fallback as `ps`/`kill`).
   */
  processManager?: ProcessManager;
}

function lookupGlobalPm(): ProcessManager | null {
  const g = globalThis as Record<string, unknown>;
  const pm = g.__slicc_pm;
  return pm instanceof Object && typeof (pm as ProcessManager).signal === 'function'
    ? (pm as ProcessManager)
    : null;
}

async function loadSdk(ctx: CommandContext, deps: VpodCommandDeps): Promise<VpodModule> {
  const ipk = createIpkContextFromCtx(ctx);
  return deps.loadSdk ? deps.loadSdk(ipk) : getVpodModule({ ipk });
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function createVpodCommand(deps: VpodCommandDeps = {}): Command {
  return defineCommand('vpod', async (args, ctx) => {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
      return ok(HELP);
    }
    if (args[0] === '--version') return vpodVersion(ctx, deps);

    const sub = args[0];
    const subArgs = args.slice(1);
    try {
      switch (sub) {
        case 'start':
          return await vpodStart(subArgs, ctx, deps);
        case 'run':
          return await vpodRun(subArgs, ctx, deps);
        case 'ls':
          return vpodLs();
        case 'net':
          return await vpodNet(subArgs, ctx, deps);
        case 'stop':
          return await vpodStop(subArgs, deps);
        default:
          return fail(`unknown subcommand '${sub}' — see \`vpod --help\``);
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}

/**
 * `vpod --version` is gated behind an ipk-installed package for parity
 * with `v86 --version` — reporting a version without the SDK present
 * would lie. Resolves without importing the SDK.
 */
async function vpodVersion(ctx: CommandContext, deps: VpodCommandDeps): Promise<CmdResult> {
  if (deps.loadSdk) {
    const mod = await deps.loadSdk(createIpkContextFromCtx(ctx));
    return ok(`vpod ${mod.version}\n`);
  }
  const resolved = await tryResolveVpodFromNodeModules(createIpkContextFromCtx(ctx));
  if (!resolved) return fail(VPOD_NOT_INSTALLED);
  return ok(`vpod ${resolved.version}\n`);
}

async function bootPod(
  parsed: ParsedStartArgs,
  argv: readonly string[],
  ctx: CommandContext,
  deps: VpodCommandDeps
): Promise<PodRecord | CmdResult> {
  if (getPod(parsed.name)) {
    return fail(`pod '${parsed.name}' already running — stop it first or pick another --name`);
  }
  const mod = await loadSdk(ctx, deps);

  let sandbox;
  try {
    sandbox = await mod.sdk.Sandbox.create({
      ...(parsed.snapshot ? { snapshot: parsed.snapshot } : {}),
      ...(parsed.net ? { network: true } : {}),
    });
  } catch (err) {
    return fail(`boot failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const record: PodRecord = {
    name: parsed.name,
    sandbox,
    sdkVersion: mod.version,
    snapshotId: sandbox.snapshotId,
    pid: null,
    startedAt: Date.now(),
    bootArgv: ['vpod', ...argv],
    busy: false,
  };

  // Register with the ProcessManager so `ps` sees the pod and
  // `kill <pid>` closes it (via the abort signal).
  const pm = deps.processManager ?? lookupGlobalPm();
  if (pm) {
    const proc = pm.spawn({
      kind: 'net',
      argv: record.bootArgv,
      cwd: ctx.cwd,
      owner: { kind: 'system' },
    });
    record.pid = proc.pid;
    proc.abort.signal.addEventListener('abort', () => {
      void teardownPod(record, pm);
    });
  }

  registerPod(record);
  return record;
}

async function vpodStart(
  args: readonly string[],
  ctx: CommandContext,
  deps: VpodCommandDeps
): Promise<CmdResult> {
  const result = parseStartArgs(args);
  if ('error' in result) return fail(result.error);
  const booted = await bootPod(result.parsed, ['start', ...args], ctx, deps);
  if (isCmdResult(booted)) return booted;

  const pidNote = booted.pid !== null ? `, pid ${booted.pid}` : '';
  return ok(
    `pod '${booted.name}' running (snapshot ${booted.snapshotId}${pidNote}).\n` +
      `Run commands with: vpod run${booted.name === DEFAULT_POD_NAME ? '' : ` --name ${booted.name}`} <command>\n`
  );
}

async function vpodRun(
  args: readonly string[],
  ctx: CommandContext,
  deps: VpodCommandDeps
): Promise<CmdResult> {
  // Flags are only recognized BEFORE the first command word (with `--`
  // as an explicit terminator) so the guest command passes through
  // intact — `vpod run node script.js --name foo` must not lose args.
  let name = DEFAULT_POD_NAME;
  let timeout: number | undefined;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-n' || arg === '--name') {
      const v = args[++i];
      if (!v) return fail(`${arg} requires a value`);
      name = v;
      continue;
    }
    if (arg === '--timeout') {
      const v = Number(args[++i]);
      if (!Number.isInteger(v) || v <= 0) {
        return fail('--timeout requires a positive integer (seconds)');
      }
      timeout = v;
      continue;
    }
    if (arg === '--') {
      i++;
      break;
    }
    break;
  }
  const command = args.slice(i).map(shellQuoteArg).join(' ').trim();
  if (!command) return fail('run requires a command — e.g. `vpod run uname -a`');

  let record = getPod(name);
  if (!record) {
    // Auto-boot only the default pod: a missing named pod is more
    // likely a typo than a boot request.
    if (name !== DEFAULT_POD_NAME) return requirePod(name) as CmdResult;
    const booted = await bootPod({ name, net: false }, ['run', ...args], ctx, deps);
    if (isCmdResult(booted)) return booted;
    record = booted;
  }

  if (record.busy) {
    return fail(`pod '${name}' is busy running another command — wait for it to finish`);
  }
  record.busy = true;
  try {
    const result = await record.sandbox.commands.run(
      command,
      timeout !== undefined ? { timeout } : undefined
    );
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  } finally {
    record.busy = false;
  }
}

function vpodLs(): CmdResult {
  const pods = listPods();
  if (pods.length === 0) return ok('no pods running\n');
  const lines = ['NAME       PID    UP        SNAPSHOT'];
  for (const pod of pods) {
    const up = Math.round((Date.now() - pod.startedAt) / 1000);
    const upText = up >= 60 ? `${Math.floor(up / 60)}m${up % 60}s` : `${up}s`;
    lines.push(
      `${pod.name.padEnd(10)} ${String(pod.pid ?? '-').padEnd(6)} ${upText.padEnd(9)} ${pod.snapshotId}`
    );
  }
  return ok(`${lines.join('\n')}\n`);
}

async function vpodNet(
  args: readonly string[],
  ctx: CommandContext,
  deps: VpodCommandDeps
): Promise<CmdResult> {
  const { name, rest } = extractPodName(args);
  let port: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--port') {
      const v = Number(rest[++i]);
      if (!Number.isInteger(v) || v <= 0 || v > 65535) return fail('--port requires a port number');
      port = v;
    } else {
      return fail(`unknown net option '${rest[i]}' — see \`vpod --help\``);
    }
  }
  const record = requirePod(name);
  if (isCmdResult(record)) return record;

  const caps = record.sandbox.network;
  const lines = [
    `backend:          ${caps.backend}`,
    `raw tcp:          ${caps.rawTcp}`,
    `arbitrary ports:  ${caps.arbitraryPorts}`,
    `udp:              ${caps.udp}`,
    `cors restricted:  ${caps.corsRestricted}`,
  ];
  if (caps.backend === 'none' && !globalThis.crossOriginIsolated) {
    lines.push(
      'note: guest networking needs cross-origin isolation (Document-Isolation-Policy), which this runtime does not have'
    );
  }
  if (port !== undefined) {
    const mod = await loadSdk(ctx, deps);
    const reason = mod.sdk.explainUnreachable(caps, port);
    lines.push(`port ${port}: ${reason ?? 'reachable'}`);
  }
  return ok(`${lines.join('\n')}\n`);
}

async function vpodStop(args: readonly string[], deps: VpodCommandDeps): Promise<CmdResult> {
  const { name } = extractPodName(args);
  const record = requirePod(name);
  if (isCmdResult(record)) return record;
  const pm = deps.processManager ?? lookupGlobalPm();
  await teardownPod(record, pm);
  return ok(`pod '${name}' closed\n`);
}

async function teardownPod(record: PodRecord, pm: ProcessManager | null): Promise<void> {
  unregisterPod(record.name);
  try {
    await record.sandbox.close();
  } catch {
    // Best-effort — the sandbox worker may already be gone.
  }
  if (pm && record.pid !== null) pm.exit(record.pid, null);
}
