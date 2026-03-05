/**
 * NanoClaw Tools - MCP-style tools for messaging and scheduling.
 *
 * These provide the same functionality as NanoClaw's IPC-based MCP server,
 * but implemented as direct agent tools.
 */

import type { ToolDefinition } from '../core/types.js';
import type { ScheduledTask, RegisteredScoop } from './types.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('nanoclaw-tools');

export interface NanoClawToolsConfig {
  scoop: RegisteredScoop;
  onSendMessage: (text: string, sender?: string) => void;
  /** Delegate a prompt to a specific scoop (cone only). */
  onDelegateToScoop?: (scoopJid: string, prompt: string) => Promise<void>;
  onScheduleTask: (task: Omit<ScheduledTask, 'id' | 'nextRun' | 'lastRun' | 'createdAt'>) => Promise<ScheduledTask>;
  onListTasks: () => Promise<ScheduledTask[]>;
  onPauseTask: (taskId: string) => Promise<boolean>;
  onResumeTask: (taskId: string) => Promise<boolean>;
  onCancelTask: (taskId: string) => Promise<boolean>;
  getScoops: () => RegisteredScoop[];
  onRegisterScoop?: (scoop: Omit<RegisteredScoop, 'jid'>) => Promise<RegisteredScoop>;
  onSetGlobalMemory?: (content: string) => Promise<void>;
  getGlobalMemory?: () => Promise<string>;
}

/**
 * Create NanoClaw-style tools for a scoop context
 */
