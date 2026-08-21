import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredScoop } from '../../src/scoops/types.js';

const mocks = vi.hoisted(() => {
  const agentCtorCalls: any[] = [];

  class MockAgent {
    constructor(options: any) {
      agentCtorCalls.push(options);
    }

    subscribe = vi.fn(() => () => {});
    abort = vi.fn();
  }

  return {
    agentCtorCalls,
    MockAgent,
    adaptTools: vi.fn((tools: any[]) => tools),
    createLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() })),
    createFileTools: vi.fn(() => [
      { name: 'read_file' },
      { name: 'write_file' },
      { name: 'edit_file' },
    ]),
    createBashTool: vi.fn(() => ({ name: 'bash' })),
    createScoopManagementTools: vi.fn(() => [{ name: 'send_message' }]),
    AlmostBashShellHeadless: vi.fn(function () {
      // `dispose` is real on the shell and `ScoopContext.dispose()` calls it, so
      // the stub needs it for any test that exercises teardown.
      return { dispose: vi.fn() };
    }),
    getApiKey: vi.fn(() => 'test-api-key'),
    getSelectedProvider: vi.fn(() => 'anthropic'),
    resolveCurrentModel: vi.fn(() => ({ id: 'test-model' })),
    resolveModelById: vi.fn(() => ({ id: 'test-model' })),
    resolveModelSelectionForScoop: vi.fn((id: string) => ({
      ok: true,
      selection: { modelId: id, providerId: 'adobe' },
    })),
    createDefaultSkills: vi.fn(async () => {}),
    loadSkills: vi.fn(async () => []),
    formatSkillsForPrompt: vi.fn(() => ''),
  };
});

vi.mock('../../src/core/index.js', () => ({
  Agent: mocks.MockAgent,
  adaptTools: mocks.adaptTools,
  createLogger: mocks.createLogger,
}));

vi.mock('../../src/tools/index.js', () => ({
  createFileTools: mocks.createFileTools,
  createBashTool: mocks.createBashTool,
}));

vi.mock('../../src/shell/almost-bash-shell-headless.js', () => ({
  AlmostBashShellHeadless: mocks.AlmostBashShellHeadless,
}));

vi.mock('../../src/providers/account-store.js', () => ({
  getApiKey: mocks.getApiKey,
  getSelectedProvider: mocks.getSelectedProvider,
  resolveCurrentModel: mocks.resolveCurrentModel,
  resolveModelById: mocks.resolveModelById,
  resolveModelSelectionForScoop: mocks.resolveModelSelectionForScoop,
}));

vi.mock('../../src/scoops/skills.js', () => ({
  createDefaultSkills: mocks.createDefaultSkills,
  loadSkills: mocks.loadSkills,
  formatSkillsForPrompt: mocks.formatSkillsForPrompt,
}));

vi.mock('../../src/scoops/scoop-management-tools.js', () => ({
  createScoopManagementTools: mocks.createScoopManagementTools,
}));

const { ScoopContext } = await import('../../src/scoops/scoop-context.js');

const testScoop: RegisteredScoop = {
  jid: 'scoop_test_1',
  name: 'test',
  folder: 'test-scoop',
  isCone: false,
  type: 'scoop',
  requiresTrigger: false,
  assistantLabel: 'test-scoop',
  addedAt: new Date().toISOString(),
};

function createMockCallbacks() {
  return {
    onResponse: vi.fn(),
    onResponseDone: vi.fn(),
    onError: vi.fn(),
    onStatusChange: vi.fn(),
    onSendMessage: vi.fn(),
    getScoops: vi.fn(() => []),
    getGlobalMemory: vi.fn(async () => ''),
    getBrowserAPI: vi.fn(() => ({}) as any),
  };
}

function createMockFs() {
  const files = new Map<string, string>();

  return {
    mkdir: vi.fn(async () => {}),
    readFile: vi.fn(async (path: string) => {
      if (!files.has(path)) {
        throw new Error('ENOENT');
      }

      return files.get(path)!;
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      files.set(path, content);
    }),
  };
}

