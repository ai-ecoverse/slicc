import type { CommandContext } from 'just-bash';
import { createLogger } from '../../../base/logger.js';
import { kernelJobTable } from '../../../kernel/job-table.js';
import type { ProcessManager } from '../../../kernel/process-manager.js';
import type { RealmFactory } from '../../../kernel/realm/realm-runner.js';
import { executeJshFile } from '../../jsh-executor.js';
import { appendUnitLog, type JshdFs, readUnitRecord, writeUnitRecord } from './store.js';
import {
  BACKOFF_INITIAL_MS,
  BACKOFF_MAX_MS,
  CRASH_LOOP_MAX,
  CRASH_LOOP_WINDOW_MS,
  type JshdUnitRecord,
  type JshdUnitState,
  type JshdUnitStatus,
  unitLogPath,
} from './types.js';

const log = createLogger('jshd');

export interface JshdLickSink {
  emitEvent(event: {
    type: 'jshd';
    jshdName?: string;
    jshdRestarts?: number;
    resultPath?: string;
    preview?: string;
    timestamp: string;
    body: unknown;
  }): void;
}

export interface JshdSupervisorDeps {
  fs: JshdFs;
  processManager: ProcessManager;
  lickManager?: JshdLickSink;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  isDurable?: () => boolean;
  realmFactory?: RealmFactory;
  buildContext: (record: JshdUnitRecord) => CommandContext;
}

interface LiveUnit {
  record: JshdUnitRecord;
  pid: number | null;
  state: JshdUnitState;
  restarts: number;
  startedAt: number | null;
  lastExitCode: number | null;
  stopRequested: boolean;
  restartAt: number[];
  spawnResolve: ((pid: number) => void) | null;
  spawnReject: ((err: Error) => void) | null;
  loop: Promise<void> | null;
  backoffAbort: AbortController | null;
}

export class JshdSupervisor {
  private readonly units = new Map<string, LiveUnit>();
  private readonly logQueues = new Map<string, Promise<void>>();
  private readonly deps: JshdSupervisorDeps;

  constructor(deps: JshdSupervisorDeps) {
    this.deps = deps;
  }

  isDurable(): boolean {
    return this.deps.isDurable?.() ?? typeof Worker !== 'undefined';
  }

