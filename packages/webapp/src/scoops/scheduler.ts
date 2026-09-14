import { createLogger } from '../core/logger.js';
import { getNextCronTime } from './cron.js';
import * as db from './db.js';
import type { RegisteredScoop, ScheduledTask } from './types.js';

const log = createLogger('scheduler');

export interface SchedulerCallbacks {
  onTaskRun: (task: ScheduledTask, scoop: RegisteredScoop) => Promise<void>;

  getScoop: (folder: string) => RegisteredScoop | undefined;
}

export class TaskScheduler {
  private callbacks: SchedulerCallbacks;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(callbacks: SchedulerCallbacks) {
    this.callbacks = callbacks;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.pollInterval = setInterval(() => this.pollTasks(), 60000);

    this.pollTasks();

    log.info('Scheduler started');
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.running = false;
    log.info('Scheduler stopped');
  }

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

    if (updates.scheduleType || updates.scheduleValue) {
      updated.nextRun = this.calculateNextRun(updated.scheduleType, updated.scheduleValue);
    }

    await db.saveTask(updated);
    log.info('Task updated', { id, updates: Object.keys(updates) });
    return updated;
  }

  async pauseTask(id: string): Promise<boolean> {
    const task = await this.updateTask(id, { status: 'paused' });
    return task !== null;
  }

  async resumeTask(id: string): Promise<boolean> {
    const task = await db.getTask(id);
    if (!task) return false;

    await this.updateTask(id, {
      status: 'active',
    });
    return true;
  }

  async deleteTask(id: string): Promise<boolean> {
    const task = await db.getTask(id);
    if (!task) return false;

    await db.deleteTask(id);
    log.info('Task deleted', { id });
    return true;
  }

  async getTasksByScoop(scoopFolder: string): Promise<ScheduledTask[]> {
    const allTasks = await db.getAllTasks();
    return allTasks.filter((t) => t.groupFolder === scoopFolder);
  }

  async getAllTasks(): Promise<ScheduledTask[]> {
    return db.getAllTasks();
  }

  private pollTasks(): void {
    this.checkTasks().catch((err) => {
      log.error('Task poll failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async checkTasks(): Promise<void> {
    const tasks = await db.getAllTasks();
    const now = new Date();

    for (const task of tasks) {
      if (task.status !== 'active') continue;
      if (!task.nextRun) continue;

      const nextRun = new Date(task.nextRun);
      if (nextRun > now) continue;

      await this.runTask(task);
    }
  }

  private async runTask(task: ScheduledTask): Promise<void> {
    const scoop = this.callbacks.getScoop(task.groupFolder);
    if (!scoop) {
      log.warn('Task scoop not found', { taskId: task.id, groupFolder: task.groupFolder });
      return;
    }

    log.info('Running task', { id: task.id, groupFolder: task.groupFolder });

    try {
      const now = new Date().toISOString();
      const nextRun = this.calculateNextRun(task.scheduleType, task.scheduleValue);

      const status = task.scheduleType === 'once' ? 'completed' : task.status;

      await db.saveTask({
        ...task,
        lastRun: now,
        nextRun,
        status,
      });

      await this.callbacks.onTaskRun(task, scoop);

      log.info('Task completed', { id: task.id });
    } catch (err) {
      log.error('Task execution failed', {
        id: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private calculateNextRun(
    scheduleType: ScheduledTask['scheduleType'],
    scheduleValue: string
  ): string | null {
    const now = new Date();

    switch (scheduleType) {
      case 'cron': {
        const next = getNextCronTime(scheduleValue, now);
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
}
