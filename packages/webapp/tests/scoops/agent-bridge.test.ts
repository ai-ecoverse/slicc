/**
 * Tests for AgentBridge — the direct spawn path used by the `agent`
 * supplemental shell command. The bridge creates a fresh RegisteredScoop,
 * builds a sandboxed RestrictedFS, constructs a ScoopContext, awaits
 * `ctx.prompt()` and cleans up the scratch folder + orchestrator registration
 * on every completion path.
 *
 * The bridge exposes a small `deps` injection surface (`createContext`,
 * `generateUid`, `resolveModel`, `getInheritedModelId`) so that these tests
 * can exercise the lifecycle end-to-end without spinning up a real agent
 * loop. We use a REAL `VirtualFS` (via `fake-indexeddb/auto`) and a REAL
 * `Orchestrator` (with `initDB()` so `unregisterScoop` works) to verify
 * folder creation / deletion and orchestrator registry behavior.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAgentBridge,
  type AgentBridgeContext,
  type AgentBridgeContextArgs,
} from '../../src/scoops/agent-bridge.js';
import { Orchestrator } from '../../src/scoops/orchestrator.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { RestrictedFS } from '../../src/fs/restricted-fs.js';
import { FsError } from '../../src/fs/types.js';
import * as db from '../../src/scoops/db.js';
import type { AgentMessage } from '../../src/core/types.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

// ─── Helpers ───────────────────────────────────────────────────────────

interface CapturedCtxArgs {
  args: AgentBridgeContextArgs;
}

interface MockScoopContextOptions {
  /** Push into array for recording all constructions. */
  captured: CapturedCtxArgs[];
  /** Behavior of prompt(). Default resolves immediately without side effects. */
  promptBehavior?: (text: string, captured: CapturedCtxArgs) => Promise<void> | void;
  /** Messages returned by getAgentMessages(). */
  agentMessages?: AgentMessage[];
  /** Runs during prompt() before resolution (lets tests use await to observe VFS state). */
  onPrompt?: (text: string, captured: CapturedCtxArgs) => Promise<void> | void;
  /** Called when send_message should fire while prompt() is running. */
  onSendWhilePrompting?: string[];
  /** Called with dispose() invocation. */
  onDispose?: () => void;
}

function makeMockContextFactory(
  opts: MockScoopContextOptions
): (args: AgentBridgeContextArgs) => AgentBridgeContext {
  return (args) => {
    const record: CapturedCtxArgs = { args };
    opts.captured.push(record);

    return {
      async init() {
        // no-op in tests
      },
      async prompt(text: string) {
        // Emit any queued send_message callbacks to the provided callbacks
        if (opts.onSendWhilePrompting) {
          for (const msg of opts.onSendWhilePrompting) {
            args.callbacks.onSendMessage(msg);
          }
        }
        if (opts.onPrompt) await opts.onPrompt(text, record);
        if (opts.promptBehavior) await opts.promptBehavior(text, record);
      },
      dispose() {
        opts.onDispose?.();
      },
      getAgentMessages() {
        return opts.agentMessages ?? [];
      },
    };
  };
}

async function makeOrchestrator(): Promise<Orchestrator> {
  await db.initDB();
  // We construct an Orchestrator *without* calling .init() — that would pull
  // in DOM-bound setup (window.setInterval, FsWatcher, etc.). The bridge only
  // needs `unregisterScoop()` to succeed, which requires the DB to be
  // initialized. `getScoops()` reads from the in-memory map which starts empty.
  const orch = new Orchestrator(
    {} as unknown as HTMLElement,
    {
      onResponse: () => {},
      onResponseDone: () => {},
      onSendMessage: () => {},
      onStatusChange: () => {},
      onError: () => {},
      getBrowserAPI: () => ({}) as any,
    },
    { name: 'sliccy', triggerPattern: /^@sliccy\b/i }
  );
  return orch;
}

async function makeVfs(): Promise<VirtualFS> {
  const vfs = await VirtualFS.create({ dbName: `agent-bridge-test-${Math.random()}`, wipe: true });
  // Ensure root dirs exist — similar to orchestrator.ensureRootStructure().
  for (const dir of ['/workspace', '/shared', '/scoops', '/home', '/tmp']) {
    try {
      await vfs.mkdir(dir, { recursive: true });
    } catch {
      /* ignore already-exists */
    }
  }
  return vfs;
}

function assistantTextMessage(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic',
    provider: 'anthropic',
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

/**
 * Build an assistant message that contains a single `send_message` tool call
 * with the given payload. Shape mirrors what pi-agent-core produces after a
 * scoop invokes the NanoClaw `send_message` tool.
 */
function assistantSendMessageToolCall(id: string, text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'send_message', arguments: { text } }],
    api: 'anthropic',
    provider: 'anthropic',
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  };
}

/**
 * Build an assistant message that contains a single non-`send_message` tool
 * call (e.g. bash). Used to simulate work between progress updates and the
 * final assistant-text summary.
 */
function assistantBashToolCall(id: string, command: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'bash', arguments: { command } }],
    api: 'anthropic',
    provider: 'anthropic',
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  };
}

