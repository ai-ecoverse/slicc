/**
 * Scoop management tools - MCP-style tools for messaging and scoop management.
 *
 * These provide the same functionality as NanoClaw's IPC-based MCP server,
 * but implemented as direct agent tools.
 */

import type { ToolDefinition } from '../core/types.js';
import type { RegisteredScoop } from './types.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('scoop-management-tools');

export interface ScoopManagementToolsConfig {
  scoop: RegisteredScoop;
  onSendMessage: (text: string, sender?: string) => void;
  /** Feed a prompt to a specific scoop (cone only). */
  onFeedScoop?: (scoopJid: string, prompt: string) => Promise<void>;
  getScoops: () => RegisteredScoop[];
  /** Get tab state for a scoop by JID (status, lastActivity). */
  getScoopTabState?: (jid: string) => import('./types.js').ScoopTabState | undefined;
  onScoopScoop?: (scoop: Omit<RegisteredScoop, 'jid'>) => Promise<RegisteredScoop>;
  onDropScoop?: (scoopJid: string) => Promise<void>;
  onSetGlobalMemory?: (content: string) => Promise<void>;
  getGlobalMemory?: () => Promise<string>;
}

/**
 * Create scoop-management tools for a scoop context
 */
export function createScoopManagementTools(config: ScoopManagementToolsConfig): ToolDefinition[] {
  const {
    scoop,
    onSendMessage,
    onFeedScoop,
    getScoops,
    getScoopTabState,
    onScoopScoop,
    onDropScoop,
    onSetGlobalMemory,
    getGlobalMemory,
  } = config;

  const tools: ToolDefinition[] = [];

  // send_message tool
  tools.push({
    name: 'send_message',
    description: `Send a progress message while still working. Your final output is also sent.`,
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The message text to send',
        },
        sender: {
          type: 'string',
          description:
            'Optional sender name/role (e.g., "Researcher"). Defaults to assistant name.',
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
      description: `Give a scoop a task. Provide a complete, self-contained prompt — the scoop has no access to your conversation. You'll be notified when it finishes.`,
      inputSchema: {
        type: 'object',
        properties: {
          scoop_name: {
            type: 'string',
            description:
              'The scoop folder name (e.g., "test-scoop"). Use list_scoops to see available scoops.',
          },
          prompt: {
            type: 'string',
            description:
              'Complete, self-contained instructions for the scoop. Include ALL context — the scoop cannot see your conversation.',
          },
        },
        required: ['scoop_name', 'prompt'],
      },
      execute: async (input) => {
        const { scoop_name, prompt } = input as { scoop_name: string; prompt: string };
        const target = getScoops().find((s) => s.folder === scoop_name || s.name === scoop_name);
        if (!target) {
          const available = getScoops()
            .filter((s) => !s.isCone)
            .map((s) => s.folder)
            .join(', ');
          return {
            content: `Scoop "${scoop_name}" not found. Available: ${available}`,
            isError: true,
          };
        }
        if (target.isCone) {
          return { content: 'Cannot feed the cone (yourself).', isError: true };
        }
        try {
          await onFeedScoop(target.jid, prompt);
          log.info('Fed scoop', { target: target.folder, promptLength: prompt.length });
          return {
            content: `Task sent to ${target.folder}. You will be notified when it completes.`,
          };
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
          .map((s) => {
            const tab = getScoopTabState?.(s.jid);
            const status = tab?.status ?? 'unknown';
            const activity = tab?.lastActivity
              ? new Date(tab.lastActivity).toLocaleString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                })
              : '';
            const statusSuffix = activity ? ` — ${status} (since ${activity})` : ` — ${status}`;
            if (s.isCone) return `- ${s.assistantLabel} (${s.folder}) [CONE]${statusSuffix}`;
            return `- ${s.name} (${s.folder})${statusSuffix}`;
          })
          .join('\n');

        return { content: `Registered scoops:\n${formatted}` };
      },
    });

    // Cone only: scoop_scoop (formerly register_scoop)
    if (onScoopScoop) {
      tools.push({
        name: 'scoop_scoop',
        description:
          'Create a new scoop. Optionally specify a model and/or a prompt. If prompt is provided, the scoop starts working immediately after creation (no separate feed_scoop needed).',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Display name for the scoop (e.g., "hero-block")',
            },
            model: {
              type: 'string',
              description:
                'Model ID for this scoop (e.g., "claude-sonnet-4-6"). If omitted, uses the same model as the cone.',
            },
            prompt: {
              type: 'string',
              description:
                'Task prompt for the scoop. If provided, the scoop starts working immediately after creation.',
            },
          },
          required: ['name'],
        },
        execute: async (input) => {
          const {
            name,
            model,
            prompt: taskPrompt,
          } = input as { name: string; model?: string; prompt?: string };
          const folder =
            name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '')
              .slice(0, 50) + '-scoop';

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

            // If prompt provided, feed immediately and await the delegate
            // call so setup failures (e.g. db.saveMessage) surface to the
            // cone instead of being logged after a success response.
            // onFeedScoop → delegateToScoop awaits only the persistence +
            // prompt dispatch; the scoop's agent loop still runs
            // fire-and-forget in the background, so this doesn't block on
            // the LLM turn. The scoop's context is already initialized by
            // the time onScoopScoop resolves (orchestrator.registerScoop
            // awaits createScoopTab), so the prompt won't race init either.
            if (taskPrompt && onFeedScoop) {
              try {
                await onFeedScoop(newScoop.jid, taskPrompt);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.error('Auto-feed failed', { name, error: msg });
                return {
                  content:
                    `Scoop "${name}" created as "${folder}" but the initial task could not be sent: ${msg}. ` +
                    `Use feed_scoop to retry.`,
                  isError: true,
                };
              }
              return {
                content: `Scoop "${name}" created as "${folder}" and task sent. It is now working on it.`,
              };
            }

            return {
              content: `Scoop "${name}" created as "${folder}". Use feed_scoop to give it a task.`,
            };
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
        description:
          'Remove a scoop and stop its work. The scoop will be unregistered and its context destroyed.',
        inputSchema: {
          type: 'object',
          properties: {
            scoop_name: {
              type: 'string',
              description:
                'The scoop folder name (e.g., "test-scoop"). Use list_scoops to see available scoops.',
            },
          },
          required: ['scoop_name'],
        },
        execute: async (input) => {
          const { scoop_name } = input as { scoop_name: string };
          const target = getScoops().find((s) => s.folder === scoop_name || s.name === scoop_name);
          if (!target) {
            const available = getScoops()
              .filter((s) => !s.isCone)
              .map((s) => s.folder)
              .join(', ');
            return {
              content: `Scoop "${scoop_name}" not found. Available: ${available}`,
              isError: true,
            };
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
        description:
          'Update the global CLAUDE.md memory file that is shared across all scoops. Use this instead of write_file for /shared/CLAUDE.md.',
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