export function createNanoClawTools(config: NanoClawToolsConfig): ToolDefinition[] {
  const { scoop, onSendMessage, onDelegateToScoop, onScheduleTask, onListTasks, onPauseTask, onResumeTask, onCancelTask, getScoops, onRegisterScoop, onSetGlobalMemory, getGlobalMemory } = config;

  const tools: ToolDefinition[] = [];

  // send_message tool
  tools.push({
    name: 'send_message',
    description: `Send a message immediately while you're still working. Use this for progress updates or to send multiple messages. Your final output is also sent to the user, so use this for interim updates.`,
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The message text to send',
        },
        sender: {
          type: 'string',
          description: 'Optional sender name/role (e.g., "Researcher"). Defaults to assistant name.',
        },
      },
      required: ['text'],
    },
    execute: async (input) => {
      const { text, sender } = input as { text: string; sender?: string };
      onSendMessage(text, sender);
      log.info('Message sent', { scoopFolder: scoop.folder, textLength: text.length });
      return { content: 'Message sent.' };
    },
  });

  // schedule_task tool
  tools.push({
    name: 'schedule_task',
    description: `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

SCHEDULE FORMAT:
- cron: Standard cron expression (e.g., "0 9 * * *" for daily at 9am, "*/5 * * * *" for every 5 min)
- interval: Milliseconds between runs (e.g., "300000" for 5 minutes)
- once: ISO timestamp for one-time execution (e.g., "2025-12-25T09:00:00")`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What the agent should do when the task runs',
        },
        schedule_type: {
          type: 'string',
          enum: ['cron', 'interval', 'once'],
          description: 'Type of schedule',
        },
        schedule_value: {
          type: 'string',
          description: 'cron expression, milliseconds, or ISO timestamp',
        },
      },
      required: ['prompt', 'schedule_type', 'schedule_value'],
    },
    execute: async (input) => {
      const { prompt, schedule_type, schedule_value } = input as {
        prompt: string;
        schedule_type: 'cron' | 'interval' | 'once';
        schedule_value: string;
      };

      try {
        const task = await onScheduleTask({
          groupFolder: scoop.folder,
          prompt,
          scheduleType: schedule_type,
          scheduleValue: schedule_value,
          status: 'active',
        });

        log.info('Task scheduled', { taskId: task.id, type: schedule_type });
        return {
          content: `Task scheduled (${task.id}): ${schedule_type} - ${schedule_value}
Next run: ${task.nextRun || 'calculating...'}`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `Failed to schedule task: ${msg}`, isError: true };
      }
    },
  });

  // list_tasks tool
  tools.push({
    name: 'list_tasks',
    description: 'List all scheduled tasks for this scoop.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const tasks = await onListTasks();
      const scoopTasks = tasks.filter(t => t.groupFolder === scoop.folder);

      if (scoopTasks.length === 0) {
        return { content: 'No scheduled tasks found.' };
      }

      const formatted = scoopTasks
        .map(t => `- [${t.id}] ${t.prompt.slice(0, 50)}${t.prompt.length > 50 ? '...' : ''} (${t.scheduleType}: ${t.scheduleValue}) - ${t.status}, next: ${t.nextRun || 'N/A'}`)
        .join('\n');

      return { content: `Scheduled tasks:\n${formatted}` };
    },
  });

  // pause_task tool
  tools.push({
    name: 'pause_task',
    description: 'Pause a scheduled task. It will not run until resumed.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The task ID to pause',
        },
      },
      required: ['task_id'],
    },
    execute: async (input) => {
      const { task_id } = input as { task_id: string };
      const success = await onPauseTask(task_id);

      if (success) {
        log.info('Task paused', { taskId: task_id });
        return { content: `Task ${task_id} paused.` };
      }
      return { content: `Task ${task_id} not found.`, isError: true };
    },
  });

  // resume_task tool
  tools.push({
    name: 'resume_task',
    description: 'Resume a paused task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The task ID to resume',
        },
      },
      required: ['task_id'],
    },
    execute: async (input) => {
      const { task_id } = input as { task_id: string };
      const success = await onResumeTask(task_id);

      if (success) {
        log.info('Task resumed', { taskId: task_id });
        return { content: `Task ${task_id} resumed.` };
      }
      return { content: `Task ${task_id} not found.`, isError: true };
    },
  });

  // cancel_task tool
  tools.push({
    name: 'cancel_task',
    description: 'Cancel and delete a scheduled task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The task ID to cancel',
        },
      },
      required: ['task_id'],
    },
    execute: async (input) => {
      const { task_id } = input as { task_id: string };
      const success = await onCancelTask(task_id);

      if (success) {
        log.info('Task cancelled', { taskId: task_id });
        return { content: `Task ${task_id} cancelled.` };
      }
      return { content: `Task ${task_id} not found.`, isError: true };
    },
  });

  // Cone only: delegate_to_scoop
  if (scoop.isCone && onDelegateToScoop) {
    tools.push({
      name: 'delegate_to_scoop',
      description: `Delegate a task to a scoop. You MUST provide a complete, self-contained prompt — the scoop has NO access to your conversation history. Include all necessary context, instructions, file paths, URLs, and expected output format. The scoop will work independently and you'll be notified when it finishes.`,
      inputSchema: {
        type: 'object',
        properties: {
          scoop_name: {
            type: 'string',
            description: 'The scoop folder name (e.g., "test-scoop"). Use list_scoops to see available scoops.',
          },
          prompt: {
            type: 'string',
            description: 'Complete, self-contained instructions for the scoop. Include ALL context — the scoop cannot see your conversation.',
          },
        },
        required: ['scoop_name', 'prompt'],
      },
      execute: async (input) => {
        const { scoop_name, prompt } = input as { scoop_name: string; prompt: string };
        const target = getScoops().find(s => s.folder === scoop_name || s.name === scoop_name);
        if (!target) {
          const available = getScoops().filter(s => !s.isCone).map(s => s.folder).join(', ');
          return { content: `Scoop "${scoop_name}" not found. Available: ${available}`, isError: true };
        }
        if (target.isCone) {
          return { content: 'Cannot delegate to the cone (yourself).', isError: true };
        }
        try {
          await onDelegateToScoop(target.jid, prompt);
          log.info('Delegated to scoop', { target: target.folder, promptLength: prompt.length });
          return { content: `Task delegated to ${target.folder}. You will be notified when it completes.` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: `Failed to delegate: ${msg}`, isError: true };
        }
      },
    });
  }

  // Cone only: list_scoops
  if (scoop.isCone) {
    tools.push({
      name: 'list_scoops',
      description: 'List all registered scoops. Cone only.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      execute: async () => {
        const scoops = getScoops();

        if (scoops.length === 0) {
          return { content: 'No scoops registered.' };
        }

        const formatted = scoops
          .map(s => {
            if (s.isCone) return `- ${s.assistantLabel} (${s.folder}) [CONE]`;
            return `- ${s.name} (${s.folder}) - ${s.trigger || `@${s.assistantLabel}`}`;
          })
          .join('\n');

        return { content: `Registered scoops:\n${formatted}` };
      },
    });

    // Cone only: register_scoop
    if (onRegisterScoop) {
      tools.push({
        name: 'register_scoop',
        description: 'Register a new scoop. Cone only.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Display name for the scoop (e.g., "Andy")',
            },
          },
          required: ['name'],
        },
        execute: async (input) => {
          const { name } = input as { name: string };
          const folder = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) + '-scoop';

          try {
            const newScoop = await onRegisterScoop({
              name,
              folder,
              trigger: `@${folder}`,
              isCone: false,
              type: 'scoop',
              requiresTrigger: true,
              assistantLabel: folder,
              addedAt: new Date().toISOString(),
            });

            log.info('Scoop registered', { name, folder });
            return { content: `Scoop "${name}" registered as "${folder}".` };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: `Failed to register scoop: ${msg}`, isError: true };
          }
        },
      });
    }

    // Cone only: update_global_memory
    if (onSetGlobalMemory && getGlobalMemory) {
      tools.push({
        name: 'update_global_memory',
        description: 'Update the global CLAUDE.md memory file that is shared across all scoops. Cone only. Use this instead of write_file for /shared/CLAUDE.md.',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The new content for the global memory file',
            },
          },
          required: ['content'],
        },
        execute: async (input) => {
          const { content } = input as { content: string };
          try {
            await onSetGlobalMemory(content);
            log.info('Global memory updated');
            return { content: 'Global memory updated successfully.' };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: `Failed to update global memory: ${msg}`, isError: true };
          }
        },
      });
    }
  }

  return tools;
}
