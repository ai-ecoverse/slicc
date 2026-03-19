import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredScoop } from './types.js';

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
    createSearchTools: vi.fn(() => [{ name: 'grep' }, { name: 'find' }]),
    createJavaScriptTool: vi.fn(() => ({ name: 'javascript' })),
    createNanoClawTools: vi.fn(() => [{ name: 'send_message' }]),
    WasmShell: vi.fn(function () {
      return {};
    }),
    getApiKey: vi.fn(() => 'test-api-key'),
    getSelectedProvider: vi.fn(() => 'anthropic'),
    resolveCurrentModel: vi.fn(() => ({ id: 'test-model' })),
    resolveModelById: vi.fn(() => ({ id: 'test-model' })),
    createDefaultSkills: vi.fn(async () => {}),
    loadSkills: vi.fn(async () => []),
    formatSkillsForPrompt: vi.fn(() => ''),
  };
});

vi.mock('../core/index.js', () => ({
  Agent: mocks.MockAgent,
  adaptTools: mocks.adaptTools,
  createLogger: mocks.createLogger,
}));

vi.mock('../tools/index.js', () => ({
  createFileTools: mocks.createFileTools,
  createBashTool: mocks.createBashTool,
  createSearchTools: mocks.createSearchTools,
  createJavaScriptTool: mocks.createJavaScriptTool,
}));

vi.mock('../shell/index.js', () => ({
  WasmShell: mocks.WasmShell,
}));

vi.mock('../ui/provider-settings.js', () => ({
  getApiKey: mocks.getApiKey,
  getSelectedProvider: mocks.getSelectedProvider,
  resolveCurrentModel: mocks.resolveCurrentModel,
  resolveModelById: mocks.resolveModelById,
}));

vi.mock('./skills.js', () => ({
  createDefaultSkills: mocks.createDefaultSkills,
  loadSkills: mocks.loadSkills,
  formatSkillsForPrompt: mocks.formatSkillsForPrompt,
}));

vi.mock('./nanoclaw-tools.js', () => ({
  createNanoClawTools: mocks.createNanoClawTools,
}));

const { ScoopContext } = await import('./scoop-context.js');

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

    expect(mocks.createSearchTools).not.toHaveBeenCalled();

    const toolNames = mocks.agentCtorCalls[0].initialState.tools.map(
      (tool: { name: string }) => tool.name
    );
    expect(toolNames).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'bash',
      'javascript',
      'send_message',
    ]);
    expect(toolNames).not.toContain('grep');
    expect(toolNames).not.toContain('find');
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
    ]);
    mocks.formatSkillsForPrompt.mockImplementationOnce((skills: Array<{ path: string }>) =>
      `AVAILABLE SKILLS\n${skills.map((skill) => `Path: ${skill.path}`).join('\n')}`,
    );

    const ctx = new ScoopContext(testScoop, createMockCallbacks(), createMockFs() as any);
    await ctx.init();

    expect(mocks.loadSkills).toHaveBeenCalledWith(expect.anything(), '/scoops/test-scoop/workspace/skills');
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
    ]);
    mocks.formatSkillsForPrompt.mockImplementationOnce((skills: Array<{ path: string }>) =>
      `AVAILABLE SKILLS\n${skills.map((skill) => `Path: ${skill.path}`).join('\n')}`,
    );

    const cone: RegisteredScoop = { ...testScoop, isCone: true, folder: '' };
    const ctx = new ScoopContext(cone, createMockCallbacks(), createMockFs() as any);
    await ctx.init();

    expect(mocks.loadSkills).toHaveBeenCalledWith(expect.anything(), '/workspace/skills');
    const systemPrompt = mocks.agentCtorCalls[0].initialState.systemPrompt;
    expect(systemPrompt).toContain('/repo/.agents/skills/agent-skill/SKILL.md');
  });
});
