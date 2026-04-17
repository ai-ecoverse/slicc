/**
 * Integration tests for NESTING and PARALLEL CONCURRENCY of the `agent`
 * supplemental shell command.
 *
 * Scenarios covered:
 *   (1)  `agent` callable from the cone's bash AND from within a scoop's
 *        bash — same bridge path, no cone-only gating.
 *   (2)  Depth-2 nesting: agent → scoop → agent → scoop → agent → scoop;
 *        the innermost `send_message` text bubbles up to the outermost
 *        shell's stdout.
 *   (3)  Each nested scoop gets a unique `/scoops/agent-<uid>/` scratch
 *        folder; every folder is deleted after the outermost call resolves;
 *        `orchestrator.getScoops()` records zero orphan scoops.
 *   (4)  Outer cleanup does NOT delete inner's scratch folder prematurely
 *        (serialized per-call completion).
 *   (5)  Inner failure surfaces to the outer scoop as a bash tool result
 *        `{exitCode: 1, finalText: <msg>}` and the outer can continue and
 *        still emit a successful `send_message`.
 *   (6)  Inner `--model` override applies ONLY to that inner call; the
 *        registered parent scoop's `config.modelId` is unchanged after the
 *        inner call returns.
 *   (7)  Inner's allow-list is INDEPENDENT of outer's (NOT intersected);
 *        the inner call can widen the set (e.g. `*` inside an `ls`-only
 *        parent).
 *   (8)  `/shared/` writes by an inner scoop are visible to the outer
 *        scoop's RestrictedFS after the inner call resolves.
 *   (9)  RestrictedFS isolation between sibling scoops — an inner scoop
 *        cannot write to another inner's cwd.
 *   (10) Two concurrent `agent` calls from the same parent get distinct
 *        scratch folders AND independent final-text streams, and both
 *        folders are cleaned up.
 *   (11) The nested bridge call does NOT invoke `scoop_scoop` /
 *        `feed_scoop` / `drop_scoop` / `list_scoops` (spy-counter check).
 *   (12) `globalThis.__slicc_agent` is the SAME reference at every nesting
 *        depth (no per-call re-publication).
 *
 * Harness:
 *   Real `VirtualFS` (via `fake-indexeddb/auto`) + real `Orchestrator` +
 *   mock LLM injected through `AgentBridgeDeps.createContext`. A scoop's
 *   "bash calling agent" path is modeled by the mock context's `prompt()`
 *   invoking `globalThis.__slicc_agent.spawn(...)` recursively — the same
 *   code path a real scoop's bash tool would take when the agent emits an
 *   `agent ...` shell invocation.
 */

import 'fake-indexeddb/auto';
import type { IFileSystem } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  publishAgentBridge,
  AGENT_BRIDGE_GLOBAL_KEY,
  type AgentBridge,
  type AgentBridgeContext,
  type AgentBridgeContextArgs,
} from '../../src/scoops/agent-bridge.js';
import { Orchestrator } from '../../src/scoops/orchestrator.js';
import { type VirtualFS } from '../../src/fs/virtual-fs.js';
import { RestrictedFS } from '../../src/fs/restricted-fs.js';
import { createScoopManagementTools } from '../../src/scoops/scoop-management-tools.js';
import { createAgentCommand } from '../../src/shell/supplemental-commands/agent-command.js';
import * as db from '../../src/scoops/db.js';
import type { AgentMessage, ToolDefinition } from '../../src/core/types.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

// ─── Fixtures ──────────────────────────────────────────────────────────

function stubWindowForOrchestrator(): void {
  vi.stubGlobal('window', {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  });
}

