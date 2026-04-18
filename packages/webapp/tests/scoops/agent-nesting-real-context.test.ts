/**
 * REAL-ScoopContext integration tests — nesting and parent-abort.
 *
 * These scenarios close the gaps identified by scrutiny round 1:
 *
 *   - VAL-NEST-002 / VAL-NEST-003 / VAL-NEST-015 — the nesting/concurrency
 *     suite in `agent-nesting.test.ts` exercises mocked `createContext`
 *     seams, NOT the production path (real `ScoopContext` + `WasmShell` +
 *     bash-tool dispatch). This file drives the FULL production stack:
 *     outer scoop emits a `bash` tool_use whose command is
 *     `agent . "*" "inner"` → the scoop's WasmShell resolves the `agent`
 *     supplemental command → `globalThis.__slicc_agent.spawn()` opens an
 *     inner real ScoopContext. The inner scoop's `send_message` payload
 *     bubbles back through the outer's bash tool_result and out to stdout.
 *
 *   - VAL-CROSS-007 — the abort scenario in `agent-hardening.test.ts`
 *     rejects the mocked `ctx.prompt()` directly; it does NOT exercise the
 *     pi-ai stream error path. This file scripts a pi-ai provider whose
 *     stream emits `{ type: 'error', reason: 'aborted' }` — the real agent
 *     loop treats the error event as terminal, the scoop ends with
 *     `errorMessage` set on the last assistant message, and the bridge
 *     MUST treat that as a failed spawn (exit 1 + cleanup).
 *
 * Only the lowest seam (pi-ai stream) is mocked. The bridge is published
 * with NO `createContext` override so a real `new ScoopContext(...)` runs
 * end-to-end.
 */

import 'fake-indexeddb/auto';
import type { IFileSystem } from 'just-bash';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── vi.mock for provider-settings ────────────────────────────────────
//
// REAL `ScoopContext.init()` reaches into `../ui/provider-settings.js` for
// `getApiKey`, `resolveCurrentModel`, `resolveModelById`, and
// `getSelectedProvider`. In a vitest environment there is no real
// localStorage / provider registry, so we pin those functions to a
// deterministic stub model whose `api` matches the pi-ai provider stub
// registered in `beforeAll` further down.
vi.mock('../../src/ui/provider-settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/provider-settings.js')>();
  const STUB_MODEL = {
    id: 'stub-real-ctx-model',
    name: 'Stub Real Context Model',
    api: 'stub-real-ctx-api',
    provider: 'stub-real-ctx-provider',
    baseUrl: 'http://stub-real-ctx.invalid',
    reasoning: false,
    input: ['text'] as Array<'text' | 'image'>,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4_096,
  };
  return {
    ...actual,
    getApiKey: () => 'stub-real-ctx-api-key',
    resolveCurrentModel: () => STUB_MODEL,
    resolveModelById: (id?: string) => (id ? { ...STUB_MODEL, id } : STUB_MODEL),
    getSelectedProvider: () => 'stub-real-ctx-provider',
    getAllAvailableModels: () => [
      {
        providerId: 'stub-real-ctx-provider',
        models: [{ id: 'stub-real-ctx-model', api: 'stub-real-ctx-api' }],
      },
    ],
  };
});

import {
  registerApiProvider,
  unregisterApiProviders,
  createAssistantMessageEventStream,
  type Context as PiContext,
  type Model as PiModel,
  type Api as PiApi,
  type StreamOptions as PiStreamOptions,
  type SimpleStreamOptions as PiSimpleStreamOptions,
  type AssistantMessage as PiAssistantMessage,
  type ToolCall as PiToolCall,
  type AssistantMessageEventStream as PiAssistantMessageEventStream,
  type Message as PiMessage,
  type UserMessage as PiUserMessage,
  type ToolResultMessage as PiToolResultMessage,
} from '@mariozechner/pi-ai';
import {
  publishAgentBridge,
  AGENT_BRIDGE_GLOBAL_KEY,
  type AgentBridge,
} from '../../src/scoops/agent-bridge.js';
import { Orchestrator } from '../../src/scoops/orchestrator.js';
import type { RegisteredScoop, ScoopTabState } from '../../src/scoops/types.js';
import { type VirtualFS } from '../../src/fs/virtual-fs.js';
import * as db from '../../src/scoops/db.js';
import { createAgentCommand } from '../../src/shell/supplemental-commands/agent-command.js';

