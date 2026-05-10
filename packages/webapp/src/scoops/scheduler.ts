/**
 * Task Scheduler - runs scheduled tasks for scoops.
 *
 * Supports:
 * - Cron expressions (e.g., "0 9 * * 1" = Mondays at 9am)
 * - Intervals (e.g., 3600000 = every hour)
 * - One-time tasks (ISO timestamp)
 */

import type { ScheduledTask, RegisteredScoop } from './types.js';
import * as db from './db.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('scheduler');

export interface SchedulerCallbacks {
  /** Called when a task should be executed */
  onTaskRun: (task: ScheduledTask, scoop: RegisteredScoop) => Promise<void>;
  /** Get a registered scoop by folder */
  getScoop: (folder: string) => RegisteredScoop | undefined;
}

export class TaskScheduler {
  private callbacks: SchedulerCallbacks;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(callbacks: SchedulerCallbacks) {
    this.callbacks = callbacks;
  }

  /** Start the scheduler */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Poll every minute
    // `setInterval` (no `window.` prefix) so this works in both page
    // and DedicatedWorker contexts. The standalone runtime runs the
    // scheduler in a worker; `window` is undefined there.
    this.pollInterval = setInterval(() => this.checkTasks(), 60000);

    // Also check immediately
    this.checkTasks();

    log.info('Scheduler started');
  }

  /** Stop the scheduler */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.running = false;
    log.info('Scheduler stopped');
  }

  /** Create a new scheduled task */
  async createTask(
    groupFolder: string,
    prompt: string,
    scheduleType: ScheduledTask['scheduleType'],
    scheduleValue: string
  ): Promise<ScheduledTask> {
    const task: ScheduledTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      groupFolder,
      prompt,
      scheduleType,
      scheduleValue,
      status: 'active',
      nextRun: this.calculateNextRun(scheduleType, scheduleValue),
      lastRun: null,
      createdAt: new Date().toISOString(),
    };

    await db.saveTask(task);
    log.info('Task created', { id: task.id, groupFolder, scheduleType });
    return task;
  }

  /** Update a task */
  async updateTask(
    id: string,
    updates: Partial<Pick<ScheduledTask, 'prompt' | 'scheduleType' | 'scheduleValue' | 'status'>>
  ): Promise<ScheduledTask | null> {
    const task = await db.getTask(id);
    if (!task) return null;

    const updated: ScheduledTask = {
      ...task,
      ...updates,
    };

    // Recalculate next run if schedule changed
    if (updates.scheduleType || updates.scheduleValue) {
      updated.nextRun = this.calculateNextRun(updated.scheduleType, updated.scheduleValue);
    }

    await db.saveTask(updated);
    log.info('Task updated', { id, updates: Object.keys(updates) });
    return updated;
  }

  /** Pause a task */
  async pauseTask(id: string): Promise<boolean> {
    const task = await this.updateTask(id, { status: 'paused' });
    return task !== null;
  }

  /** Resume a task */
  async resumeTask(id: string): Promise<boolean> {
    const task = await db.getTask(id);
    if (!task) return false;

    await this.updateTask(id, {
      status: 'active',
    });
    return true;
  }

  /** Delete a task */
  async deleteTask(id: string): Promise<boolean> {
    const task = await db.getTask(id);
    if (!task) return false;

    await db.deleteTask(id);
    log.info('Task deleted', { id });
    return true;
  }

  /** Get all tasks for a scoop */
  async getTasksByScoop(scoopFolder: string): Promise<ScheduledTask[]> {
    const allTasks = await db.getAllTasks();
    return allTasks.filter((t) => t.groupFolder === scoopFolder);
  }

  /** Get all tasks */
  async getAllTasks(): Promise<ScheduledTask[]> {
    return db.getAllTasks();
  }

  /** Check and run due tasks */
  private async checkTasks(): Promise<void> {
    const tasks = await db.getAllTasks();
    const now = new Date();

    for (const task of tasks) {
      if (task.status !== 'active') continue;
      if (!task.nextRun) continue;

      const nextRun = new Date(task.nextRun);
      if (nextRun > now) continue;

      // Task is due - run it
      await this.runTask(task);
    }
  }

  /** Run a task */
  private async runTask(task: ScheduledTask): Promise<void> {
    const scoop = this.callbacks.getScoop(task.groupFolder);
    if (!scoop) {
      log.warn('Task scoop not found', { taskId: task.id, groupFolder: task.groupFolder });
      return;
    }

    log.info('Running task', { id: task.id, groupFolder: task.groupFolder });

    try {
      // Update last run and calculate next run
      const now = new Date().toISOString();
      const nextRun = this.calculateNextRun(task.scheduleType, task.scheduleValue);

      // For one-time tasks, mark as completed
      const status = task.scheduleType === 'once' ? 'completed' : task.status;

      await db.saveTask({
        ...task,
        lastRun: now,
        nextRun,
        status,
      });

      // Execute the task
      await this.callbacks.onTaskRun(task, scoop);

      log.info('Task completed', { id: task.id });
    } catch (err) {
      log.error('Task execution failed', {
        id: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Calculate the next run time for a task */
  private calculateNextRun(
    scheduleType: ScheduledTask['scheduleType'],
    scheduleValue: string
  ): string | null {
    const now = new Date();

    switch (scheduleType) {
      case 'cron': {
        const next = this.getNextCronTime(scheduleValue, now);
        return next?.toISOString() ?? null;
      }

      case 'interval': {
        const ms = parseInt(scheduleValue, 10);
        if (isNaN(ms) || ms <= 0) return null;
        return new Date(now.getTime() + ms).toISOString();
      }

      case 'once': {
        const target = new Date(scheduleValue);
        return target > now ? scheduleValue : null;
      }

      default:
        return null;
    }
  }

  /** Parse a cron expression and get the next run time */
  private getNextCronTime(cron: string, from: Date): Date | null {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    const next = new Date(from);
    next.setSeconds(0);
    next.setMilliseconds(0);
    next.setMinutes(next.getMinutes() + 1);

    for (let i = 0; i < 527040; i++) {
      if (this.cronMatches(next, minute, hour, dayOfMonth, month, dayOfWeek)) {
        return next;
      }
      next.setMinutes(next.getMinutes() + 1);
    }

    return null;
  }

  /** Check if a date matches cron fields */
  private cronMatches(
    date: Date,
    minute: string,
    hour: string,
    dayOfMonth: string,
    month: string,
    dayOfWeek: string
  ): boolean {
    return (
      this.cronFieldMatches(date.getMinutes(), minute) &&
      this.cronFieldMatches(date.getHours(), hour) &&
      this.cronFieldMatches(date.getDate(), dayOfMonth) &&
      this.cronFieldMatches(date.getMonth() + 1, month) &&
      this.cronFieldMatches(date.getDay(), dayOfWeek)
    );
  }

  /** Check if a value matches a cron field */
  private cronFieldMatches(value: number, field: string): boolean {
    if (field === '*') return true;

    if (field.includes(',')) {
      return field.split(',').some((f) => this.cronFieldMatches(value, f.trim()));
    }

    if (field.includes('-')) {
      const [start, end] = field.split('-').map((n) => parseInt(n, 10));
      return value >= start && value <= end;
    }

    if (field.includes('/')) {
      const [base, step] = field.split('/');
      const stepNum = parseInt(step, 10);
      if (base === '*') {
        return value % stepNum === 0;
      }
      const baseNum = parseInt(base, 10);
      return value >= baseNum && (value - baseNum) % stepNum === 0;
    }

    return parseInt(field, 10) === value;
  }
}