/** Tool-result message (role 'toolResult') paired with a prior tool call. */
function toolResultMessage(toolCallId: string, toolName: string, text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now(),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('createAgentBridge', () => {
  let vfs: VirtualFS;
  let orch: Orchestrator;

  beforeEach(async () => {
    vfs = await makeVfs();
    orch = await makeOrchestrator();
  });

  afterEach(async () => {
    await orch.shutdown().catch(() => {});
    await vfs.dispose().catch(() => {});
  });

  // ── SPAWN — folder + scoop record ─────────────────────────────────

  describe('spawn: scratch folder + RegisteredScoop', () => {
    it('creates a /scoops/agent-<uid>/ directory before cleanup', async () => {
      const captured: CapturedCtxArgs[] = [];
      let existedDuringPrompt = false;
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          promptBehavior: async () => {
            // Inspect the VFS while prompt() is still executing.
            existedDuringPrompt = await vfs.exists(`/scoops/${captured[0].args.scoop.folder}`);
          },
        }),
        generateUid: () => 'abc123',
        resolveModel: () => 'claude-opus-4-6',
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'hi' });

      expect(result.exitCode).toBe(0);
      expect(existedDuringPrompt).toBe(true);
      // Folder name derives from uid
      expect(captured[0].args.scoop.folder).toBe('agent-abc123');
    });

    it('registers the scoop with isCone: false and type: "scoop"', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'x1',
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(captured[0].args.scoop.isCone).toBe(false);
      expect(captured[0].args.scoop.type).toBe('scoop');
    });

    it('RegisteredScoop.folder equals the scratch folder base name', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'uid-specific',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(captured[0].args.scoop.folder).toBe('agent-uid-specific');
    });

    it('mints a unique jid per spawn (no collision across two consecutive spawns)', async () => {
      const captured: CapturedCtxArgs[] = [];
      let counter = 0;
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => `c${counter++}`,
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p1' });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p2' });

      expect(captured).toHaveLength(2);
      expect(captured[0].args.scoop.jid).not.toEqual(captured[1].args.scoop.jid);
    });

    it('scratch folder names are not reused across two consecutive spawns', async () => {
      const captured: CapturedCtxArgs[] = [];
      let counter = 0;
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => `u${counter++}`,
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

      expect(captured[0].args.scoop.folder).not.toEqual(captured[1].args.scoop.folder);
    });

    it('forwards the prompt text verbatim to ctx.prompt()', async () => {
      const captured: CapturedCtxArgs[] = [];
      let observedPrompt = '';
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          promptBehavior: (text) => {
            observedPrompt = text;
          },
        }),
        generateUid: () => 'v',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const exotic = 'line1\nline2 🎉 résumé $(whoami) `date`';
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: exotic });
      expect(observedPrompt).toBe(exotic);
    });

    it('passes a RestrictedFS instance (not the raw VFS) to the context', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'rfs',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(captured[0].args.fs).toBeInstanceOf(RestrictedFS);
    });
  });

  // ── FS — RestrictedFS ACL probing via the bridge-built instance ───

  describe('RestrictedFS ACL via bridge-built instance', () => {
    it('allows writes to the resolved cwd, /shared/, and /scoops/<folder>/', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'a1',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

      const rfs = captured[0].args.fs;
      await rfs.writeFile('/home/out.txt', 'in-cwd');
      await rfs.writeFile('/shared/note.md', 'shared');
      await rfs.writeFile('/scoops/agent-a1/tmp.txt', 'scratch');

      expect(await vfs.readTextFile('/home/out.txt')).toBe('in-cwd');
      expect(await vfs.readTextFile('/shared/note.md')).toBe('shared');
      expect(await vfs.readTextFile('/scoops/agent-a1/tmp.txt')).toBe('scratch');
    });

    it('exposes /workspace/ as read-only (EACCES on write)', async () => {
      // Seed a workspace file so reads can succeed.
      await vfs.writeFile('/workspace/existing.txt', 'hello');

      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'ro',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

      const rfs = captured[0].args.fs;
      // Read succeeds
      expect(await rfs.readTextFile('/workspace/existing.txt')).toBe('hello');
      // Write is blocked
      await expect(rfs.writeFile('/workspace/blocked.txt', 'x')).rejects.toMatchObject({
        code: 'EACCES',
      });
    });

    it('rejects writes outside cwd / /shared/ / /scoops/<folder>/ / /workspace/ with EACCES', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'outside',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home/wiki', allowedCommands: ['*'], prompt: 'p' });

      const rfs = captured[0].args.fs;
      await expect(rfs.writeFile('/tmp/escape.txt', 'x')).rejects.toMatchObject({
        code: 'EACCES',
      });
      await expect(rfs.writeFile('/home/other/escape.txt', 'x')).rejects.toMatchObject({
        code: 'EACCES',
      });
    });

    it("cannot see sibling scoops' folders (invisible to the restricted view)", async () => {
      // Create a sibling scoop folder with content before spawning
      await vfs.mkdir('/scoops/other-sibling', { recursive: true });
      await vfs.writeFile('/scoops/other-sibling/secret.txt', 'sibling secret');

      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'sib',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

      const rfs = captured[0].args.fs;
      // stat throws ENOENT for invisible paths (inside /scoops but not our folder)
      await expect(rfs.readTextFile('/scoops/other-sibling/secret.txt')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('normalizes a cwd with trailing-slash differences to a single R/W prefix', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'norm',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home/', allowedCommands: ['*'], prompt: 'p' });

      const rfs = captured[0].args.fs;
      await rfs.writeFile('/home/t.txt', 'ok');
      expect(await vfs.readTextFile('/home/t.txt')).toBe('ok');
    });
  });

  // ── OUTPUT — send_message / fallback / empty ──────────────────────

  describe('output determination', () => {
    it('returns the last send_message payload when one was captured', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          onSendWhilePrompting: ['first', 'last-wins'],
        }),
        generateUid: () => 'sm',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('last-wins');
    });

    it('falls back to the last assistant text from getAgentMessages() when no send_message', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          agentMessages: [
            assistantTextMessage('older'),
            assistantTextMessage('final-assistant-text'),
          ],
        }),
        generateUid: () => 'fb',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('final-assistant-text');
    });

    it('returns empty finalText when there is neither a send_message nor any assistant text', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured, agentMessages: [] }),
        generateUid: () => 'empty',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('');
    });
  });

  // ── OUTPUT — chronological-last precedence (VAL-OUTPUT-016) ───────

  // The `agent` stdout contract says whichever assistant output came LAST
  // chronologically wins, whether that output is a `send_message(text)` tool
  // call or a plain assistant-text block. The bridge's previous behavior —
  // "always prefer captured[last] over assistant text" — flipped the wrong
  // direction for the user's reported scenario where a progress-update
  // `send_message("Starting.")` preceded a final assistant-text summary.
  //
  // Scenario legend:
  //   A — send_message then bash then assistant text  → assistant text wins
  //   B — assistant text then send_message            → send_message wins
  //   C — only send_message                           → that send_message
  //   D — only assistant text                         → that text
  //   E — neither                                     → ''
  describe('chronological-last output (VAL-OUTPUT-016)', () => {
    it('scenario A: assistant text wins when it comes AFTER an earlier send_message (user repro)', async () => {
      // Pattern: send_message("Starting.") → bash → toolResult → assistant text "Summary."
      // Expected finalText: "Summary."  (assistant text is chronologically last)
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          onSendWhilePrompting: ['Starting.'],
          agentMessages: [
            assistantSendMessageToolCall('sm-1', 'Starting.'),
            assistantBashToolCall('bash-1', 'echo ready && sleep 10 && echo done'),
            toolResultMessage('bash-1', 'bash', 'ready\ndone'),
            assistantTextMessage('Summary.'),
          ],
        }),
        generateUid: () => 'chrono-a',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('Summary.');
    });

    it('scenario B: send_message wins when it comes AFTER an earlier assistant text', async () => {
      // Pattern: assistant text "Draft" → assistant send_message("Polished")
      // Expected finalText: "Polished"  (send_message is chronologically last)
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          onSendWhilePrompting: ['Polished'],
          agentMessages: [
            assistantTextMessage('Draft'),
            assistantSendMessageToolCall('sm-1', 'Polished'),
          ],
        }),
        generateUid: () => 'chrono-b',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('Polished');
    });

    it('scenario C: returns the single send_message when no assistant text exists', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          onSendWhilePrompting: ['only'],
          agentMessages: [assistantSendMessageToolCall('sm-1', 'only')],
        }),
        generateUid: () => 'chrono-c',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('only');
    });

    it('scenario D: returns the single assistant text when no send_message was emitted', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          agentMessages: [assistantTextMessage('answer')],
        }),
        generateUid: () => 'chrono-d',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('answer');
    });

    it('scenario E: returns empty finalText when no output exists', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured, agentMessages: [] }),
        generateUid: () => 'chrono-e',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('');
    });

    // Additional within-message precedence coverage: when a single assistant
    // turn contains BOTH a text block AND a send_message tool call, the later
    // block (by content-array index) wins. pi-agent-core emits content blocks
    // in chronological order, so the last block in the array is the latest
    // output for that turn.
    it('within-message: assistant-text-then-toolcall → toolcall wins (send_message is later block)', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          onSendWhilePrompting: ['late-in-turn'],
          agentMessages: [
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'early-in-turn' },
                {
                  type: 'toolCall',
                  id: 'sm-1',
                  name: 'send_message',
                  arguments: { text: 'late-in-turn' },
                },
              ],
              api: 'anthropic',
              provider: 'anthropic',
              model: 'test-model',
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: 'toolUse',
              timestamp: Date.now(),
            } as AgentMessage,
          ],
        }),
        generateUid: () => 'chrono-inline',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('late-in-turn');
    });

    // Ignore non-`send_message` tool calls (bash, etc.) — they are not
    // "assistant output" for the stdout contract.
    it('ignores non-send_message tool calls when finding the chronological last', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          agentMessages: [
            assistantTextMessage('answer'),
            assistantBashToolCall('bash-post', 'ls /'),
            toolResultMessage('bash-post', 'bash', 'root dirs'),
          ],
        }),
        generateUid: () => 'chrono-ignore',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('answer');
    });

    // ── Multi-text-block concatenation (bounded by tool_use checkpoints) ─────
    //
    // Within a single assistant message, pi-agent-core content arrays can
    // contain multiple consecutive `text` blocks (e.g., Bedrock Claude with
    // interleaved thinking+answer, or any provider that splits a final
    // answer across blocks). The walker MUST join ALL text blocks that
    // trail the LAST tool_use block in that message (or all text blocks if
    // no tool_use exists) so we do not truncate multi-block responses to
    // the final block only. A tool_use block acts as a chronological
    // checkpoint — text BEFORE it is intermediate narrative and is dropped.

    it('multi-text-block assistant message: joins ALL text blocks when text wins', async () => {
      // Content: [text('alpha'), text('beta'), text('gamma')]
      // No tool_use — all three blocks belong to the final turn.
      // Expected: 'alphabetagamma' (literal concatenation — matches
      // ScoopContext.message_end `.join('')` and extractLastAssistantText
      // `.join('')` conventions).
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          agentMessages: [
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'alpha' },
                { type: 'text', text: 'beta' },
                { type: 'text', text: 'gamma' },
              ],
              api: 'anthropic',
              provider: 'anthropic',
              model: 'test-model',
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: 'stop',
              timestamp: Date.now(),
            } as AgentMessage,
          ],
        }),
        generateUid: () => 'multi-text',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('alphabetagamma');
    });

    it('tool_use acts as a chronological boundary within a message (regression guard)', async () => {
      // Content: [text('early'), tool_use(bash), text('late')]
      // tool_use is a checkpoint — 'early' is pre-tool-call narrative and
      // is dropped; only 'late' (after the checkpoint) is returned.
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          agentMessages: [
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'early' },
                { type: 'toolCall', id: 'bash-mid', name: 'bash', arguments: { command: 'ls' } },
                { type: 'text', text: 'late' },
              ],
              api: 'anthropic',
              provider: 'anthropic',
              model: 'test-model',
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: 'toolUse',
              timestamp: Date.now(),
            } as AgentMessage,
          ],
        }),
        generateUid: () => 'boundary',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('late');
    });

    it('empty / whitespace-only text blocks are skipped when concatenating', async () => {
      // Content: [text('real'), text('   '), text('more')]
      // Expected: 'realmore' — whitespace-only block is elided from the
      // literal concatenation (keeps output readable; mirrors the
      // trim-length check already used when deciding whether a block
      // "wins").
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          agentMessages: [
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'real' },
                { type: 'text', text: '   ' },
                { type: 'text', text: 'more' },
              ],
              api: 'anthropic',
              provider: 'anthropic',
              model: 'test-model',
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: 'stop',
              timestamp: Date.now(),
            } as AgentMessage,
          ],
        }),
        generateUid: () => 'multi-trim',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('realmore');
    });

    it('split-token adjacent text blocks concatenate literally (no fabricated whitespace)', async () => {
      // Content: [text('Hello'), text(' world')]
      // pi-ai providers can split a single logical sentence across adjacent
      // text blocks at arbitrary token boundaries (e.g. Anthropic streaming
      // can emit 'Hello' + ' world' as two content blocks). The joiner must
      // concatenate literally — `''` — matching ScoopContext.message_end
      // (`.join('')`) and extractLastAssistantText (`.join('')`). A `\n\n`
      // joiner would fabricate a paragraph break and mutate the output to
      // `'Hello\n\n world'`.
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          agentMessages: [
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Hello' },
                { type: 'text', text: ' world' },
              ],
              api: 'anthropic',
              provider: 'anthropic',
              model: 'test-model',
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: 'stop',
              timestamp: Date.now(),
            } as AgentMessage,
          ],
        }),
        generateUid: () => 'split-token',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('Hello world');
    });

    it('single-text-block assistant message still returns just the block (no regression)', async () => {
      // Content: [text('only')]  → 'only' (no join needed, no extra newlines).
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          agentMessages: [assistantTextMessage('only')],
        }),
        generateUid: () => 'single-text',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('only');
    });
  });

  // ── CLEAN — every completion path wipes the scratch folder ────────

  describe('cleanup: scratch folder + orchestrator + dispose + sessionStore', () => {
    it('deletes /scoops/<folder>/ after a successful completion', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'ok',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(await vfs.exists('/scoops/agent-ok')).toBe(false);
    });

    it('deletes /scoops/<folder>/ after prompt() rejects', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          promptBehavior: async () => {
            throw new Error('agent loop blew up');
          },
        }),
        generateUid: () => 'err',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(1);
      expect(result.finalText).toBe('agent loop blew up');
      expect(await vfs.exists('/scoops/agent-err')).toBe(false);
    });

    it('deletes /scoops/<folder>/ when prompt() throws synchronously', async () => {
      // A factory that returns a context whose prompt() throws synchronously
      // (before returning a Promise).
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: () => ({
          async init() {},
          prompt() {
            throw new Error('sync boom');
          },
          dispose() {},
          getAgentMessages() {
            return [];
          },
        }),
        generateUid: () => 'syncerr',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(1);
      expect(result.finalText).toBe('sync boom');
      expect(await vfs.exists('/scoops/agent-syncerr')).toBe(false);
    });

    it('deletes /scoops/<folder>/ after an abort-style rejection', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          promptBehavior: async () => {
            throw new DOMException('aborted', 'AbortError');
          },
        }),
        generateUid: () => 'abort',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(1);
      expect(await vfs.exists('/scoops/agent-abort')).toBe(false);
    });

    it('still runs cleanup when every bash invocation would be rejected by the allow-list', async () => {
      // Allow-list enforcement lives in the bash-tool wrapper (separate
      // feature). From the bridge's perspective, rejection surfaces as tool
      // results inside the agent loop — the loop still completes and prompt()
      // resolves normally. The bridge must still clean up.
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          onSendWhilePrompting: ['I could not do anything'],
        }),
        generateUid: () => 'allreject',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: [], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('I could not do anything');
      expect(await vfs.exists('/scoops/agent-allreject')).toBe(false);
    });

    it('cleanup still deletes the folder when sessionStore.delete rejects', async () => {
      const sessionStore = {
        save: vi.fn().mockResolvedValue(undefined),
        load: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockRejectedValue(new Error('session DB locked')),
        list: vi.fn().mockResolvedValue([]),
        clearAll: vi.fn().mockResolvedValue(undefined),
      } as any;

      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, sessionStore, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'sess-fail',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(await vfs.exists('/scoops/agent-sess-fail')).toBe(false);
      expect(sessionStore.delete).toHaveBeenCalledWith(captured[0].args.scoop.jid);
    });

    it('calls orchestrator.unregisterScoop(jid) on cleanup', async () => {
      const unregisterSpy = vi.spyOn(orch, 'unregisterScoop');
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'unreg',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(unregisterSpy).toHaveBeenCalledWith(captured[0].args.scoop.jid);
    });

    it('calls ctx.dispose() on the context', async () => {
      const disposeSpy = vi.fn();
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured, onDispose: disposeSpy }),
        generateUid: () => 'disp',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('calls sessionStore.delete(jid) on cleanup when sessionStore is provided', async () => {
      const sessionStore = {
        save: vi.fn().mockResolvedValue(undefined),
        load: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        clearAll: vi.fn().mockResolvedValue(undefined),
      } as any;

      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, sessionStore, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'sd',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(sessionStore.delete).toHaveBeenCalledWith(captured[0].args.scoop.jid);
    });

    it('preserves files under /shared/ and cwd that the scoop wrote (cleanup only touches /scoops/<folder>/)', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          promptBehavior: async (_t, rec) => {
            // Simulate the scoop writing via its restricted fs.
            await rec.args.fs.writeFile('/shared/out.md', 'survives');
            await rec.args.fs.writeFile('/home/wiki/out.md', 'survives');
          },
        }),
        generateUid: () => 'preserve',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await vfs.mkdir('/home/wiki', { recursive: true });
      await bridge.spawn({ cwd: '/home/wiki', allowedCommands: ['*'], prompt: 'p' });
      expect(await vfs.readTextFile('/shared/out.md')).toBe('survives');
      expect(await vfs.readTextFile('/home/wiki/out.md')).toBe('survives');
      expect(await vfs.exists('/scoops/agent-preserve')).toBe(false);
    });

    it("leaves sibling scoops' /scoops/<other>/ untouched during cleanup", async () => {
      await vfs.mkdir('/scoops/other-sibling', { recursive: true });
      await vfs.writeFile('/scoops/other-sibling/keep.txt', 'sibling survives');

      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'notsibling',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(await vfs.readTextFile('/scoops/other-sibling/keep.txt')).toBe('sibling survives');
      expect(await vfs.exists('/scoops/agent-notsibling')).toBe(false);
    });

    it('two overlapping spawns clean up only their own folders', async () => {
      let counter = 0;
      const captured: CapturedCtxArgs[] = [];

      // Control the completion order via explicit deferred promises.
      const defs: Array<{
        promise: Promise<void>;
        resolve: () => void;
      }> = [];
      for (let i = 0; i < 2; i++) {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        defs.push({ promise, resolve });
      }

      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: (args) => {
          const idx = counter++;
          captured.push({ args });
          return {
            async init() {},
            async prompt() {
              await defs[idx].promise;
            },
            dispose() {},
            getAgentMessages() {
              return [];
            },
          };
        },
        generateUid: (() => {
          let c = 0;
          return () => `par${c++}`;
        })(),
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      const p1 = bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'first' });
      const p2 = bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'second' });

      // Both folders present while prompts are pending.
      expect(await vfs.exists('/scoops/agent-par0')).toBe(true);
      expect(await vfs.exists('/scoops/agent-par1')).toBe(true);

      // Resolve second first, let it clean up.
      defs[1].resolve();
      await p2;
      expect(await vfs.exists('/scoops/agent-par1')).toBe(false);
      // First is still running, its folder still exists.
      expect(await vfs.exists('/scoops/agent-par0')).toBe(true);

      // Resolve first.
      defs[0].resolve();
      await p1;
      expect(await vfs.exists('/scoops/agent-par0')).toBe(false);
    });

    it('does not touch /workspace/ during cleanup', async () => {
      await vfs.writeFile('/workspace/untouched.md', 'preserved');
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'ws',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(await vfs.readTextFile('/workspace/untouched.md')).toBe('preserved');
    });

    it('orchestrator.getScoops() does not contain the spawned scoop after cleanup', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'list',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      const jid = captured[0].args.scoop.jid;
      expect(orch.getScoops().find((s) => s.jid === jid)).toBeUndefined();
    });

    it('orchestrator.getScoops() contains the spawned scoop DURING prompt and NOT after cleanup', async () => {
      const captured: CapturedCtxArgs[] = [];
      let jidsDuringPrompt: string[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          onPrompt: async () => {
            jidsDuringPrompt = orch.getScoops().map((s) => s.jid);
          },
        }),
        generateUid: () => 'registered',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      const jid = captured[0].args.scoop.jid;
      // (a) During prompt() the bridge MUST have registered the scoop with
      //     the orchestrator so it is visible via getScoops().
      expect(jidsDuringPrompt).toContain(jid);
      // (b) After cleanup, the scoop must be unregistered again.
      expect(orch.getScoops().find((s) => s.jid === jid)).toBeUndefined();
    });

    it('concurrent overlapping spawns each appear in getScoops() until their own prompt resolves', async () => {
      let counter = 0;
      const captured: CapturedCtxArgs[] = [];

      const defs: Array<{ promise: Promise<void>; resolve: () => void }> = [];
      const started: Array<{ promise: Promise<void>; resolve: () => void }> = [];
      for (let i = 0; i < 2; i++) {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        defs.push({ promise, resolve });
        let startedResolve!: () => void;
        const startedPromise = new Promise<void>((r) => {
          startedResolve = r;
        });
        started.push({ promise: startedPromise, resolve: startedResolve });
      }

      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: (args) => {
          const idx = counter++;
          captured.push({ args });
          return {
            async init() {},
            async prompt() {
              started[idx].resolve();
              await defs[idx].promise;
            },
            dispose() {},
            getAgentMessages() {
              return [];
            },
          };
        },
        generateUid: (() => {
          let c = 0;
          return () => `reglist${c++}`;
        })(),
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      const p1 = bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'first' });
      const p2 = bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'second' });

      // Wait until both prompts have started (which happens after registration).
      await Promise.all([started[0].promise, started[1].promise]);

      // Both entries should be registered during their pending prompts.
      const midJids = orch.getScoops().map((s) => s.jid);
      expect(midJids).toContain(captured[0].args.scoop.jid);
      expect(midJids).toContain(captured[1].args.scoop.jid);

      // Resolve second first; its entry should be removed but the first remains.
      defs[1].resolve();
      await p2;
      const afterSecond = orch.getScoops().map((s) => s.jid);
      expect(afterSecond).not.toContain(captured[1].args.scoop.jid);
      expect(afterSecond).toContain(captured[0].args.scoop.jid);

      // Resolve the first spawn and verify both are cleaned up.
      defs[0].resolve();
      await p1;
      const afterFirst = orch.getScoops().map((s) => s.jid);
      expect(afterFirst).not.toContain(captured[0].args.scoop.jid);
      expect(afterFirst).not.toContain(captured[1].args.scoop.jid);
    });
  });

  // ── MODEL — explicit override, inheritance, unknown model ─────────

  describe('model selection', () => {
    it('inherits the parent model id when no modelId is supplied', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'm1',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(captured[0].args.modelId).toBe('claude-opus-4-6');
    });

    it('threads an explicit modelId byte-for-byte to the context', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'm2',
        resolveModel: (id) => id, // all ids are valid in this test
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
        modelId: 'claude-haiku-4-5',
      });
      expect(captured[0].args.modelId).toBe('claude-haiku-4-5');
    });

    it('sets scoop.config.modelId when modelId is supplied (forwarded to ScoopContext)', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'm3',
        resolveModel: (id) => id,
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
        modelId: 'claude-haiku-4-5',
      });
      expect(captured[0].args.scoop.config?.modelId).toBe('claude-haiku-4-5');
    });

    it('returns { exitCode: 1, finalText: "agent: unknown model: <id>" } for an unknown model', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'm4',
        resolveModel: () => null, // treat every id as unknown
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
        modelId: 'not-a-real-model',
      });
      expect(result.exitCode).toBe(1);
      expect(result.finalText).toBe('agent: unknown model: not-a-real-model');
      // No context was ever created
      expect(captured).toHaveLength(0);
    });

    it('returns the same error for an empty-string modelId', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'm5',
        resolveModel: (id) => (id === '' ? null : id),
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
        modelId: '',
      });
      expect(result.exitCode).toBe(1);
      expect(result.finalText).toBe('agent: unknown model: ');
      expect(captured).toHaveLength(0);
    });

    it('does NOT create a scratch folder when the model is unknown (no-op cleanup)', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'never',
        resolveModel: () => null,
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
        modelId: 'bogus',
      });
      expect(await vfs.exists('/scoops/agent-never')).toBe(false);
    });

    it('does not mutate the parent inherited model id after a spawn with modelId override', async () => {
      const captured: CapturedCtxArgs[] = [];
      const inherited = 'claude-opus-4-6';
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'm6',
        resolveModel: (id) => id,
        getInheritedModelId: () => inherited,
      });
      await bridge.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
        modelId: 'claude-haiku-4-5',
      });
      expect(inherited).toBe('claude-opus-4-6');
    });
  });

  // ── Orchestrator bypass (no cone-only tool calls) ─────────────────

  describe('orchestrator bypass: does not use cone-only tools', () => {
    it('does not call scoop_scoop / feed_scoop / drop_scoop / list_scoops on the orchestrator', async () => {
      // Orchestrator doesn't expose those as methods — they are agent tools.
      // The bridge should construct ScoopContext directly, not route through
      // the cone's tool invocation path. We assert by watching the createContext
      // factory as the only path used.
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'bypass',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      // Exactly one context was constructed via the factory.
      expect(captured).toHaveLength(1);
    });
  });

  // ── Parent-scoop model inheritance (parentJid) ────────────────────
  //
  // When the `agent` supplemental shell command is invoked from inside a
  // scoop's bash tool, the bridge must inherit the *parent scoop's* model id
  // (from `orchestrator.getScoops()`), NOT the globally-selected UI model.
  // Only when the parent is the cone (or has no configured model) does the
  // bridge fall back to `getInheritedModelId()` (which reflects the global
  // UI selection).
  //
  // Plumbing: `agent-command` forwards the caller's scoop jid via
  // `spawn({ ..., parentJid })`, and the bridge looks it up in the
  // orchestrator's registry to read `config.modelId`.

  describe('parent-scoop model inheritance via parentJid', () => {
    function registerParentScoop(opts: {
      jid: string;
      folder: string;
      isCone?: boolean;
      modelId?: string;
    }): void {
      const scoop: RegisteredScoop = {
        jid: opts.jid,
        name: opts.folder,
        folder: opts.folder,
        isCone: opts.isCone ?? false,
        type: opts.isCone ? 'cone' : 'scoop',
        requiresTrigger: false,
        assistantLabel: opts.folder,
        addedAt: new Date().toISOString(),
        config: opts.modelId !== undefined ? { modelId: opts.modelId } : {},
      };
      orch.registerExistingScoop(scoop);
    }

    it("inherits the parent scoop's config.modelId (NOT the global default) when parentJid is supplied and no override is given", async () => {
      registerParentScoop({
        jid: 'parent-opus',
        folder: 'parent-opus',
        modelId: 'claude-opus-4-6',
      });

      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'child-1',
        // The global default must NOT win here — parent's modelId takes priority.
        getInheritedModelId: () => 'GLOBAL-DEFAULT-SHOULD-NOT-BE-USED',
      });

      await bridge.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
        parentJid: 'parent-opus',
      });

      expect(captured).toHaveLength(1);
      expect(captured[0].args.modelId).toBe('claude-opus-4-6');
    });

    it('explicit --model override wins even when parentJid is supplied', async () => {
      registerParentScoop({
        jid: 'parent-opus',
        folder: 'parent-opus',
        modelId: 'claude-opus-4-6',
      });

      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'child-override',
        resolveModel: (id) => id,
        getInheritedModelId: () => 'GLOBAL-DEFAULT-SHOULD-NOT-BE-USED',
      });

      await bridge.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
        parentJid: 'parent-opus',
        modelId: 'claude-haiku-4-5',
      });

      expect(captured).toHaveLength(1);
      expect(captured[0].args.modelId).toBe('claude-haiku-4-5');
      // The recorded scoop config still reflects the override (not parent's).
      expect(captured[0].args.scoop.config?.modelId).toBe('claude-haiku-4-5');
    });

    it('cone parent with no configured model falls back to getInheritedModelId (global UI default)', async () => {
      registerParentScoop({
        jid: 'cone',
        folder: 'cone',
        isCone: true,
        // No modelId — cone relies on the global UI selection.
      });

      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'from-cone',
        getInheritedModelId: () => 'claude-sonnet-4-6',
      });

      await bridge.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
        parentJid: 'cone',
      });

      expect(captured).toHaveLength(1);
      expect(captured[0].args.modelId).toBe('claude-sonnet-4-6');
    });

    it('scoop parent with no configured model falls back to getInheritedModelId', async () => {
      registerParentScoop({
        jid: 'parent-nomodel',
        folder: 'parent-nomodel',
        // No modelId set — scoop inherited from global UI at registration time.
      });

      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'from-scoop',
        getInheritedModelId: () => 'claude-sonnet-4-6',
      });

      await bridge.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
        parentJid: 'parent-nomodel',
      });

      expect(captured[0].args.modelId).toBe('claude-sonnet-4-6');
    });

    it('unknown parentJid gracefully falls back to getInheritedModelId', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'unknown-parent',
        getInheritedModelId: () => 'claude-sonnet-4-6',
      });

      await bridge.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
        parentJid: 'does-not-exist',
      });

      expect(captured[0].args.modelId).toBe('claude-sonnet-4-6');
    });

    it('omitted parentJid falls back to getInheritedModelId (legacy behavior preserved)', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'no-parent',
        getInheritedModelId: () => 'claude-sonnet-4-6',
      });

      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

      expect(captured[0].args.modelId).toBe('claude-sonnet-4-6');
    });

    it("does not mutate the parent scoop's config.modelId after spawn", async () => {
      registerParentScoop({
        jid: 'parent-stable',
        folder: 'parent-stable',
        modelId: 'claude-opus-4-6',
      });

      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'mutation-test',
        resolveModel: (id) => id,
        getInheritedModelId: () => 'claude-sonnet-4-6',
      });

      await bridge.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
        parentJid: 'parent-stable',
        modelId: 'claude-haiku-4-5',
      });

      const parent = orch.getScoops().find((s) => s.jid === 'parent-stable');
      expect(parent?.config?.modelId).toBe('claude-opus-4-6');
    });
  });

  // ── Error surfacing: scoopError vs prompt() throw precedence ─────
  //
  // Regression guard uncovered by VAL-LIVE-010 on a fresh profile with no
  // provider configured:
  //
  //   1. `ScoopContext.init()` catches its own failure (e.g. no API key for
  //      the selected provider) and fires `callbacks.onError(msg)` instead
  //      of re-throwing. The bridge's `onError` hook captures the specific
  //      message into `scoopError`.
  //   2. Control returns to the bridge, which proceeds to `ctx.prompt()`.
  //   3. `ctx.prompt()` throws `new Error('Agent not initialized')` because
  //      init never completed successfully.
  //   4. The bridge's outer `catch` previously overwrote the specific
  //      scoopError with the generic prompt failure via `errText(err)`.
  //
  // Fix: when catching a prompt-level throw, prefer `scoopError` (if a
  // specific scoop-level error was surfaced earlier) over the generic
  // prompt text. When no scoopError was captured, fall back to the
  // prompt's own error text — no regression for genuine prompt-time
  // failures.

  describe('error surfacing: scoopError takes precedence over prompt() throw', () => {
    it('prefers scoopError from init()-onError over a later generic "Agent not initialized" throw', async () => {
      // Mirrors the real VAL-LIVE-010 flow: ScoopContext.init() swallows its
      // failure and surfaces the specific message via callbacks.onError(msg).
      // ctx.prompt() then throws the generic follow-up because init never
      // completed. The bridge must return the specific init-time message.
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: (args) => ({
          async init() {
            // Match ScoopContext.init()'s swallow semantics: surface via
            // callback and return normally (do NOT re-throw).
            args.callbacks.onError('No API key configured for provider "anthropic"');
          },
          async prompt() {
            throw new Error('Agent not initialized');
          },
          dispose() {},
          getAgentMessages() {
            return [];
          },
        }),
        generateUid: () => 'init-fail',
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(1);
      expect(result.finalText).toBe('No API key configured for provider "anthropic"');
    });

    it('uses prompt() error text when prompt throws without any prior onError (regression guard)', async () => {
      // init() resolves cleanly and fires NO onError calls — scoopError
      // stays null. ctx.prompt() then throws a genuine network error. The
      // bridge must use the prompt's own error text, proving the
      // preservation path does not swallow real prompt-time failures.
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: () => ({
          async init() {},
          async prompt() {
            throw new Error('Network error: ECONNRESET');
          },
          dispose() {},
          getAgentMessages() {
            return [];
          },
        }),
        generateUid: () => 'prompt-fail-no-onerror',
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(1);
      expect(result.finalText).toBe('Network error: ECONNRESET');
    });

    it('suppresses generic "Agent not initialized" onError follow-up when a prior scoopError was captured (real-runtime VAL-LIVE-010 shape)', async () => {
      // Real-runtime shape observed in VAL-LIVE-010 (val-live-010.json):
      //   - ScoopContext.init() catches its own init failure (no API key)
      //     and calls callbacks.onError('Failed to initialize: No API key
      //     configured for provider "anthropic"'), then returns NORMALLY
      //     (does NOT throw).
      //   - Because init swallowed, the bridge proceeds to ctx.prompt().
      //   - ScoopContext.prompt() at scoop-context.ts:305-311 observes
      //     `this.agent === null` and fires
      //     callbacks.onError('Agent not initialized') — then RETURNS
      //     NORMALLY (also does NOT throw).
      //   - The bridge never enters its catch branch; instead, it reaches
      //     the post-prompt promotion path. Under last-wins onError
      //     semantics, `scoopError` would be 'Agent not initialized' —
      //     erasing the specific init-time error that the user needs.
      //
      // The fix suppresses the literal 'Agent not initialized' follow-up
      // when a prior scoopError has already been captured, so the user-
      // visible finalText stays the specific init-time message.
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: (args) => ({
          async init() {
            // Match ScoopContext.init() — emit via callback, do NOT throw.
            args.callbacks.onError(
              'Failed to initialize: No API key configured for provider "anthropic"'
            );
          },
          async prompt() {
            // Match ScoopContext.prompt() when agent === null — emit via
            // callback, do NOT throw.
            args.callbacks.onError('Agent not initialized');
          },
          dispose() {},
          getAgentMessages() {
            return [];
          },
        }),
        generateUid: () => 'real-runtime-init-fail',
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(1);
      expect(result.finalText).toBe(
        'Failed to initialize: No API key configured for provider "anthropic"'
      );
    });
  });

  // ── Sanity: FsError is what RestrictedFS throws ───────────────────

  describe('FsError sanity', () => {
    it("RestrictedFS built by the bridge throws FsError('EACCES') for /workspace/ writes", async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'fsx',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

      const rfs = captured[0].args.fs;
      try {
        await rfs.writeFile('/workspace/x.txt', 'x');
        throw new Error('expected EACCES');
      } catch (err) {
        expect(err).toBeInstanceOf(FsError);
        expect((err as FsError).code).toBe('EACCES');
      }
    });
  });
});
