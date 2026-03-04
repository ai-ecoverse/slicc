/**
 * NanoClaw Tools - MCP-style tools for messaging and scheduling.
 * 
 * These provide the same functionality as NanoClaw's IPC-based MCP server,
 * but implemented as direct agent tools.
 */

import type { ToolDefinition } from '../core/types.js';
import type { ScheduledTask, RegisteredGroup } from './types.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('nanoclaw-tools');

export interface NanoClawToolsConfig {
  group: RegisteredGroup;
  onSendMessage: (text: string, sender?: string) => void;
  onScheduleTask: (task: Omit<ScheduledTask, 'id' | 'nextRun' | 'lastRun' | 'createdAt'>) => Promise<ScheduledTask>;
  onListTasks: () => Promise<ScheduledTask[]>;
  onPauseTask: (taskId: string) => Promise<boolean>;
  onResumeTask: (taskId: string) => Promise<boolean>;
  onCancelTask: (taskId: string) => Promise<boolean>;
  getGroups: () => RegisteredGroup[];
  onRegisterGroup?: (group: Omit<RegisteredGroup, 'jid'>) => Promise<RegisteredGroup>;
  onSetGlobalMemory?: (content: string) => Promise<void>;
  getGlobalMemory?: () => Promise<string>;
}

/**
 * Create NanoClaw-style tools for a group context
 */
export function createNanoClawTools(config: NanoClawToolsConfig): ToolDefinition[] {
  const { group, onSendMessage, onScheduleTask, onListTasks, onPauseTask, onResumeTask, onCancelTask, getGroups, onRegisterGroup, onSetGlobalMemory, getGlobalMemory } = config;

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
      log.info('Message sent', { groupFolder: group.folder, textLength: text.length });
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
          groupFolder: group.folder,
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
    description: 'List all scheduled tasks for this group.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const tasks = await onListTasks();
      const groupTasks = tasks.filter(t => t.groupFolder === group.folder);

      if (groupTasks.length === 0) {
        return { content: 'No scheduled tasks found.' };
      }

      const formatted = groupTasks
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

  // Main group only: list_groups
  if (group.isMain) {
    tools.push({
      name: 'list_groups',
      description: 'List all registered groups. Main group only.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      execute: async () => {
        const groups = getGroups();
        
        if (groups.length === 0) {
          return { content: 'No groups registered.' };
        }

        const formatted = groups
          .map(g => `- ${g.name} (${g.folder})${g.isMain ? ' [MAIN]' : ''} - ${g.trigger || '@Andy'}`)
          .join('\n');

        return { content: `Registered groups:\n${formatted}` };
      },
    });

    // Main group only: register_group
    if (onRegisterGroup) {
      tools.push({
        name: 'register_group',
        description: 'Register a new group. Main group only.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Display name for the group',
            },
            folder: {
              type: 'string',
              description: 'Folder name for the group (e.g., "web_my-group")',
            },
            trigger: {
              type: 'string',
              description: 'Trigger word (e.g., "@Andy")',
            },
          },
          required: ['name', 'folder'],
        },
        execute: async (input) => {
          const { name, folder, trigger } = input as { name: string; folder: string; trigger?: string };
          
          try {
            const newGroup = await onRegisterGroup({
              name,
              folder,
              trigger: trigger || '@Andy',
              isMain: false,
              requiresTrigger: true,
              addedAt: new Date().toISOString(),
            });

            log.info('Group registered', { name, folder });
            return { content: `Group "${name}" registered with folder "${folder}".` };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: `Failed to register group: ${msg}`, isError: true };
          }
        },
      });
    }

    // Main group only: update_global_memory
    if (onSetGlobalMemory && getGlobalMemory) {
      tools.push({
        name: 'update_global_memory',
        description: 'Update the global CLAUDE.md memory file that is shared across all groups. Main group only. Use this instead of write_file for /workspace/global/CLAUDE.md.',
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