describe('ScoopContext active tool surface', () => {
  beforeEach(() => {
    mocks.agentCtorCalls.length = 0;
    vi.clearAllMocks();
  });

  it('does not register dedicated grep/find tools during init', async () => {
    const ctx = new ScoopContext(testScoop, createMockCallbacks(), createMockFs() as any);

    await ctx.init();

    const toolNames = mocks.agentCtorCalls[0].initialState.tools.map(
      (tool: { name: string }) => tool.name
    );
    expect(toolNames).toEqual(['read_file', 'write_file', 'edit_file', 'bash', 'send_message']);
    expect(toolNames).not.toContain('grep');
    expect(toolNames).not.toContain('find');
  });

  // Regression for PR #1166 (P1): the agent's bash-tool shell must be built
  // with the scoop's process context so realm-backed children (`node`/`.jsh`/
  // `python`) parent to the scoop-turn pid (not `ppid:1`) and the Stop/drop
  // fan-out reaches them.
  it('threads the scoop process context into the bash-tool shell', async () => {
    const pm = {
      spawn: vi.fn(() => ({ pid: 5000 })),
      signal: vi.fn(),
      exit: vi.fn(),
    };
    const ctx = new ScoopContext(
      testScoop,
      createMockCallbacks(),
      createMockFs() as any,
      undefined,
      undefined,
      undefined,
      pm as any
    );

    await ctx.init();

    expect(mocks.AlmostBashShellHeadless).toHaveBeenCalledTimes(1);
    const shellOptions = (mocks.AlmostBashShellHeadless.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(shellOptions.processManager).toBe(pm);
    expect(shellOptions.processOwner).toEqual({ kind: 'scoop', scoopJid: 'scoop_test_1' });
    expect(typeof shellOptions.getCurrentShellPid).toBe('function');
  });

  // Codex review on PR #2210 (P1): a detached bash job deliberately outlives its
  // turn, so by dispose time the turn pid it was parented to is gone and the
  // turn-pid SIGTERM in `dispose()` cannot reach it. Without an explicit reap, a
  // `drop_scoop` (or one-shot `agent` teardown) deletes the scoop directory and
  // leaves the command running against it.
  describe('detached bash job reaping on dispose', () => {
    function pmMock() {
      let nextPid = 5000;
      const signals: Array<{ pid: number; signal: string }> = [];
      return {
        signals,
        pm: {
          spawn: vi.fn(() => ({ pid: nextPid++, abort: new AbortController() })),
          signal: vi.fn((pid: number, signal: string) => {
            signals.push({ pid, signal });
          }),
          exit: vi.fn(),
        },
      };
    }

    async function initWithPm(pm: unknown) {
      const ctx = new ScoopContext(
        testScoop,
        createMockCallbacks(),
        createMockFs() as any,
        undefined,
        undefined,
        undefined,
        pm as any
      );
      await ctx.init();
      const options = (mocks.createBashTool.mock.calls[0] as unknown[])[3] as {
        jobHost: { spawn: (command: string) => { pid: number; exit: (c: number | null) => void } };
        scrubOutput?: (text: string) => Promise<string>;
      };
      return { ctx, options };
    }

    it('SIGKILLs a job that is still running at dispose', async () => {
      const { pm, signals } = pmMock();
      const { ctx, options } = await initWithPm(pm);

      const job = options.jobHost.spawn('sleep 999');
      ctx.dispose();

      expect(signals).toContainEqual({ pid: job.pid, signal: 'SIGKILL' });
    });

    it('does not signal a job that already finished', async () => {
      const { pm, signals } = pmMock();
      const { ctx, options } = await initWithPm(pm);

      const job = options.jobHost.spawn('echo hi');
      job.exit(0);
      ctx.dispose();

      expect(signals.some((s) => s.pid === job.pid)).toBe(false);
    });

    it('wires the secret scrubber for detached output', async () => {
      const { pm } = pmMock();
      const { options } = await initWithPm(pm);

      expect(typeof options.scrubOutput).toBe('function');
    });
  });

  it('owns the bash-tool shell as the cone when isCone', async () => {
    const cone: RegisteredScoop = { ...testScoop, isCone: true, folder: '' };
    const ctx = new ScoopContext(cone, createMockCallbacks(), createMockFs() as any);

    await ctx.init();

    const shellOptions = (mocks.AlmostBashShellHeadless.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(shellOptions.processOwner).toEqual({ kind: 'cone', scoopJid: 'scoop_test_1' });
  });

  it('steers search through bash in the system prompt', async () => {
    const ctx = new ScoopContext(testScoop, createMockCallbacks(), createMockFs() as any);

    await ctx.init();

    const systemPrompt = mocks.agentCtorCalls[0].initialState.systemPrompt;
    expect(systemPrompt).toContain(
      'Use shell commands like `rg`, `grep`, and `find` through the bash tool for search'
    );
    expect(systemPrompt).not.toContain('Search tools (grep, find)');
  });

  it('includes discovered compatibility skill paths in scoop system prompts', async () => {
    mocks.loadSkills.mockResolvedValueOnce([
      {
        metadata: { name: 'compat-skill', description: 'Compatibility skill' },
        content: 'Use this skill.',
        path: '/repo/.claude/skills/compat-skill/SKILL.md',
      },
    ] as any);
    mocks.formatSkillsForPrompt.mockImplementationOnce(
      ((skills: Array<{ path: string }>) =>
        `AVAILABLE SKILLS\n${skills.map((skill) => `Path: ${skill.path}`).join('\n')}`) as any
    );

    const ctx = new ScoopContext(testScoop, createMockCallbacks(), createMockFs() as any);
    await ctx.init();

    expect(mocks.loadSkills).toHaveBeenCalledWith(expect.anything(), '/workspace/skills');
    const systemPrompt = mocks.agentCtorCalls[0].initialState.systemPrompt;
    expect(systemPrompt).toContain('/repo/.claude/skills/compat-skill/SKILL.md');
  });

  it('includes discovered compatibility skill paths in cone system prompts', async () => {
    mocks.loadSkills.mockResolvedValueOnce([
      {
        metadata: { name: 'agent-skill', description: 'Agent compatibility skill' },
        content: 'Use this skill.',
        path: '/repo/.agents/skills/agent-skill/SKILL.md',
      },
    ] as any);
    mocks.formatSkillsForPrompt.mockImplementationOnce(
      ((skills: Array<{ path: string }>) =>
        `AVAILABLE SKILLS\n${skills.map((skill) => `Path: ${skill.path}`).join('\n')}`) as any
    );

    const cone: RegisteredScoop = { ...testScoop, isCone: true, folder: '' };
    const ctx = new ScoopContext(cone, createMockCallbacks(), createMockFs() as any);
    await ctx.init();

    expect(mocks.loadSkills).toHaveBeenCalledWith(expect.anything(), '/workspace/skills');
    const systemPrompt = mocks.agentCtorCalls[0].initialState.systemPrompt;
    expect(systemPrompt).toContain('/repo/.agents/skills/agent-skill/SKILL.md');
  });
});
