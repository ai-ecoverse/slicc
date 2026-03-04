/**
 * Heartbeat System - monitors group context health and activity.
 * 
 * Tracks:
 * - Last activity timestamp
 * - Processing state
 * - Error count
 * - Memory usage (rough estimate)
 */

import { createLogger } from '../core/logger.js';
import type { RegisteredGroup } from './types.js';

const log = createLogger('heartbeat');

export interface HeartbeatStatus {
  groupJid: string;
  groupName: string;
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
  private groups = new Map<string, {
    group: RegisteredGroup;
    lastActivity: Date;
    lastError?: string;
    errorCount: number;
    startTime: Date;
    isProcessing: boolean;
    status: HeartbeatStatus['status'];
  }>();
  private callbacks: HeartbeatCallbacks;
  private pollInterval: number | null = null;
  private idleThresholdMs = 5 * 60 * 1000; // 5 minutes
  private deadThresholdMs = 30 * 60 * 1000; // 30 minutes

  constructor(callbacks: HeartbeatCallbacks) {
    this.callbacks = callbacks;
  }

  /** Start monitoring */
  start(): void {
    if (this.pollInterval) return;
    
    this.pollInterval = window.setInterval(() => this.checkAll(), 10000); // Every 10 seconds
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

  /** Register a group for monitoring */
  register(group: RegisteredGroup): void {
    const now = new Date();
    this.groups.set(group.jid, {
      group,
      lastActivity: now,
      errorCount: 0,
      startTime: now,
      isProcessing: false,
      status: 'healthy',
    });
    log.debug('Group registered for heartbeat', { jid: group.jid, name: group.name });
  }

  /** Unregister a group */
  unregister(jid: string): void {
    this.groups.delete(jid);
    log.debug('Group unregistered from heartbeat', { jid });
  }

  /** Record activity for a group */
  recordActivity(jid: string): void {
    const data = this.groups.get(jid);
    if (data) {
      data.lastActivity = new Date();
      this.updateStatus(jid, data);
    }
  }

  /** Record that a group started processing */
  recordProcessingStart(jid: string): void {
    const data = this.groups.get(jid);
    if (data) {
      data.isProcessing = true;
      data.lastActivity = new Date();
      this.updateStatus(jid, data);
    }
  }

  /** Record that a group finished processing */
  recordProcessingEnd(jid: string): void {
    const data = this.groups.get(jid);
    if (data) {
      data.isProcessing = false;
      data.lastActivity = new Date();
      this.updateStatus(jid, data);
    }
  }

  /** Record an error */
  recordError(jid: string, error: string): void {
    const data = this.groups.get(jid);
    if (data) {
      data.errorCount++;
      data.lastError = error;
      data.lastActivity = new Date();
      this.updateStatus(jid, data);
    }
  }

  /** Get status for a specific group */
  getStatus(jid: string): HeartbeatStatus | null {
    const data = this.groups.get(jid);
    if (!data) return null;
    return this.buildStatus(jid, data);
  }

  /** Get all statuses */
  getAllStatuses(): HeartbeatStatus[] {
    return Array.from(this.groups.entries())
      .map(([jid, data]) => this.buildStatus(jid, data));
  }

  /** Check health of all groups */
  private checkAll(): void {
    const now = new Date();
    
    for (const [jid, data] of this.groups) {
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
          log.warn('Group marked as dead', { jid, name: data.group.name });
          this.callbacks.onDead(jid);
        }
        
        this.callbacks.onStatusChange(jid, this.buildStatus(jid, data));
      }
    }
  }

  private updateStatus(jid: string, data: typeof this.groups extends Map<string, infer V> ? V : never): void {
    const status = this.buildStatus(jid, data);
    this.callbacks.onStatusChange(jid, status);
  }

  private buildStatus(jid: string, data: {
    group: RegisteredGroup;
    lastActivity: Date;
    lastError?: string;
    errorCount: number;
    startTime: Date;
    isProcessing: boolean;
    status: HeartbeatStatus['status'];
  }): HeartbeatStatus {
    return {
      groupJid: jid,
      groupName: data.group.name,
      status: data.status,
      lastActivity: data.lastActivity.toISOString(),
      lastError: data.lastError,
      errorCount: data.errorCount,
      uptime: Date.now() - data.startTime.getTime(),
      isProcessing: data.isProcessing,
    };
  }
}