// ─── Fixtures ─────────────────────────────────────────────────────────

function stubWindowForOrchestrator(): void {
  vi.stubGlobal('window', {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  });
}

async function ensureSharedFsDirs(vfs: VirtualFS): Promise<void> {
  for (const dir of ['/workspace', '/shared', '/scoops', '/home', '/tmp']) {
    try {
      await vfs.mkdir(dir, { recursive: true });
    } catch {
      /* already-exists */
    }
  }
}

function makeOrchestrator(
  onStatusChange: (jid: string, status: ScoopTabState['status']) => void = () => {}
): Orchestrator {
  return new Orchestrator(
    {} as unknown as HTMLElement,
    {
      onResponse: () => {},
      onResponseDone: () => {},
      onSendMessage: () => {},
      onStatusChange,
      onError: () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getBrowserAPI: () => ({}) as any,
    },
    { name: 'sliccy', triggerPattern: /^@sliccy\b/i }
  );
}

function clearPublishedBridge(): void {
  delete (globalThis as Record<string, unknown>)[AGENT_BRIDGE_GLOBAL_KEY];
}

/** Shell `ctx` shape matching the `defineCommand` callback contract. */
function createMockShellCtx(vfs: VirtualFS, cwd = '/home') {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
    exists: (p: string) => vfs.exists(p),
    stat: async (p: string) => {
      const s = await vfs.stat(p);
      return {
        isFile: s.type === 'file',
        isDirectory: s.type === 'directory',
        isSymbolicLink: false,
        mode: 0o755,
        size: s.size,
        mtime: new Date(s.mtime),
      };
    },
  };
  return {
    fs: fs as IFileSystem,
    cwd,
    env: new Map<string, string>(),
    stdin: '',
  };
}

/** Build a base AssistantMessage with no content blocks. */
function makeAssistantMessage(
  model: PiModel<PiApi>,
  content: PiAssistantMessage['content'],
  stopReason: PiAssistantMessage['stopReason'],
  errorMessage?: string
): PiAssistantMessage {
  const msg: PiAssistantMessage = {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
  if (errorMessage !== undefined) msg.errorMessage = errorMessage;
  return msg;
}

/** Push a single tool-call assistant turn through the event stream. */
function pushToolCallTurn(
  stream: PiAssistantMessageEventStream,
  model: PiModel<PiApi>,
  toolCall: PiToolCall
): void {
  const partial = makeAssistantMessage(model, [], 'toolUse');
  stream.push({ type: 'start', partial });
  stream.push({
    type: 'toolcall_start',
    contentIndex: 0,
    partial: makeAssistantMessage(model, [toolCall], 'toolUse'),
  });
  const final = makeAssistantMessage(model, [toolCall], 'toolUse');
  stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: final });
  stream.push({ type: 'done', reason: 'toolUse', message: final });
}

/** Push a terminal (no-tool, stop) assistant turn. */
function pushStopTurn(stream: PiAssistantMessageEventStream, model: PiModel<PiApi>): void {
  const final = makeAssistantMessage(model, [], 'stop');
  stream.push({ type: 'start', partial: final });
  stream.push({ type: 'done', reason: 'stop', message: final });
}

/** Extract the most recent user message text from a context. */
function lastUserText(context: PiContext): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i] as PiMessage;
    if (msg.role === 'user') {
      const user = msg as PiUserMessage;
      if (typeof user.content === 'string') return user.content;
      const text = user.content.find((c) => c.type === 'text');
      if (text && text.type === 'text') return text.text;
    }
  }
  return '';
}

/** Count toolResult messages following the most recent `role: 'user'`. */
function toolResultsSinceLastUser(context: PiContext): PiToolResultMessage[] {
  const result: PiToolResultMessage[] = [];
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i] as PiMessage;
    if (msg.role === 'user') break;
    if (msg.role === 'toolResult') result.unshift(msg);
  }
  return result;
}

// ─── Test suite ───────────────────────────────────────────────────────