  list(): JshdUnitStatus[] {
    return [...this.units.values()]
      .map((unit) => this.toStatus(unit))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  status(name: string): JshdUnitStatus | null {
    const unit = this.units.get(name);
    return unit ? this.toStatus(unit) : null;
  }

  async start(record: JshdUnitRecord): Promise<{ pid: number; durable: boolean }> {
    const existing = this.units.get(record.name);
    if (existing && (existing.state === 'running' || existing.state === 'starting')) {
      throw new Error(`unit '${record.name}' is already ${existing.state}`);
    }
    // Reserve the name before the first await so concurrent `start -n same`
    // cannot both pass the existing-unit check and spawn untracked workers.
    const live = this.makeLive(record);
    this.units.set(record.name, live);
    try {
      await writeUnitRecord(this.deps.fs, record);
    } catch (err) {
      this.units.delete(record.name);
      throw err;
    }
    const spawned = new Promise<number>((resolve, reject) => {
      live.spawnResolve = resolve;
      live.spawnReject = reject;
    });
    live.loop = this.runLoop(live);
    const pid = await spawned;
    return { pid, durable: this.isDurable() };
  }

  async stop(name: string): Promise<boolean> {
    const unit = this.units.get(name);
    if (!unit) return false;
    unit.stopRequested = true;
    unit.backoffAbort?.abort();
    if (unit.pid !== null) this.deps.processManager.signal(unit.pid, 'SIGTERM');
    if (unit.loop) await unit.loop.catch(() => undefined);
    unit.state = 'stopped';
    unit.pid = null;
    this.syncJob(unit);
    await this.flushLogs(name);
    return true;
  }

  async restart(name: string): Promise<{ pid: number; durable: boolean } | null> {
    const record = this.units.get(name)?.record ?? (await readUnitRecord(this.deps.fs, name));
    if (!record) return null;
    await this.stop(name);
    return this.start(record);
  }

  async rm(name: string): Promise<boolean> {
    await this.stop(name);
    this.units.delete(name);
    kernelJobTable.remove(jobId(name));
    await this.flushLogs(name);
    const { deleteUnitRecord } = await import('./store.js');
    await deleteUnitRecord(this.deps.fs, name);
    return true;
  }

  async setEnabled(name: string, enabled: boolean): Promise<JshdUnitRecord | null> {
    const live = this.units.get(name);
    const record = live?.record ?? (await readUnitRecord(this.deps.fs, name));
    if (!record) return null;
    const next = { ...record, enabled };
    if (live) live.record = next;
    await writeUnitRecord(this.deps.fs, next);
    return next;
  }

  dispose(): void {
    for (const unit of this.units.values()) {
      unit.stopRequested = true;
      unit.backoffAbort?.abort();
      if (unit.pid !== null) this.deps.processManager.signal(unit.pid, 'SIGKILL');
    }
    this.units.clear();
  }

  private makeLive(record: JshdUnitRecord): LiveUnit {
    return {
      record,
      pid: null,
      state: 'starting',
      restarts: 0,
      startedAt: null,
      lastExitCode: null,
      stopRequested: false,
      restartAt: [],
      spawnResolve: null,
      spawnReject: null,
      loop: null,
      backoffAbort: null,
    };
  }

  private async runLoop(unit: LiveUnit): Promise<void> {
    try {
      while (!unit.stopRequested) {
        const outcome = await this.runOnce(unit);
        unit.lastExitCode = outcome.exitCode;
        unit.pid = null;
        if (unit.stopRequested || outcome.signaled) {
          unit.state = 'stopped';
          this.syncJob(unit);
          return;
        }
        if (!this.shouldRestart(unit, outcome.exitCode)) {
          unit.state = 'stopped';
          this.syncJob(unit);
          return;
        }
        if (this.hitCrashLoop(unit)) {
          unit.state = 'errored';
          this.syncJob(unit);
          this.emitCrashLoop(unit);
          return;
        }
        await this.backoff(unit);
        if (unit.stopRequested) {
          unit.state = 'stopped';
          this.syncJob(unit);
          return;
        }
        unit.restarts += 1;
      }
      unit.state = 'stopped';
      this.syncJob(unit);
    } catch (err) {
      log.warn('jshd unit loop failed', {
        name: unit.record.name,
        error: err instanceof Error ? err.message : String(err),
      });
      unit.state = 'errored';
      unit.spawnReject?.(err instanceof Error ? err : new Error(String(err)));
      this.syncJob(unit);
    }
  }

  private async runOnce(unit: LiveUnit): Promise<{ exitCode: number; signaled: boolean }> {
    unit.state = 'starting';
    unit.startedAt = this.now();
    this.syncJob(unit);
    const scriptPath = unit.record.argv[0];
    const args = unit.record.argv.slice(1);
    const ctx = this.deps.buildContext(unit.record);
    const result = await executeJshFile(scriptPath, args, ctx, this.pmConfig(), {
      ...(this.deps.realmFactory ? { realmFactory: this.deps.realmFactory } : {}),
      captureOutput: false,
      onSpawn: (pid) => {
        unit.pid = pid;
        unit.state = 'running';
        this.syncJob(unit);
        unit.spawnResolve?.(pid);
        unit.spawnResolve = null;
        unit.spawnReject = null;
      },
      onOutput: (chunk) => {
        void this.enqueueLog(unit.record.name, chunk);
      },
    });
    if (unit.pid === null) {
      unit.spawnReject?.(
        new Error(result.stderr.trim() || `unit '${unit.record.name}' failed to start`)
      );
      unit.spawnResolve = null;
      unit.spawnReject = null;
    }
    const proc = unit.pid !== null ? this.deps.processManager.get(unit.pid) : null;
    return { exitCode: result.exitCode, signaled: proc?.terminatedBy != null };
  }

  private shouldRestart(unit: LiveUnit, exitCode: number): boolean {
    if (unit.record.restart === 'no') return false;
    if (unit.record.restart === 'always') return true;
    return exitCode !== 0;
  }

  private hitCrashLoop(unit: LiveUnit): boolean {
    const now = this.now();
    unit.restartAt = unit.restartAt.filter((at) => now - at < CRASH_LOOP_WINDOW_MS);
    unit.restartAt.push(now);
    return unit.restartAt.length >= CRASH_LOOP_MAX;
  }

  private async backoff(unit: LiveUnit): Promise<void> {
    // `restarts` is the count of already-completed restarts, so the first
    // wait is 1s (2^0), not 2s.
    const exp = Math.min(unit.restarts, 8);
    const ms = Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** exp);
    const sleep = this.deps.sleep ?? defaultSleep;
    const controller = new AbortController();
    unit.backoffAbort = controller;
    try {
      await sleep(ms, controller.signal);
    } catch {
      unit.stopRequested = true;
    } finally {
      unit.backoffAbort = null;
    }
  }

