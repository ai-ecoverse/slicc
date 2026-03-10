/**
 * NanoClaw Tools - MCP-style tools for messaging and scoop management.
 *
 * These provide the same functionality as NanoClaw's IPC-based MCP server,
 * but implemented as direct agent tools.
 */

import type { ToolDefinition } from '../core/types.js';
import type { RegisteredScoop } from './types.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('nanoclaw-tools');

export interface NanoClawToolsConfig {
  scoop: RegisteredScoop;
  onSendMessage: (text: string, sender?: string) => void;
  /** Feed a prompt to a specific scoop (cone only). */
  onFeedScoop?: (scoopJid: string, prompt: string) => Promise<void>;
  getScoops: () => RegisteredScoop[];
  onScoopScoop?: (scoop: Omit<RegisteredScoop, 'jid'>) => Promise<RegisteredScoop>;
  onDropScoop?: (scoopJid: string) => Promise<void>;
  onSetGlobalMemory?: (content: string) => Promise<void>;
  getGlobalMemory?: () => Promise<string>;
}

/**
 * Create NanoClaw-style tools for a scoop context
 */
export function createNanoClawTools(config: NanoClawToolsConfig): ToolDefinition[] {
  const { scoop, onSendMessage, onFeedScoop, getScoops, onScoopScoop, onDropScoop, onSetGlobalMemory, getGlobalMemory } = config;

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

  // Cone only: feed_scoop (formerly delegate_to_scoop)
  if (scoop.isCone && onFeedScoop) {
    tools.push({
      name: 'feed_scoop',
      description: `Give a scoop a task and activate it. You MUST provide a complete, self-contained prompt — the scoop has NO access to your conversation history. Include all necessary context, instructions, file paths, URLs, and expected output format. The scoop will work independently and you'll be notified when it finishes.`,
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
          return { content: 'Cannot feed the cone (yourself).', isError: true };
        }
        try {
          await onFeedScoop(target.jid, prompt);
          log.info('Fed scoop', { target: target.folder, promptLength: prompt.length });
          return { content: `Task sent to ${target.folder}. You will be notified when it completes.` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: `Failed to feed scoop: ${msg}`, isError: true };
        }
      },
    });
  }

  // Cone only: list_scoops
  if (scoop.isCone) {
    tools.push({
      name: 'list_scoops',
      description: 'List all registered scoops.',
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
            return `- ${s.name} (${s.folder})`;
          })
          .join('\n');

        return { content: `Registered scoops:\n${formatted}` };
      },
    });

    // Cone only: scoop_scoop (formerly register_scoop)
    if (onScoopScoop) {
      tools.push({
        name: 'scoop_scoop',
        description: 'Create a new scoop. The scoop will be registered but not activated — use feed_scoop to give it a task. Optionally specify a model (e.g., "claude-sonnet-4-20250514") to use a different model than the cone.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Display name for the scoop (e.g., "Andy")',
            },
            model: {
              type: 'string',
              description: 'Model ID for this scoop (e.g., "claude-sonnet-4-20250514"). If omitted, uses the same model as the cone.',
            },
          },
          required: ['name'],
        },
        execute: async (input) => {
          const { name, model } = input as { name: string; model?: string };
          const folder = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) + '-scoop';

          try {
            const newScoop = await onScoopScoop({
              name,
              folder,
              trigger: `@${folder}`,
              isCone: false,
              type: 'scoop',
              requiresTrigger: true,
              assistantLabel: folder,
              addedAt: new Date().toISOString(),
              config: model ? { modelId: model } : undefined,
            });

            log.info('Scoop created', { name, folder });
            return { content: `Scoop "${name}" created as "${folder}". Use feed_scoop to give it a task.` };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: `Failed to create scoop: ${msg}`, isError: true };
          }
        },
      });
    }

    // Cone only: drop_scoop
    if (onDropScoop) {
      tools.push({
        name: 'drop_scoop',
        description: 'Remove a scoop and stop its work. The scoop will be unregistered and its context destroyed.',
        inputSchema: {
          type: 'object',
          properties: {
            scoop_name: {
              type: 'string',
              description: 'The scoop folder name (e.g., "test-scoop"). Use list_scoops to see available scoops.',
            },
          },
          required: ['scoop_name'],
        },
        execute: async (input) => {
          const { scoop_name } = input as { scoop_name: string };
          const target = getScoops().find(s => s.folder === scoop_name || s.name === scoop_name);
          if (!target) {
            const available = getScoops().filter(s => !s.isCone).map(s => s.folder).join(', ');
            return { content: `Scoop "${scoop_name}" not found. Available: ${available}`, isError: true };
          }
          if (target.isCone) {
            return { content: 'Cannot drop the cone (yourself).', isError: true };
          }
          try {
            await onDropScoop(target.jid);
            log.info('Scoop dropped', { name: target.name, folder: target.folder });
            return { content: `Scoop "${target.name}" (${target.folder}) has been dropped.` };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: `Failed to drop scoop: ${msg}`, isError: true };
          }
        },
      });
    }

    // Cone only: update_global_memory
    if (onSetGlobalMemory && getGlobalMemory) {
      tools.push({
        name: 'update_global_memory',
        description: 'Update the global CLAUDE.md memory file that is shared across all scoops. Use this instead of write_file for /shared/CLAUDE.md.',
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