describe('agent REAL ScoopContext — nesting and abort (integration)', () => {
  let orch: Orchestrator;
  let vfs: VirtualFS;
  const statusChangeCalls: Array<{ jid: string; status: ScoopTabState['status'] }> = [];

  beforeEach(async () => {
    stubWindowForOrchestrator();
    await db.initDB();
    clearPublishedBridge();
    statusChangeCalls.length = 0;
    orch = makeOrchestrator((jid, status) => {
      statusChangeCalls.push({ jid, status });
    });
    await orch.init();
    const sharedFs = orch.getSharedFS();
    if (!sharedFs) throw new Error('orchestrator.getSharedFS() null after init');
    vfs = sharedFs;
    await ensureSharedFsDirs(vfs);
  });

  afterEach(async () => {
    await orch.shutdown().catch(() => {});
    clearPublishedBridge();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────
  // VAL-NEST-002 / VAL-NEST-003 / VAL-NEST-015
  // Nested agent via real WasmShell + bash tool dispatch
  // ─────────────────────────────────────────────────────────────────────

  describe('nested agent via real WasmShell + bash (VAL-NEST-002, VAL-NEST-003, VAL-NEST-015)', () => {
    /**
     * Scripted pi-ai provider that differentiates outer vs inner scoops by
     * inspecting the last `user` message text in the streamed context.
     *
     *   - Outer scoop is seeded with `user: "outer-prompt"`:
     *       Turn 1 (no prior toolResult)  → `bash` tool_use with
     *         `agent . "*" "inner-prompt"`.
     *       Turn 2 (bash toolResult present) → `send_message` tool_use
     *         whose `text` echoes the bash tool result text.
     *       Turn 3+ (send_message toolResult present) → stop.
     *
     *   - Inner scoop is seeded with `user: "inner-prompt"`:
     *       Turn 1 → `send_message` tool_use with `text: "inner-ok"`.
     *       Turn 2+ → stop.
     */
    function registerNestingProvider(): { invocations: number } {
      const recording = { invocations: 0 };

      let toolCallIdCounter = 0;
      const nextToolCallId = (name: string): string => `${name}-tc-${++toolCallIdCounter}`;

      const script = (model: PiModel<PiApi>, context: PiContext): PiAssistantMessageEventStream => {
        recording.invocations += 1;
        const userText = lastUserText(context);
        const toolResults = toolResultsSinceLastUser(context);
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          if (userText === 'outer-prompt') {
            if (toolResults.length === 0) {
              pushToolCallTurn(stream, model, {
                type: 'toolCall',
                id: nextToolCallId('bash'),
                name: 'bash',
                arguments: { command: `agent . '*' 'inner-prompt'` },
              });
            } else if (toolResults[toolResults.length - 1].toolName === 'bash') {
              // Extract the bash tool result text to echo via send_message.
              const bashText = toolResults[toolResults.length - 1].content
                .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                .map((c) => c.text)
                .join('')
                .trim();
              pushToolCallTurn(stream, model, {
                type: 'toolCall',
                id: nextToolCallId('send_message'),
                name: 'send_message',
                arguments: { text: bashText },
              });
            } else {
              pushStopTurn(stream, model);
            }
          } else if (userText === 'inner-prompt') {
            if (toolResults.length === 0) {
              pushToolCallTurn(stream, model, {
                type: 'toolCall',
                id: nextToolCallId('send_message'),
                name: 'send_message',
                arguments: { text: 'inner-ok' },
              });
            } else {
              pushStopTurn(stream, model);
            }
          } else {
            pushStopTurn(stream, model);
          }
          stream.end();
        });
        return stream;
      };

      const streamFn = ((
        model: PiModel<PiApi>,
        context: PiContext,
        _options?: PiStreamOptions
      ): PiAssistantMessageEventStream => script(model, context)) as unknown as Parameters<
        typeof registerApiProvider
      >[0]['stream'];
      const streamSimpleFn = ((
        model: PiModel<PiApi>,
        context: PiContext,
        _options?: PiSimpleStreamOptions
      ): PiAssistantMessageEventStream => script(model, context)) as unknown as Parameters<
        typeof registerApiProvider
      >[0]['streamSimple'];

      registerApiProvider(
        {
          api: 'stub-real-ctx-api' as PiApi,
          stream: streamFn,
          streamSimple: streamSimpleFn,
        },
        'agent-real-ctx-nesting-test'
      );

      return recording;
    }

    let providerRecording: { invocations: number };

    beforeAll(() => {
      providerRecording = registerNestingProvider();
    });

    afterAll(() => {
      unregisterApiProviders('agent-real-ctx-nesting-test');
    });

    beforeEach(() => {
      providerRecording.invocations = 0;
    });

    it('outer scoop dispatches bash → inner agent → inner `send_message` bubbles to outer stdout; both scratch folders cleaned; registry + scratch snapshots unchanged', async () => {
      // Register a cone scoop so the orchestrator has its canonical entry
      // present during the run. The cone here is registry-only — no
      // ScoopContext is constructed for it, so no cone management tools
      // are ever invoked by this test. The real regression signal comes
      // from the functional assertions below (stdout bubble, jids snapshot,
      // scratch snapshot, scoop unregistration) — they catch any regression
      // that would cause the bridge to route through the cone's tool
      // surface or leak ephemeral scoops.
      const coneScoop: RegisteredScoop = {
        jid: 'cone-real-nesting',
        name: 'sliccy',
        folder: 'cone',
        isCone: true,
        type: 'cone',
        requiresTrigger: false,
        assistantLabel: 'sliccy',
        addedAt: new Date().toISOString(),
      };
      orch.registerExistingScoop(coneScoop);

      // Publish the bridge with NO createContext override — real
      // ScoopContext instances are constructed for the outer AND inner
      // spawns. Use a deterministic uid sequence so the assertions on
      // scratch-folder names are byte-exact.
      const uids = ['outer', 'inner'];
      let uidIdx = 0;
      publishAgentBridge(orch, vfs, orch.getSessionStore(), {
        generateUid: () => uids[uidIdx++] ?? `extra-${uidIdx}`,
        resolveModel: (id) => id,
        getInheritedModelId: () => 'stub-real-ctx-model',
      });

      // Snapshot of the /scoops/ directory before the spawn.
      const scratchBefore = (await vfs.readDir('/scoops').catch(() => []))
        .filter((e) => e.type === 'directory')
        .map((e) => e.name)
        .sort();

      const jidsBefore = orch
        .getScoops()
        .map((s) => s.jid)
        .sort();

      const result = await createAgentCommand().execute(
        ['.', '*', 'outer-prompt'],
        createMockShellCtx(vfs, '/home')
      );

      // (a) stdout contains the innermost send_message text, bubbled up
      // through the outer scoop's bash tool_result and out via the
      // outer's final send_message.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('inner-ok\n');
      expect(result.stderr).toBe('');

      // (b) Both scratch folders were created and then deleted in
      // reverse-finish order. /scoops/ directory post-run matches the
      // pre-run listing exactly (no sibling churn).
      const scratchAfter = (await vfs.readDir('/scoops').catch(() => []))
        .filter((e) => e.type === 'directory')
        .map((e) => e.name)
        .sort();
      expect(scratchAfter).toEqual(scratchBefore);
      expect(await vfs.exists('/scoops/agent-outer')).toBe(false);
      expect(await vfs.exists('/scoops/agent-inner')).toBe(false);

      // (c) Orchestrator registry still contains the cone only — both
      // ephemeral bridge scoops were unregistered.
      const jidsAfter = orch
        .getScoops()
        .map((s) => s.jid)
        .sort();
      expect(jidsAfter).toEqual(jidsBefore);
      expect(orch.getScoop('agent_outer')).toBeUndefined();
      expect(orch.getScoop('agent_inner')).toBeUndefined();
      expect(orch.getScoopTabState('agent_outer')).toBeUndefined();
      expect(orch.getScoopTabState('agent_inner')).toBeUndefined();

      // Sanity: the scripted provider was invoked for BOTH depths
      // (outer: 3 turns, inner: 2 turns = 5 total).
      expect(providerRecording.invocations).toBeGreaterThanOrEqual(5);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // VAL-CROSS-007 — Parent-abort via real pi-ai stream error event
  // ─────────────────────────────────────────────────────────────────────

  describe('parent-abort via real LLM-stream rejection (VAL-CROSS-007)', () => {
    /**
     * Scripted pi-ai provider whose stream pushes a terminal `error` event
     * with `reason: 'aborted'`, simulating an AbortError that propagated
     * into the pi-ai stream (e.g., parent teardown cancelling the request).
     *
     * The pi-agent-core loop treats the event as terminal (same as `done`)
     * and ends the run with the partial assistant message whose
     * `stopReason === 'aborted'` and `errorMessage === 'aborted'`. That
     * final message is what the real ScoopContext's `agent_end` handler
     * observes and surfaces through `callbacks.onError(errorMessage)`.
     * The bridge must translate that into a failed spawn (exit code 1)
     * while still running its full cleanup chain (scratch folder deletion,
     * orchestrator unregister, UI tab removal).
     */
    function registerAbortProvider(): { invocations: number } {
      const recording = { invocations: 0 };

      const script = (
        model: PiModel<PiApi>,
        _context: PiContext
      ): PiAssistantMessageEventStream => {
        recording.invocations += 1;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const partial = makeAssistantMessage(model, [], 'aborted', 'aborted');
          stream.push({ type: 'start', partial });
          stream.push({ type: 'error', reason: 'aborted', error: partial });
          stream.end();
        });
        return stream;
      };

      const streamFn = ((
        model: PiModel<PiApi>,
        context: PiContext,
        _options?: PiStreamOptions
      ): PiAssistantMessageEventStream => script(model, context)) as unknown as Parameters<
        typeof registerApiProvider
      >[0]['stream'];
      const streamSimpleFn = ((
        model: PiModel<PiApi>,
        context: PiContext,
        _options?: PiSimpleStreamOptions
      ): PiAssistantMessageEventStream => script(model, context)) as unknown as Parameters<
        typeof registerApiProvider
      >[0]['streamSimple'];

      registerApiProvider(
        {
          api: 'stub-real-ctx-api' as PiApi,
          stream: streamFn,
          streamSimple: streamSimpleFn,
        },
        'agent-real-ctx-abort-test'
      );

      return recording;
    }

    let providerRecording: { invocations: number };

    beforeAll(() => {
      providerRecording = registerAbortProvider();
    });

    afterAll(() => {
      unregisterApiProviders('agent-real-ctx-abort-test');
    });

    beforeEach(() => {
      providerRecording.invocations = 0;
    });

    it('pi-ai stream emits `error:aborted` → spawn resolves with exit 1 + finalText; scratch deleted; scoop unregistered; onStatusChange(ready) fired', async () => {
      publishAgentBridge(orch, vfs, orch.getSessionStore(), {
        generateUid: () => 'aborted1',
        resolveModel: (id) => id,
        getInheritedModelId: () => 'stub-real-ctx-model',
      });

      // Pre-run invariant: no scratch folder, no registered scoop, no
      // status-change calls for this jid yet.
      expect(await vfs.exists('/scoops/agent-aborted1')).toBe(false);
      expect(orch.getScoop('agent_aborted1')).toBeUndefined();
      expect(statusChangeCalls.filter((c) => c.jid === 'agent_aborted1')).toEqual([]);

      const result = await createAgentCommand().execute(
        ['.', '*', 'please do something'],
        createMockShellCtx(vfs, '/home')
      );

      // (a) spawn resolved with exit 1 — the bridge did NOT silently
      // swallow the aborted stream and return exit 0 with empty stdout.
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      // stderr surfaces a single-line error that mentions the abort.
      expect(result.stderr).toMatch(/aborted/i);
      expect(result.stderr.split('\n').filter((l) => l.length > 0)).toHaveLength(1);

      // (b) Scratch folder deleted.
      expect(await vfs.exists('/scoops/agent-aborted1')).toBe(false);

      // (c) Scoop unregistered.
      expect(orch.getScoop('agent_aborted1')).toBeUndefined();
      expect(orch.getScoopTabState('agent_aborted1')).toBeUndefined();

      // (d) UI tab removed — the terminal onStatusChange(jid, 'ready')
      // callback fired during unregisterScoop (see cleanup-ordering
      // contract in orchestrator.ts).
      const readyCalls = statusChangeCalls.filter(
        (c) => c.jid === 'agent_aborted1' && c.status === 'ready'
      );
      expect(readyCalls.length).toBeGreaterThanOrEqual(1);

      // Sanity: the scripted provider streamed the error at least once.
      expect(providerRecording.invocations).toBeGreaterThanOrEqual(1);
    });
  });
});