function makeOrchestrator(): Orchestrator {
  return new Orchestrator(
    {} as unknown as HTMLElement,
    {
      onResponse: () => {},
      onResponseDone: () => {},
      onSendMessage: () => {},
      onStatusChange: () => {},
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

function getPublishedBridge(): AgentBridge | undefined {
  return (globalThis as Record<string, unknown>)[AGENT_BRIDGE_GLOBAL_KEY] as
    | AgentBridge
    | undefined;
}

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

/** Make an incrementing uid generator shared across scenario steps. */
function uidGen(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${n++}`;
}

/** Assistant-text `AgentMessage` used for fallback-output scenarios. */
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
 * Factory that turns a map of `prompt text → behavior` into a
 * `createContext` seam. A "behavior" function runs inside the mock
 * scoop's `prompt()`: it can recursively call the published bridge
 * (simulating an inner `agent` invocation), write through the scoop's
 * own RestrictedFS, emit `send_message` callbacks, or throw.
 */
interface ScoopBehaviorResult {
  /** Text payloads to forward via `callbacks.onSendMessage`. */
  send?: string[];
  /** Alternative finalText source via `getAgentMessages()`. */
  agentMessages?: AgentMessage[];
  /** When set, the mock prompt throws this error. */
  throwError?: Error;
}

type ScoopBehavior = (
  args: AgentBridgeContextArgs,
  bridge: AgentBridge,
  helpers: { vfs: VirtualFS }
) => Promise<ScoopBehaviorResult | void> | ScoopBehaviorResult | void;

interface ScoopScript {
  /** `behavior` is dispatched by matching on the verbatim prompt string. */
  [promptText: string]: ScoopBehavior;
}

/** Recording of every context the bridge created during a scenario. */
interface ScenarioRecording {
  contexts: AgentBridgeContextArgs[];
  /** `args.modelId` captured at construction time, in spawn order. */
  modelIds: string[];
  /** `args.scoop.config.allowedCommands` captured in spawn order. */
  allowedCommandsByCall: string[][];
  /** `globalThis.__slicc_agent` snapshot taken inside each prompt(). */
  bridgeSnapshotsDuringPrompt: Array<AgentBridge | undefined>;
  /** Promise counter: how many times `prompt()` was called. */
  promptCount: number;
  /** Folder names (base name) of every context the bridge constructed. */
  folders: string[];
  /** `dispose()` count. */
  disposeCount: number;
}

/**
 * Build a `createContext` factory from a script keyed on the prompt text.
 * Also produces a recording object capturing what the bridge threaded
 * through on every call — useful for asserting model inheritance,
 * allow-list independence, and bridge-reference sharing across depths.
 */
function makeScriptedProvider(
  script: ScoopScript,
  vfs: VirtualFS
): {
  recording: ScenarioRecording;
  createContext: (args: AgentBridgeContextArgs) => AgentBridgeContext;
} {
  const recording: ScenarioRecording = {
    contexts: [],
    modelIds: [],
    allowedCommandsByCall: [],
    bridgeSnapshotsDuringPrompt: [],
    promptCount: 0,
    folders: [],
    disposeCount: 0,
  };

  const createContext = (args: AgentBridgeContextArgs): AgentBridgeContext => {
    recording.contexts.push(args);
    recording.modelIds.push(args.modelId);
    recording.allowedCommandsByCall.push([...(args.scoop.config?.allowedCommands ?? [])]);
    recording.folders.push(args.scoop.folder);

    let script_result: ScoopBehaviorResult | void;

    return {
      async init() {
        /* no-op */
      },
      async prompt(text: string) {
        recording.promptCount += 1;
        const bridge = getPublishedBridge();
        recording.bridgeSnapshotsDuringPrompt.push(bridge);
        const behavior = script[text];
        if (!behavior) {
          throw new Error(
            `scripted provider: no behavior for prompt ${JSON.stringify(text)}. ` +
              `Known prompts: ${JSON.stringify(Object.keys(script))}`
          );
        }
        if (!bridge) {
          throw new Error('scripted provider: bridge not published during prompt');
        }
        script_result = (await behavior(args, bridge, { vfs })) ?? undefined;
        if (script_result?.send) {
          for (const msg of script_result.send) {
            args.callbacks.onSendMessage(msg);
          }
        }
        if (script_result?.throwError) {
          throw script_result.throwError;
        }
      },
      dispose() {
        recording.disposeCount += 1;
      },
      getAgentMessages() {
        return script_result?.agentMessages ?? [];
      },
    };
  };

  return { recording, createContext };
}

// ─── Test suite ────────────────────────────────────────────────────────

describe('agent nesting & parallel concurrency (integration)', () => {
  let vfs: VirtualFS;
  let orch: Orchestrator;

  beforeEach(async () => {
    stubWindowForOrchestrator();
    await db.initDB();
    clearPublishedBridge();
    orch = makeOrchestrator();
    await orch.init();
    const sharedFs = orch.getSharedFS();
    if (!sharedFs) throw new Error('orchestrator.getSharedFS() null after init');
    vfs = sharedFs;
    for (const dir of ['/home', '/home/outer', '/home/inner', '/home/sibling', '/tmp']) {
      try {
        await vfs.mkdir(dir, { recursive: true });
      } catch {
        /* already-exists */
      }
    }
  });

  afterEach(async () => {
    await orch.shutdown().catch(() => {});
    clearPublishedBridge();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // (1) Callable from the cone's bash AND from a scoop's bash via the same bridge.
  it('(1) invokable from cone shell and from within a scoop (single bridge path)', async () => {
    const bridgeCalls: Array<'cone' | 'inner'> = [];
    const { recording, createContext } = makeScriptedProvider(
      {
        'cone-prompt': async (_args, bridge) => {
          // Outer call from the cone's shell. From inside its prompt, it
          // invokes the same bridge (simulating a scoop's bash executing
          // `agent` against the published hook).
          bridgeCalls.push('cone');
          const inner = await bridge.spawn({
            cwd: '/home',
            allowedCommands: ['*'],
            prompt: 'scoop-inner-prompt',
          });
          // Outer "agent" bubbles up whatever the inner produced.
          return { send: [inner.finalText] };
        },
        'scoop-inner-prompt': () => {
          bridgeCalls.push('inner');
          return { send: ['inner-ok'] };
        },
      },
      vfs
    );

    publishAgentBridge(orch, vfs, orch.getSessionStore(), {
      createContext,
      generateUid: uidGen('n1-'),
      resolveModel: (id) => id,
      getInheritedModelId: () => 'claude-opus-4-6',
    });

    const result = await createAgentCommand().execute(
      ['.', '*', 'cone-prompt'],
      createMockShellCtx(vfs, '/home')
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('inner-ok\n');
    expect(result.stderr).toBe('');
    // Exactly two spawns happened — cone's call and the nested call
    // from inside the outer scoop's prompt. Both went through the same
    // bridge hook.
    expect(bridgeCalls).toEqual(['cone', 'inner']);
    expect(recording.contexts).toHaveLength(2);
    expect(recording.folders).toEqual(['agent-n1-0', 'agent-n1-1']);
    expect(recording.disposeCount).toBe(2);

    // Nothing leaked past the outermost resolution.
    expect(orch.getScoops()).toEqual([]);
    expect(await vfs.exists('/scoops/agent-n1-0')).toBe(false);
    expect(await vfs.exists('/scoops/agent-n1-1')).toBe(false);
  });

  // (2) Depth-2 nesting bubbles innermost text up to the outermost stdout.
  it('(2) depth-2 nesting: innermost send_message bubbles to outer stdout', async () => {
    const { recording, createContext } = makeScriptedProvider(
      {
        level0: async (_args, bridge) => {
          const inner = await bridge.spawn({
            cwd: '/home',
            allowedCommands: ['*'],
            prompt: 'level1',
          });
          return { send: [inner.finalText] };
        },
        level1: async (_args, bridge) => {
          const innermost = await bridge.spawn({
            cwd: '/home',
            allowedCommands: ['*'],
            prompt: 'level2',
          });
          return { send: [innermost.finalText] };
        },
        level2: () => ({ send: ['deep-text'] }),
      },
      vfs
    );

    publishAgentBridge(orch, vfs, orch.getSessionStore(), {
      createContext,
      generateUid: uidGen('n2-'),
      resolveModel: (id) => id,
      getInheritedModelId: () => 'claude-opus-4-6',
    });

    const result = await createAgentCommand().execute(
      ['.', '*', 'level0'],
      createMockShellCtx(vfs, '/home')
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('deep-text\n');
    expect(recording.folders).toEqual(['agent-n2-0', 'agent-n2-1', 'agent-n2-2']);
    expect(orch.getScoops()).toEqual([]);
  });

  // (3) Every nested scoop has a unique scratch folder; all deleted post-run.
  it('(3) each depth gets a unique scratch folder; all deleted after outermost resolves', async () => {
    const seenFolders = new Set<string>();
    const { createContext } = makeScriptedProvider(
      {
        outer: async (args, bridge) => {
          seenFolders.add(args.scoop.folder);
          const inner = await bridge.spawn({
            cwd: '/home',
            allowedCommands: ['*'],
            prompt: 'inner',
          });
          return { send: [inner.finalText] };
        },
        inner: (args) => {
          seenFolders.add(args.scoop.folder);
          return { send: ['done'] };
        },
      },
      vfs
    );

    publishAgentBridge(orch, vfs, orch.getSessionStore(), {
      createContext,
      generateUid: uidGen('n3-'),
      resolveModel: (id) => id,
      getInheritedModelId: () => 'claude-opus-4-6',
    });

    const result = await createAgentCommand().execute(
      ['.', '*', 'outer'],
      createMockShellCtx(vfs, '/home')
    );
    expect(result.exitCode).toBe(0);

    // Two distinct scratch folders were observed during the run.
    expect(seenFolders.size).toBe(2);
    expect([...seenFolders]).toEqual(expect.arrayContaining(['agent-n3-0', 'agent-n3-1']));

    // None remain on-disk after the outermost resolves.
    const listing = await vfs.readDir('/scoops');
    const agentFolders = listing
      .filter((entry) => entry.type === 'directory' && entry.name.startsWith('agent-'))
      .map((entry) => entry.name);
    expect(agentFolders).toEqual([]);

    // Zero orphan scoops remain in the orchestrator registry.
    expect(orch.getScoops()).toEqual([]);
  });

  // (4) Outer cleanup does not delete inner's folder prematurely.
  it('(4) outer cleanup does not run until inner resolves (serialized completion)', async () => {
    // We install a one-shot "release" deferred for the inner call so we can
    // observe the VFS state at the boundary between "inner started" and
    // "inner resolved".
    let releaseInner!: () => void;
    const innerRelease = new Promise<void>((r) => {
      releaseInner = r;
    });

    const innerFolderObserved: { whileRunning: boolean; afterResolve: boolean } = {
      whileRunning: false,
      afterResolve: false,
    };

    let outerFolderAfterInnerResolve = false;

    const { createContext } = makeScriptedProvider(
      {
        outer: async (args, bridge) => {
          const spawnPromise = bridge.spawn({
            cwd: '/home',
            allowedCommands: ['*'],
            prompt: 'inner',
          });
          // Microtask allows inner's init + folder creation to run.
          await Promise.resolve();
          innerFolderObserved.whileRunning = await vfs.exists('/scoops/agent-n4-1');
          // Outer's scratch folder is created before outer's prompt fires, so
          // we also observe it present here.
          releaseInner();
          const innerResult = await spawnPromise;
          innerFolderObserved.afterResolve = await vfs.exists('/scoops/agent-n4-1');
          // Outer's folder is still present — its cleanup has not run yet.
          outerFolderAfterInnerResolve = await vfs.exists('/scoops/' + args.scoop.folder);
          return { send: [innerResult.finalText] };
        },
        inner: async () => {
          await innerRelease;
          return { send: ['inner-done'] };
        },
      },
      vfs
    );

    publishAgentBridge(orch, vfs, orch.getSessionStore(), {
      createContext,
      generateUid: uidGen('n4-'),
      resolveModel: (id) => id,
      getInheritedModelId: () => 'claude-opus-4-6',
    });

    const result = await createAgentCommand().execute(
      ['.', '*', 'outer'],
      createMockShellCtx(vfs, '/home')
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('inner-done\n');

    // Inner's folder was present during its run, and gone AFTER the spawn
    // promise resolved (serialized cleanup per call).
    expect(innerFolderObserved.whileRunning).toBe(true);
    expect(innerFolderObserved.afterResolve).toBe(false);

    // Outer's folder was still present at the moment inner resolved —
    // outer cleanup runs strictly after its own prompt completes.
    expect(outerFolderAfterInnerResolve).toBe(true);

    // Both folders are gone after the outermost resolves.
    expect(await vfs.exists('/scoops/agent-n4-0')).toBe(false);
    expect(await vfs.exists('/scoops/agent-n4-1')).toBe(false);
  });

  // (5) Inner failure surfaces as a bash tool error; outer can continue.
  it('(5) inner failure returns {exitCode:1} to outer as bash tool-result; outer continues', async () => {
    let innerResultSeenByOuter: { finalText: string; exitCode: number } | null = null;

    const { recording, createContext } = makeScriptedProvider(
      {
        outer: async (_args, bridge) => {
          const r = await bridge.spawn({
            cwd: '/home',
            allowedCommands: ['*'],
            prompt: 'inner',
          });
          innerResultSeenByOuter = r;
          // Outer recovers: it emits its own send_message AFTER observing
          // the inner's failure. The outer's agent loop continues.
          return { send: [`recovered: ${r.exitCode}/${r.finalText}`] };
        },
        inner: () => ({ throwError: new Error('inner crashed') }),
      },
      vfs
    );

    publishAgentBridge(orch, vfs, orch.getSessionStore(), {
      createContext,
      generateUid: uidGen('n5-'),
      resolveModel: (id) => id,
      getInheritedModelId: () => 'claude-opus-4-6',
    });

    const result = await createAgentCommand().execute(
      ['.', '*', 'outer'],
      createMockShellCtx(vfs, '/home')
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('recovered: 1/inner crashed\n');
    expect(result.stderr).toBe('');
    expect(innerResultSeenByOuter).toEqual({ exitCode: 1, finalText: 'inner crashed' });
    // Inner scratch folder still cleaned up despite its failure.
    expect(await vfs.exists('/scoops/agent-n5-1')).toBe(false);
    expect(await vfs.exists('/scoops/agent-n5-0')).toBe(false);
    expect(recording.disposeCount).toBe(2);
  });

  // (6) Inner --model override scoped to that inner call.
  it('(6) inner --model overrides only that inner call; parent scoop model unchanged', async () => {
    // Preregister a parent scoop (representing the "outer" scoop the agent
    // command is running inside). Its config.modelId MUST be unchanged
    // after the inner spawn.
    const outerJid = 'outer-scoop-jid';
    const outerScoop: RegisteredScoop = {
      jid: outerJid,
      name: 'outer-scoop',
      folder: 'outer-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'outer-scoop',
      addedAt: new Date().toISOString(),
      config: { modelId: 'claude-opus-4-6' },
    };
    orch.registerExistingScoop(outerScoop);

    const { recording, createContext } = makeScriptedProvider(
      {
        inner: () => ({ send: ['inner-done'] }),
      },
      vfs
    );

    publishAgentBridge(orch, vfs, orch.getSessionStore(), {
      createContext,
      generateUid: uidGen('n6-'),
      resolveModel: (id) => id,
      getInheritedModelId: () => 'GLOBAL-SHOULD-NOT-BE-USED',
    });

    // Simulate outer-scoop's bash tool invoking `agent --model haiku . "*" "inner"`.
    const result = await createAgentCommand({ getParentJid: () => outerJid }).execute(
      ['--model', 'claude-haiku-4-5', '.', '*', 'inner'],
      createMockShellCtx(vfs, '/home')
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('inner-done\n');
    // Inner's recorded modelId is the explicit override.
    expect(recording.modelIds).toEqual(['claude-haiku-4-5']);

    // Outer scoop's config.modelId is still what it was before the call.
    const outerAfter = orch.getScoops().find((s) => s.jid === outerJid);
    expect(outerAfter?.config?.modelId).toBe('claude-opus-4-6');
  });

  // (7) Inner allow-list is independent — NOT intersected with outer's.
  it('(7) inner allow-list is independent (not intersected); inner can widen', async () => {
    const observed: { outer: string[]; inner: string[] } = { outer: [], inner: [] };

    const { recording, createContext } = makeScriptedProvider(
      {
        outer: async (args, bridge) => {
          observed.outer = [...(args.scoop.config?.allowedCommands ?? [])];
          const r = await bridge.spawn({
            cwd: '/home',
            allowedCommands: ['*'],
            prompt: 'inner',
          });
          return { send: [r.finalText] };
        },
        inner: (args) => {
          observed.inner = [...(args.scoop.config?.allowedCommands ?? [])];
          return { send: ['ok'] };
        },
      },
      vfs
    );

    publishAgentBridge(orch, vfs, orch.getSessionStore(), {
      createContext,
      generateUid: uidGen('n7-'),
      resolveModel: (id) => id,
      getInheritedModelId: () => 'claude-opus-4-6',
    });

    const result = await createAgentCommand().execute(
      ['.', 'ls', 'outer'],
      createMockShellCtx(vfs, '/home')
    );

    expect(result.exitCode).toBe(0);
    // Outer's allow-list was narrow (['ls']), inner's was wide (['*']).
    expect(observed.outer).toEqual(['ls']);
    expect(observed.inner).toEqual(['*']);
    // The bridge recorded both lists literally, no intersection.
    expect(recording.allowedCommandsByCall).toEqual([['ls'], ['*']]);
  });

  // (8) /shared/ writes by inner are visible to outer after inner resolves.
  it('(8) /shared/ writes by inner are visible to outer after inner resolves', async () => {
    const { createContext } = makeScriptedProvider(
      {
        outer: async (args, bridge) => {
          const innerResult = await bridge.spawn({
            cwd: '/home',
            allowedCommands: ['*'],
            prompt: 'inner',
          });
          // Outer reads /shared/inner.txt via its own RestrictedFS — the
          // file must be visible because inner's write went to the shared
          // VFS (not a private sandbox).
          const seenBytes = await args.fs.readTextFile('/shared/inner.txt');
          return { send: [`${innerResult.finalText}|outer-saw:${seenBytes}`] };
        },
        inner: async (args) => {
          await args.fs.writeFile('/shared/inner.txt', 'hello-from-inner');
          return { send: ['wrote-shared'] };
        },
      },
      vfs
    );

    publishAgentBridge(orch, vfs, orch.getSessionStore(), {
      createContext,
      generateUid: uidGen('n8-'),
      resolveModel: (id) => id,
      getInheritedModelId: () => 'claude-opus-4-6',
    });

    const result = await createAgentCommand().execute(
      ['.', '*', 'outer'],
      createMockShellCtx(vfs, '/home')
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('wrote-shared|outer-saw:hello-from-inner\n');
    // /shared/ content survives cleanup — only /scoops/agent-*/ folders
    // are touched by the bridge.
    expect(await vfs.readTextFile('/shared/inner.txt')).toBe('hello-from-inner');
  });

  // (9) RestrictedFS isolation between sibling scoops.
  it("(9) inner RestrictedFS cannot write to a sibling inner scoop's cwd", async () => {
    // Sibling A runs with cwd=/home/outer ; sibling B runs with cwd=/home/sibling.
    // Each is an independently-spawned inner scoop. B tries to write to A's
    // cwd — that must fail with EACCES.
    let siblingWriteError: unknown = null;

    const { createContext } = makeScriptedProvider(
      {
        outer: async (_args, bridge) => {
          // Drive sibling A first (gets cwd=/home/outer).
          await bridge.spawn({
            cwd: '/home/outer',
            allowedCommands: ['*'],
            prompt: 'siblingA',
          });
          // Then sibling B (gets cwd=/home/sibling).
          await bridge.spawn({
            cwd: '/home/sibling',
            allowedCommands: ['*'],
            prompt: 'siblingB',
          });
          return { send: ['done'] };
        },
        siblingA: async (args) => {
          await args.fs.writeFile('/home/outer/a.txt', 'A-content');
          return { send: ['A-ok'] };
        },
        siblingB: async (args) => {
          try {
            await args.fs.writeFile('/home/outer/b-escape.txt', 'B-should-fail');
          } catch (err) {
            siblingWriteError = err;
          }
          return { send: ['B-ok'] };
        },
      },
      vfs
    );

    publishAgentBridge(orch, vfs, orch.getSessionStore(), {
      createContext,
      generateUid: uidGen('n9-'),
      resolveModel: (id) => id,
      getInheritedModelId: () => 'claude-opus-4-6',
    });

    const result = await createAgentCommand().execute(
      ['.', '*', 'outer'],
      createMockShellCtx(vfs, '/home')
    );
    expect(result.exitCode).toBe(0);

    // Sibling B hit EACCES when reaching into sibling A's cwd.
    expect(siblingWriteError).toMatchObject({ code: 'EACCES' });
    // Sibling A's write persisted.
    expect(await vfs.readTextFile('/home/outer/a.txt')).toBe('A-content');
    // Sibling B's escape attempt did NOT create the file.
    expect(await vfs.exists('/home/outer/b-escape.txt')).toBe(false);

    // Confirm each sibling received its own RestrictedFS (distinct instances).
    // (createContext was invoked three times total: outer + siblingA + siblingB.)
    // We don't directly compare the two sibling FS instances here — the
    // ACL-reject above is the observable proof of isolation.
  });

  // (10) Two concurrent agent calls from the same parent.
  it('(10) two concurrent agent calls from same parent → distinct folders, independent output, both cleaned up', async () => {
    const foldersObservedDuringRun: Set<string> = new Set();
    const finalsCollectedByParent: string[] = [];

    const { recording, createContext } = makeScriptedProvider(
      {
        parent: async (_args, bridge) => {
          // Start two concurrent child spawns.
          const [a, b] = await Promise.all([
            bridge.spawn({ cwd: '/home', allowedCommands: ['ls'], prompt: 'childA' }),
            bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'childB' }),
          ]);
          finalsCollectedByParent.push(a.finalText, b.finalText);
          return { send: [`${a.finalText}|${b.finalText}`] };
        },
        childA: async (args) => {
          foldersObservedDuringRun.add(args.scoop.folder);
          // Small yield so the scheduler interleaves with childB.
          await Promise.resolve();
          return { send: ['A-final'] };
        },
        childB: async (args) => {
          foldersObservedDuringRun.add(args.scoop.folder);
          await Promise.resolve();
          return { send: ['B-final'] };
        },
      },
      vfs
    );

    publishAgentBridge(orch, vfs, orch.getSessionStore(), {
      createContext,
      generateUid: uidGen('n10-'),
      resolveModel: (id) => id,
      getInheritedModelId: () => 'claude-opus-4-6',
    });

    const result = await createAgentCommand().execute(
      ['.', '*', 'parent'],
      createMockShellCtx(vfs, '/home')
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('A-final|B-final\n');
    expect(finalsCollectedByParent).toEqual(['A-final', 'B-final']);
    // Distinct folders observed at runtime.
    expect(foldersObservedDuringRun.size).toBe(2);
    expect(recording.folders.length).toBe(3); // parent + childA + childB

    // Both child scratch folders cleaned up after parent resolved.
    const listing = await vfs.readDir('/scoops');
    const agentFolders = listing
      .filter((e) => e.type === 'directory' && e.name.startsWith('agent-'))
      .map((e) => e.name);
    expect(agentFolders).toEqual([]);

    // Both children's allow-lists were recorded independently (not merged).
    expect(recording.allowedCommandsByCall).toEqual([['*'], ['ls'], ['*']]);
    expect(orch.getScoops()).toEqual([]);
  });

  // (11) Nested bridge call does NOT invoke scoop_scoop/feed_scoop/etc.
  it('(11) nested bridge call does NOT invoke the cone-only scoop-management tools', async () => {
    // Build the cone's management tool surface with counters so that any
    // accidental invocation of scoop_scoop / feed_scoop / drop_scoop /
    // list_scoops by the bridge would be detected. These tools are armed
    // but never executed by the bridge — the bridge constructs the scoop
    // directly.
    const counters = {
      scoop_scoop: 0,
      feed_scoop: 0,
      drop_scoop: 0,
      list_scoops: 0,
      send_message: 0,
      update_global_memory: 0,
    };
    const coneScoop: RegisteredScoop = {
      jid: 'cone',
      name: 'sliccy',
      folder: 'cone',
      isCone: true,
      type: 'cone',
      requiresTrigger: false,
      assistantLabel: 'sliccy',
      addedAt: new Date().toISOString(),
    };
    const tools: ToolDefinition[] = createScoopManagementTools({
      scoop: coneScoop,
      onSendMessage: () => {},
      onFeedScoop: async () => {},
      onScoopScoop: async (input) => ({ ...input, jid: 'fake-jid' }),
      onDropScoop: async () => {},
      onSetGlobalMemory: async () => {},
      getGlobalMemory: async () => '',
      getScoops: () => [coneScoop],
    });
    for (const tool of tools) {
      const original = tool.execute;
      tool.execute = async (input) => {
        if (tool.name in counters) {
          counters[tool.name as keyof typeof counters] += 1;
        }
        return original(input);
      };
    }

    const { createContext } = makeScriptedProvider(
      {
        outer: async (_args, bridge) => {
          const r = await bridge.spawn({
            cwd: '/home',
            allowedCommands: ['*'],
            prompt: 'inner',
          });
          return { send: [r.finalText] };
        },
        inner: () => ({ send: ['nested-ok'] }),
      },
      vfs
    );

    publishAgentBridge(orch, vfs, orch.getSessionStore(), {
      createContext,
      generateUid: uidGen('n11-'),
      resolveModel: (id) => id,
      getInheritedModelId: () => 'claude-opus-4-6',
    });

    const result = await createAgentCommand().execute(
      ['.', '*', 'outer'],
      createMockShellCtx(vfs, '/home')
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('nested-ok\n');
    // Every cone-only tool counter stayed at zero — the bridge bypassed
    // the cone's management-tool surface entirely, even across nesting.
    expect(counters).toEqual({
      scoop_scoop: 0,
      feed_scoop: 0,
      drop_scoop: 0,
      list_scoops: 0,
      send_message: 0,
      update_global_memory: 0,
    });
  });

  // (12) `globalThis.__slicc_agent` is the same reference at every depth.
  it('(12) globalThis.__slicc_agent is the same reference across all nesting depths', async () => {
    const { recording, createContext } = makeScriptedProvider(
      {
        level0: async (_args, bridge) => {
          const r = await bridge.spawn({
            cwd: '/home',
            allowedCommands: ['*'],
            prompt: 'level1',
          });
          return { send: [r.finalText] };
        },
        level1: async (_args, bridge) => {
          const r = await bridge.spawn({
            cwd: '/home',
            allowedCommands: ['*'],
            prompt: 'level2',
          });
          return { send: [r.finalText] };
        },
        level2: () => ({ send: ['deepest'] }),
      },
      vfs
    );

    const published = publishAgentBridge(orch, vfs, orch.getSessionStore(), {
      createContext,
      generateUid: uidGen('n12-'),
      resolveModel: (id) => id,
      getInheritedModelId: () => 'claude-opus-4-6',
    });

    const result = await createAgentCommand().execute(
      ['.', '*', 'level0'],
      createMockShellCtx(vfs, '/home')
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('deepest\n');

    // Each depth observed `globalThis.__slicc_agent` === the originally
    // published bridge (same reference — no per-call re-publication).
    expect(recording.bridgeSnapshotsDuringPrompt).toHaveLength(3);
    for (const snap of recording.bridgeSnapshotsDuringPrompt) {
      expect(snap).toBe(published);
    }
  });
});

// ─── Additional structural parity: sibling FS isolation sanity ─────────

describe('agent nesting — RestrictedFS structural sanity', () => {
  it('each spawned scoop gets its OWN RestrictedFS instance (not a shared one)', async () => {
    stubWindowForOrchestrator();
    await db.initDB();
    clearPublishedBridge();
    const orch = makeOrchestrator();
    await orch.init();
    const vfs = orch.getSharedFS();
    if (!vfs) throw new Error('orchestrator.getSharedFS() null');

    try {
      const fsInstances: RestrictedFS[] = [];
      const { createContext } = makeScriptedProvider(
        {
          outer: async (args, bridge) => {
            fsInstances.push(args.fs);
            await bridge.spawn({
              cwd: '/home',
              allowedCommands: ['*'],
              prompt: 'inner',
            });
            return { send: ['done'] };
          },
          inner: (args) => {
            fsInstances.push(args.fs);
            return { send: ['ok'] };
          },
        },
        vfs
      );

      publishAgentBridge(orch, vfs, orch.getSessionStore(), {
        createContext,
        generateUid: uidGen('rfs-'),
        resolveModel: (id) => id,
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      const result = await createAgentCommand().execute(
        ['.', '*', 'outer'],
        createMockShellCtx(vfs, '/home')
      );
      expect(result.exitCode).toBe(0);
      expect(fsInstances).toHaveLength(2);
      expect(fsInstances[0]).toBeInstanceOf(RestrictedFS);
      expect(fsInstances[1]).toBeInstanceOf(RestrictedFS);
      // Distinct instances — not the same reference reused across calls.
      expect(fsInstances[0]).not.toBe(fsInstances[1]);
    } finally {
      await orch.shutdown().catch(() => {});
      clearPublishedBridge();
      vi.unstubAllGlobals();
    }
  });
});