  private emitCrashLoop(unit: LiveUnit): void {
    const name = unit.record.name;
    const preview = `jshd unit '${name}' marked errored after ${unit.restarts} restarts in ${CRASH_LOOP_WINDOW_MS / 1000}s`;
    this.deps.lickManager?.emitEvent({
      type: 'jshd',
      jshdName: name,
      jshdRestarts: unit.restarts,
      resultPath: unitLogPath(name),
      preview,
      timestamp: new Date(this.now()).toISOString(),
      body: { kind: 'jshd', name, reason: 'crash-loop', restarts: unit.restarts },
    });
  }

  private enqueueLog(name: string, chunk: string): Promise<void> {
    const prev = this.logQueues.get(name) ?? Promise.resolve();
    const next = prev.then(() => this.tee(name, chunk)).catch(() => undefined);
    this.logQueues.set(name, next);
    return next;
  }

  private async flushLogs(name: string): Promise<void> {
    const pending = this.logQueues.get(name);
    if (!pending) return;
    await pending.catch(() => undefined);
    this.logQueues.delete(name);
  }

  private async tee(name: string, chunk: string): Promise<void> {
    try {
      await appendUnitLog(this.deps.fs, name, chunk);
    } catch (err) {
      log.warn('failed to tee jshd log', {
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private pmConfig() {
    return {
      processManager: this.deps.processManager,
      owner: { kind: 'jshd' as const },
    };
  }

  private syncJob(unit: LiveUnit): void {
    kernelJobTable.upsert({
      id: jobId(unit.record.name),
      kind: 'jshd',
      pid: unit.pid,
      argv: unit.record.argv,
      status: unit.state,
      startedAt: unit.startedAt ?? this.now(),
      restarts: unit.restarts,
    });
  }

  private toStatus(unit: LiveUnit): JshdUnitStatus {
    const now = this.now();
    return {
      name: unit.record.name,
      pid: unit.pid,
      state: unit.state,
      restarts: unit.restarts,
      uptimeMs: unit.startedAt !== null && unit.state === 'running' ? now - unit.startedAt : null,
      enabled: unit.record.enabled,
      restart: unit.record.restart,
      argv: unit.record.argv,
      cwd: unit.record.cwd,
      durable: this.isDurable(),
      lastExitCode: unit.lastExitCode,
    };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function jobId(name: string): string {
  return `jshd:${name}`;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

let singleton: JshdSupervisor | null = null;

/**
 * Return the kernel-owned supervisor, constructing it from `deps` only
 * on the first call. Later callers cannot replace FS / `buildContext`.
 */
export function getJshdSupervisor(deps?: JshdSupervisorDeps): JshdSupervisor | null {
  if (singleton) return singleton;
  if (!deps) return null;
  singleton = new JshdSupervisor(deps);
  return singleton;
}

/** Construct the supervisor from kernel-owned deps if it does not exist yet. */
export function installJshdSupervisor(deps: JshdSupervisorDeps): JshdSupervisor {
  if (!singleton) singleton = new JshdSupervisor(deps);
  return singleton;
}

export function resetJshdSupervisor(): void {
  singleton?.dispose();
  singleton = null;
}
