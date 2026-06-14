/**
 * Scoop management tools - MCP-style tools for messaging and scoop management.
 *
 * These provide the same functionality as NanoClaw's IPC-based MCP server,
 * but implemented as direct agent tools.
 */

import { createLogger } from '../core/logger.js';
import type { ToolDefinition } from '../core/types.js';
import type { SudoDecision, SudoKind, SudoRequest } from '../sudo/types.js';
import {
  CURRENT_SCOOP_CONFIG_VERSION,
  isThinkingLevel,
  type RegisteredScoop,
  THINKING_LEVELS,
  type ThinkingLevel,
} from './types.js';

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
  /** Mute a list of scoops so their completions are suppressed (cone only). */
  onMuteScoops?: (jids: readonly string[]) => void;
  /** Unmute scoops and return any stashed completions so the tool can
   *  fold them into its result instead of re-firing them as new lick
   *  events (cone only). */
  onUnmuteScoops?: (
    jids: readonly string[]
  ) => Promise<
    Array<{ jid: string; summary: string; timestamp: string; notificationPath: string | null }>
  >;
  /** Schedule a non-blocking wait for a list of scoops to complete.
   *  Returns synchronously; when the wait resolves (every listed scoop
   *  completes or the timeout fires) the orchestrator delivers a
   *  `scoop-wait` channel lick to the cone with the per-scoop summary.
   *  Cone only. */
  onScheduleScoopWait?: (
    jids: readonly string[],
    timeoutMs?: number
  ) => { scheduled: string[]; unknown: string[] };
  /** Scoop-only: ask the cone for an explicit sudo escalation. */
  onSudoRequest?: (request: SudoRequest) => Promise<SudoDecision>;
  /** Cone-only: resolve a pending sudo request by id. On `'always'` the
   *  orchestrator persists a NOPASSWD rule into the requesting scoop's
   *  `/scoops/<folder>/etc/sudoers` via the trusted manager sink. */
  onSudoResolve?: (
    id: string,
    decision: SudoDecision
  ) => Promise<{
    settled: boolean;
    persisted: boolean;
    persistedPattern?: string;
    persistError?: string;
    scoopFolder?: string;
    kind?: SudoKind;
  }>;
  /** Cone-only: snapshot all pending cone-mediated sudo requests. */
  onListSudoRequests?: () => Array<{
    id: string;
    scoopJid: string;
    request: SudoRequest;
  }>;
}

/** Resolve a list of user-supplied scoop names (folder or display name) to
 *  registered scoop records. Returns the resolved scoops plus any unknown
 *  names so the tool can surface a helpful error without bailing out on the
 *  first miss. Cones are rejected — they can't be muted / waited on. */
