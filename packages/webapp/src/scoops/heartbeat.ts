/**
 * Heartbeat System - monitors scoop context health and activity.
 *
 * Tracks:
 * - Last activity timestamp
 * - Processing state
 * - Error count
 * - Memory usage (rough estimate)
 */

import { createLogger } from '../core/logger.js';
import type { RegisteredScoop } from './types.js';

const log = createLogger('heartbeat');

export interface HeartbeatStatus {
  scoopJid: string;
  scoopName: string;
  status: 'healthy' | 'idle' | 'busy' | 'error' | 'dead';
  lastActivity: string;
  lastError?: string;
  errorCount: number;
  uptime: number;
  isProcessing: boolean;
}

export interface HeartbeatCallbacks {
  onStatusChange: (jid: string, status: HeartbeatStatus) => void;
  onDead: (jid: string) => void;
}

export class Heartbeat {
  private scoops = new Map<
    string,
    {
      scoop: RegisteredScoop;
      lastActivity: Date;
      lastError?: string;
      errorCount: number;
      startTime: Date;
      isProcessing: boolean;
      status: HeartbeatStatus['status'];
    }
  >();
  private callbacks: HeartbeatCallbacks;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private idleThresholdMs = 5 * 60 * 1000; // 5 minutes
  private deadThresholdMs = 30 * 60 * 1000; // 30 minutes

  constructor(callbacks: HeartbeatCallbacks) {
    this.callbacks = callbacks;
  }

  /** Start monitoring */
  start(): void {
    if (this.pollInterval) return;

    // `setInterval` (no `window.` prefix) so this works in both page
    // and DedicatedWorker contexts. The standalone runtime runs heartbeat
    // in a worker; `window` is undefined there.
    this.pollInterval = setInterval(() => this.checkAll(), 10000);
    log.info('Heartbeat monitoring started');
  }

  /** Stop monitoring */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    log.info('Heartbeat monitoring stopped');
  }

  /** Register a scoop for monitoring */
  register(scoop: RegisteredScoop): void {
    const now = new Date();
    this.scoops.set(scoop.jid, {
      scoop,
      lastActivity: now,
      errorCount: 0,
      startTime: now,
      isProcessing: false,
      status: 'healthy',
    });
    log.debug('Scoop registered for heartbeat', { jid: scoop.jid, name: scoop.name });
  }

  /** Unregister a scoop */
  unregister(jid: string): void {
    this.scoops.delete(jid);
    log.debug('Scoop unregistered from heartbeat', { jid });
  }

  /** Record activity for a scoop */
  recordActivity(jid: string): void {
    const data = this.scoops.get(jid);
    if (data) {
      data.lastActivity = new Date();
      this.updateStatus(jid, data);
    }
  }

  /** Record that a scoop started processing */
  recordProcessingStart(jid: string): void {
    const data = this.scoops.get(jid);
    if (data) {
      data.isProcessing = true;
      data.lastActivity = new Date();
      this.updateStatus(jid, data);
    }
  }

  /** Record that a scoop finished processing */
  recordProcessingEnd(jid: string): void {
    const data = this.scoops.get(jid);
    if (data) {
      data.isProcessing = false;
      data.lastActivity = new Date();
      this.updateStatus(jid, data);
    }
  }

  /** Record an error */
  recordError(jid: string, error: string): void {
    const data = this.scoops.get(jid);
    if (data) {
      data.errorCount++;
      data.lastError = error;
      data.lastActivity = new Date();
      this.updateStatus(jid, data);
    }
  }

  /** Get status for a specific scoop */
  getStatus(jid: string): HeartbeatStatus | null {
    const data = this.scoops.get(jid);
    if (!data) return null;
    return this.buildStatus(jid, data);
  }

  /** Get all statuses */
  getAllStatuses(): HeartbeatStatus[] {
    return Array.from(this.scoops.entries()).map(([jid, data]) => this.buildStatus(jid, data));
  }

  /** Check health of all scoops */
  private checkAll(): void {
    const now = new Date();

    for (const [jid, data] of this.scoops) {
      const timeSinceActivity = now.getTime() - data.lastActivity.getTime();

      let newStatus: HeartbeatStatus['status'];

      if (data.isProcessing) {
        newStatus = 'busy';
      } else if (data.errorCount > 5) {
        newStatus = 'error';
      } else if (timeSinceActivity > this.deadThresholdMs) {
        newStatus = 'dead';
      } else if (timeSinceActivity > this.idleThresholdMs) {
        newStatus = 'idle';
      } else {
        newStatus = 'healthy';
      }

      if (newStatus !== data.status) {
        data.status = newStatus;

        if (newStatus === 'dead') {
          log.warn('Scoop marked as dead', { jid, name: data.scoop.name });
          this.callbacks.onDead(jid);
        }

        this.callbacks.onStatusChange(jid, this.buildStatus(jid, data));
      }
    }
  }

  private updateStatus(
    jid: string,
    data: typeof this.scoops extends Map<string, infer V> ? V : never
  ): void {
    const status = this.buildStatus(jid, data);
    this.callbacks.onStatusChange(jid, status);
  }

  private buildStatus(
    jid: string,
    data: {
      scoop: RegisteredScoop;
      lastActivity: Date;
      lastError?: string;
      errorCount: number;
      startTime: Date;
      isProcessing: boolean;
      status: HeartbeatStatus['status'];
    }
  ): HeartbeatStatus {
    return {
      scoopJid: jid,
      scoopName: data.scoop.name,
      status: data.status,
      lastActivity: data.lastActivity.toISOString(),
      lastError: data.lastError,
      errorCount: data.errorCount,
      uptime: Date.now() - data.startTime.getTime(),
      isProcessing: data.isProcessing,
    };
  }
}