function resolveScoopNames(
  names: readonly string[],
  getScoops: () => RegisteredScoop[]
): { resolved: RegisteredScoop[]; unknown: string[] } {
  const all = getScoops();
  const resolved: RegisteredScoop[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const s = all.find((x) => !x.isCone && (x.folder === name || x.name === name));
    if (s) resolved.push(s);
    else unknown.push(name);
  }
  return { resolved, unknown };
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
    onMuteScoops,
    onUnmuteScoops,
    onScheduleScoopWait,
    onSudoRequest,
    onSudoResolve,
    onListSudoRequests,
  } = config;

  const SUDO_KINDS: readonly SudoKind[] = ['command', 'read', 'write', 'secret'];

  const tools: ToolDefinition[] = [];

  // send_message tool — scoop-only. It's the scoop→cone progress/result
  // channel; the cone has no parent to message and its assistant output
  // already reaches the UI directly.
  if (!scoop.isCone) {
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
  }

  // sudo_request tool — scoop-only. Explicit escalation request to the cone.
  // The cone is responsible for resolving the request via sudo_allow / sudo_deny;
  // this call blocks until a decision is made (or the registry times out
  // fail-closed). Absent on the cone — the cone IS the approver and uses the
  // user broker directly via its FS / shell gates.
  if (!scoop.isCone && onSudoRequest) {
    tools.push({
      name: 'sudo_request',
      description:
        "Ask the cone for an explicit sudo escalation before running a sensitive action. Use this when you know up-front that a command, read, or write will be gated and you want a clean approval round-trip instead of letting the gate fire mid-action. Resolves with the cone's decision (allow / always / deny). 'always' durably widens your sandbox by appending a NOPASSWD rule to /scoops/<folder>/etc/sudoers. 'deny' (or a timeout / dropped cone) resolves fail-closed.",
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: [...SUDO_KINDS],
            description:
              'The kind of sensitive action being requested. command = a shell command; read/write = a VFS path; secret = a credential read. Only command/read/write can be persisted with "always" (no sudoers Secret directive).',
          },
          detail: {
            type: 'string',
            description:
              'The concrete subject of the request (e.g., the command line "git push origin main" or the VFS path "/workspace/.git/config"). The cone sees this verbatim.',
          },
          suggested_pattern: {
            type: 'string',
            description:
              'Optional pre-filled glob pattern for an "always" grant (e.g., "git push*" for a command or "/workspace/.git/**" for a path). The cone may override this.',
          },
        },
        required: ['kind', 'detail'],
      },
      execute: async (input) => {
        const {
          kind,
          detail,
          suggested_pattern: suggestedPattern,
        } = input as {
          kind: string;
          detail: string;
          suggested_pattern?: string;
        };
        if (!SUDO_KINDS.includes(kind as SudoKind)) {
          return {
            content: `Invalid sudo kind "${kind}". Must be one of: ${SUDO_KINDS.join(', ')}.`,
            isError: true,
          };
        }
        if (typeof detail !== 'string' || detail.trim().length === 0) {
          return { content: 'detail must be a non-empty string.', isError: true };
        }
        const request: SudoRequest = {
          kind: kind as SudoKind,
          detail,
          ...(suggestedPattern ? { suggestedPattern } : {}),
        };
        try {
          const decision = await onSudoRequest(request);
          log.info('Sudo request resolved', {
            scoopFolder: scoop.folder,
            kind: request.kind,
            decision: decision.decision,
          });
          const lines = [`Cone decision: ${decision.decision}.`];
          if (decision.decision === 'always' && decision.pattern) {
            lines.push(`Persisted pattern: ${decision.pattern}`);
          }
          if (decision.decision === 'deny') {
            lines.push(
              'The sensitive action was not approved. Do not retry without addressing the reason for refusal.'
            );
          }
          return { content: lines.join('\n') };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: `sudo_request failed: ${msg}`, isError: true };
        }
      },
    });
  }

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
          'Create a new scoop. Optionally specify a model, a prompt, and per-scoop sandbox shape (visible/writable paths + command allow-list). If prompt is provided, the scoop starts working immediately after creation (no separate feed_scoop needed).',
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
            visiblePaths: {
              type: 'array',
              items: { type: 'string' },
              description:
                'VFS paths the scoop can READ (not write). Pure replace — what you set is what you get. Omit to use the default ["/workspace/"] which exposes the shared skills tree. Pass [] for no extra read-only paths. Note: the scoop\'s writablePaths are always readable too, so a true read-nothing sandbox also requires writablePaths: []. Mounts remain readable regardless. Trailing slash recommended (e.g. "/shared/data/").',
            },
            writablePaths: {
              type: 'array',
              items: { type: 'string' },
              description:
                'VFS paths the scoop can READ AND WRITE. Pure replace. Omit to use the default ["/scoops/<folder>/", "/shared/"] which gives the scoop its own sandbox plus shared space. Pass [] to block all writes. Trailing slash recommended.',
            },
            allowedCommands: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Shell command allow-list. Omit for unrestricted access to every built-in, custom, and .jsh command (the default). Pass a list of command names to restrict the scoop\'s shell — e.g. ["echo","cat","grep"] for a read-only text-processing scoop. Pass ["*"] for explicit unrestricted. Applies to pipelines, substitutions, and network commands too.',
            },
            thinking: {
              type: 'string',
              enum: [...THINKING_LEVELS],
              description:
                'Reasoning / thinking-level for this scoop (pi-ai effort). One of: off, minimal, low, medium, high, xhigh. Omit to inherit the global default ("off"). Non-reasoning models always clamp to "off"; "xhigh" clamps to "high" on models that do not support the max tier.',
            },
          },
          required: ['name'],
        },
        execute: async (input) => {
          const {
            name,
            model,
            prompt: taskPrompt,
            visiblePaths,
            writablePaths,
            allowedCommands,
            thinking,
          } = input as {
            name: string;
            model?: string;
            prompt?: string;
            visiblePaths?: string[];
            writablePaths?: string[];
            allowedCommands?: string[];
            thinking?: string;
          };

          // Validate thinking level eagerly so the cone gets a tight error
          // message instead of a silently-dropped value. Mirrors the
          // validation done by `agent-bridge.ts` and `agent-command.ts`.
          let thinkingLevel: ThinkingLevel | undefined;
          if (thinking !== undefined) {
            if (!isThinkingLevel(thinking)) {
              return {
                content: `Invalid thinking level "${thinking}". Must be one of: ${THINKING_LEVELS.join(', ')}.`,
                isError: true,
              };
            }
            thinkingLevel = thinking;
          }
          const folder =
            name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '')
              .slice(0, 50) + '-scoop';

          try {
            // Scoop sandbox shape — the cone can override any of these three
            // via tool input. Defaults are applied here (not in the
            // orchestrator) so the `ScoopConfig` surface stays pure-replace:
            // what you set is what you get. Stamping `configSchemaVersion`
            // tells the orchestrator this record has explicit config and
            // skips the compat migration on restore.
            const newScoop = await onScoopScoop({
              name,
              folder,
              trigger: `@${folder}`,
              isCone: false,
              type: 'scoop',
              requiresTrigger: true,
              assistantLabel: folder,
              addedAt: new Date().toISOString(),
              config: {
                ...(model ? { modelId: model } : {}),
                visiblePaths: visiblePaths ?? ['/workspace/'],
                writablePaths: writablePaths ?? [`/scoops/${folder}/`, '/shared/'],
                ...(allowedCommands ? { allowedCommands } : {}),
                ...(thinkingLevel ? { thinkingLevel } : {}),
              },
              configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
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

    // Cone only: scoop_mute — suspend completion notifications from the
    // listed scoops so they don't trigger cone turns while parallel work
    // is in flight. Completions are stashed and flushed on scoop_unmute.
    if (onMuteScoops) {
      tools.push({
        name: 'scoop_mute',
        description:
          "Suspend scoop→cone notifications for the given scoops. While muted, a scoop's completion is stashed and will be delivered to the cone when you call scoop_unmute (or scoop_wait which consumes it). Use this when coordinating parallel work so each scoop's completion does not trigger its own cone turn.",
        inputSchema: {
          type: 'object',
          properties: {
            scoop_names: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Folder or display names of scoops to mute (e.g., ["writer-scoop", "reviewer-scoop"]).',
            },
          },
          required: ['scoop_names'],
        },
        execute: async (input) => {
          const { scoop_names } = input as { scoop_names: string[] };
          if (!Array.isArray(scoop_names) || scoop_names.length === 0) {
            return { content: 'scoop_names must be a non-empty array.', isError: true };
          }
          const { resolved, unknown } = resolveScoopNames(scoop_names, getScoops);
          if (resolved.length === 0) {
            return {
              content: `No matching scoops found. Unknown: ${unknown.join(', ')}`,
              isError: true,
            };
          }
          onMuteScoops(resolved.map((s) => s.jid));
          log.info('Scoops muted', { names: resolved.map((s) => s.folder) });
          const muted = resolved.map((s) => s.folder).join(', ');
          const warn = unknown.length > 0 ? ` (unknown: ${unknown.join(', ')})` : '';
          return { content: `Muted: ${muted}${warn}` };
        },
      });
    }

    // Cone only: scoop_unmute — resume notifications AND claim any
    // completion that landed while the scoop was muted. The stashed
    // summaries are returned in THIS tool's result so the cone can read
    // them in the current turn; they are NOT re-fired as fresh
    // scoop-notify events (which would generate a new cone turn and
    // defeat the whole point of muting in the first place).
    if (onUnmuteScoops) {
      tools.push({
        name: 'scoop_unmute',
        description:
          'Resume scoop→cone notifications for the given scoops. Any completion that landed while a scoop was muted is returned in this tool result (NOT dispatched as a new cone turn), so you can read all stashed summaries in the current turn. Scoops with no stashed completion are simply unmuted.',
        inputSchema: {
          type: 'object',
          properties: {
            scoop_names: {
              type: 'array',
              items: { type: 'string' },
              description: 'Folder or display names of scoops to unmute (e.g., ["writer-scoop"]).',
            },
          },
          required: ['scoop_names'],
        },
        execute: async (input) => {
          const { scoop_names } = input as { scoop_names: string[] };
          if (!Array.isArray(scoop_names) || scoop_names.length === 0) {
            return { content: 'scoop_names must be a non-empty array.', isError: true };
          }
          const { resolved, unknown } = resolveScoopNames(scoop_names, getScoops);
          if (resolved.length === 0) {
            return {
              content: `No matching scoops found. Unknown: ${unknown.join(', ')}`,
              isError: true,
            };
          }
          const jids = resolved.map((s) => s.jid);
          const jidToFolder = new Map(resolved.map((s) => [s.jid, s.folder]));
          const consumed = await onUnmuteScoops(jids);
          log.info('Scoops unmuted', {
            names: resolved.map((s) => s.folder),
            stashedCount: consumed.length,
          });

          const unmutedFolders = resolved.map((s) => s.folder).join(', ');
          const warn = unknown.length > 0 ? ` (unknown: ${unknown.join(', ')})` : '';
          const lines: string[] = [`Unmuted: ${unmutedFolders}${warn}`];
          if (consumed.length === 0) {
            lines.push('No stashed completions.');
          } else {
            lines.push('', 'Stashed completions:');
            for (const entry of consumed) {
              const folder = jidToFolder.get(entry.jid) ?? entry.jid;
              lines.push(`--- ${folder} ---`);
              if (entry.notificationPath) {
                lines.push(`VFS path: ${entry.notificationPath}`);
              }
              lines.push(entry.summary);
            }
          }
          return { content: lines.join('\n') };
        },
      });
    }

    // Cone only: scoop_wait — schedule a NON-BLOCKING wait for a set of
    // scoops. The tool returns immediately so the cone can keep working;
    // when all listed scoops complete (or the optional timeout expires)
    // the orchestrator delivers a `scoop-wait` channel lick to the cone
    // with each scoop's summary. Target scoops are implicitly muted for
    // the duration so individual `scoop-notify` events don't fire on top
    // of the eventual `scoop-wait` lick.
    if (onScheduleScoopWait) {
      tools.push({
        name: 'scoop_wait',
        description:
          "Schedule a non-blocking wait for the given scoops. Returns immediately — the cone keeps its turn — and a `scoop-wait` lick is delivered when every listed scoop completes or the optional timeout fires. Use this to coordinate parallel work without freezing the cone: feed several scoops, call scoop_wait, then continue with other work; you'll be woken by the lick with all per-scoop summaries in one shot. Already-completed scoops (including those whose completion arrived while you were processing your previous turn) are folded into the same lick.",
        inputSchema: {
          type: 'object',
          properties: {
            scoop_names: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Folder or display names of scoops to wait for (e.g., ["writer-scoop", "reviewer-scoop"]).',
            },
            timeout_ms: {
              type: 'number',
              description:
                'Optional timeout in milliseconds. If any listed scoop has not completed by the deadline, it is reported as timed-out in the eventual `scoop-wait` lick. Omit for no timeout.',
            },
          },
          required: ['scoop_names'],
        },
        execute: async (input) => {
          const { scoop_names, timeout_ms } = input as {
            scoop_names: string[];
            timeout_ms?: number;
          };
          if (!Array.isArray(scoop_names) || scoop_names.length === 0) {
            return { content: 'scoop_names must be a non-empty array.', isError: true };
          }
          if (
            timeout_ms !== undefined &&
            (typeof timeout_ms !== 'number' || !Number.isFinite(timeout_ms) || timeout_ms < 0)
          ) {
            return {
              content: 'timeout_ms must be a non-negative finite number (or omitted).',
              isError: true,
            };
          }
          const { resolved, unknown } = resolveScoopNames(scoop_names, getScoops);
          if (resolved.length === 0) {
            return {
              content: `No matching scoops found. Unknown: ${unknown.join(', ')}`,
              isError: true,
            };
          }
          const jids = resolved.map((s) => s.jid);
          // Use the orchestrator's return value to build the
          // acknowledgement: a scoop can be dropped between name
          // resolution and the schedule call, in which case the
          // orchestrator will report it as `unknown` even though
          // `resolveScoopNames` accepted it. Trusting only the
          // tool-side resolution would tell the cone "scheduled for X"
          // when X is no longer registered and will never produce a
          // result row in the eventual lick.
          const ack = onScheduleScoopWait(jids, timeout_ms);
          const jidToFolder = new Map(resolved.map((s) => [s.jid, s.folder]));
          const scheduledFolders = ack.scheduled
            .map((jid) => jidToFolder.get(jid) ?? jid)
            .join(', ');
          const droppedFolders = ack.unknown.map((jid) => jidToFolder.get(jid) ?? jid).join(', ');
          log.info('Wait scheduled', {
            scheduled: ack.scheduled.map((jid) => jidToFolder.get(jid) ?? jid),
            droppedAtSchedule: droppedFolders ? droppedFolders.split(', ') : [],
            unknownNames: unknown,
            timeout_ms,
          });
          if (ack.scheduled.length === 0) {
            // Every resolved jid was dropped between resolution and
            // scheduling; nothing to wait on. Report this as an error
            // so the cone retries instead of waiting on a lick that
            // will never fire.
            const dropped = droppedFolders || ack.unknown.join(', ');
            const unknownTail = unknown.length > 0 ? ` Unknown names: ${unknown.join(', ')}.` : '';
            return {
              content: `scoop_wait could not be scheduled — every listed scoop was unregistered before the wait could start (dropped: ${dropped}).${unknownTail}`,
              isError: true,
            };
          }
          const tail = timeout_ms !== undefined ? ` (timeout: ${timeout_ms}ms)` : ' (no timeout)';
          const warnUnknown =
            unknown.length > 0 ? ` Unknown (skipped): ${unknown.join(', ')}.` : '';
          const warnDropped = droppedFolders
            ? ` Dropped before schedule (skipped): ${droppedFolders}.`
            : '';
          return {
            content:
              `scoop_wait scheduled for: ${scheduledFolders}${tail}.${warnUnknown}${warnDropped} ` +
              `Continue with other work — a 'scoop-wait' lick will be delivered when all listed scoops complete or the timeout fires.`,
          };
        },
      });
    }

    // Cone only: sudo_allow / sudo_deny / list_sudo_requests — settle the
    // sudo-request escalations a non-cone scoop raised via sudo_request. The
    // pending-request registry lives on the orchestrator; these tools are the
    // cone-side surface for resolving an id with allow-once, always-and-persist,
    // or deny. The matching scoop-side counterpart (sudo_request) is registered
    // above on non-cone toolsets only.
    if (onSudoResolve) {
      tools.push({
        name: 'sudo_allow',
        description:
          "Approve a pending sudo escalation raised by a scoop via sudo_request. With always=true, the orchestrator additionally appends a NOPASSWD <directive> <pattern> rule to the requesting scoop's /scoops/<folder>/etc/sudoers so the same action won't prompt again. always=false (the default) is allow-once.",
        inputSchema: {
          type: 'object',
          properties: {
            request_id: {
              type: 'string',
              description:
                'The id of the pending request (as delivered in the [sudo-request] notification, e.g. "sudo-abc-…"). Use list_sudo_requests to see outstanding ids.',
            },
            always: {
              type: 'boolean',
              description:
                "If true, persist a NOPASSWD rule into the requesting scoop's per-scoop sudoers so the action won't prompt again. Defaults to false (allow-once).",
            },
            pattern: {
              type: 'string',
              description:
                'Optional glob pattern to persist when always=true (e.g., "git push*" or "/workspace/.git/**"). Defaults to the request\'s suggestedPattern, then to the exact detail. Ignored when always=false.',
            },
          },
          required: ['request_id'],
        },
        execute: async (input) => {
          const { request_id, always, pattern } = input as {
            request_id: string;
            always?: boolean;
            pattern?: string;
          };
          if (typeof request_id !== 'string' || request_id.length === 0) {
            return { content: 'request_id must be a non-empty string.', isError: true };
          }
          const decision: SudoDecision = always
            ? { decision: 'always', ...(pattern ? { pattern } : {}) }
            : { decision: 'allow' };
          try {
            const outcome = await onSudoResolve(request_id, decision);
            if (!outcome.settled) {
              return {
                content: `Sudo request "${request_id}" is unknown, already resolved, or timed out.`,
                isError: true,
              };
            }
            const lines: string[] = [];
            if (always) {
              if (outcome.persisted) {
                lines.push(
                  `Approved (always) — persisted NOPASSWD rule for ${outcome.kind ?? 'unknown'} pattern "${outcome.persistedPattern}" in /scoops/${outcome.scoopFolder ?? '<unknown>'}/etc/sudoers.`
                );
              } else if (outcome.persistError) {
                lines.push(
                  `Approved (always) but could NOT persist a rule (${outcome.persistError}). The current action is allowed; future occurrences will prompt again.`
                );
              } else {
                lines.push('Approved (always) — no persistable rule applied for this request.');
              }
            } else {
              lines.push(
                'Approved (once) — the current action proceeds; future ones will prompt again.'
              );
            }
            log.info('Sudo request approved', {
              id: request_id,
              always: !!always,
              persisted: outcome.persisted,
            });
            return { content: lines.join('\n') };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: `sudo_allow failed: ${msg}`, isError: true };
          }
        },
      });

      tools.push({
        name: 'sudo_deny',
        description:
          'Refuse a pending sudo escalation raised by a scoop via sudo_request. The scoop receives a deny decision and the sensitive action does NOT run.',
        inputSchema: {
          type: 'object',
          properties: {
            request_id: {
              type: 'string',
              description:
                'The id of the pending request (as delivered in the [sudo-request] notification). Use list_sudo_requests to see outstanding ids.',
            },
          },
          required: ['request_id'],
        },
        execute: async (input) => {
          const { request_id } = input as { request_id: string };
          if (typeof request_id !== 'string' || request_id.length === 0) {
            return { content: 'request_id must be a non-empty string.', isError: true };
          }
          try {
            const outcome = await onSudoResolve(request_id, { decision: 'deny' });
            if (!outcome.settled) {
              return {
                content: `Sudo request "${request_id}" is unknown, already resolved, or timed out.`,
                isError: true,
              };
            }
            log.info('Sudo request denied', { id: request_id });
            return { content: 'Denied — the scoop will not run this action.' };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: `sudo_deny failed: ${msg}`, isError: true };
          }
        },
      });
    }

    if (onListSudoRequests) {
      tools.push({
        name: 'list_sudo_requests',
        description:
          'List all pending cone-mediated sudo requests (id, requesting scoop, kind, detail). Use to find an id for sudo_allow / sudo_deny.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          const pending = onListSudoRequests();
          if (pending.length === 0) {
            return { content: 'No pending sudo requests.' };
          }
          const scoopFolder = (jid: string) => {
            const s = getScoops().find((x) => x.jid === jid);
            return s?.folder ?? jid;
          };
          const lines = pending.map((p) => {
            const folder = scoopFolder(p.scoopJid);
            const suggested = p.request.suggestedPattern
              ? ` (suggested: ${p.request.suggestedPattern})`
              : '';
            return `- ${p.id} — ${folder} — ${p.request.kind}: ${p.request.detail}${suggested}`;
          });
          return { content: `Pending sudo requests:\n${lines.join('\n')}` };
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
