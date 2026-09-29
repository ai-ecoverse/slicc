import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import type { Agent } from '../../core/index.js';
import { createLogger } from '../../core/index.js';
import type { VirtualFS } from '../../fs/index.js';
import type { RestrictedFS } from '../../fs/restricted-fs.js';
import { SKILLS_LIBRARY_DIR } from '../../work-unit/descriptor.js';
import { thinkingFor } from '../../work-unit/record.js';
import type { WorkUnitDescriptor } from '../../work-unit/types.js';
import { loadSkills } from '../skills.js';
import type { RegisteredScoop } from '../types.js';
import { readUnitMemory } from './memories.js';
import { resolveScoopModel } from './model-resolution.js';
import { buildScoopSystemPrompt } from './system-prompt.js';
import { getLockedEffortLevel, resolveThinkingLevel } from './thinking-level.js';

const log = createLogger('scoop-context');

export function applyModelUpdate(agent: Agent, scoop: RegisteredScoop): string | undefined {
  const model = resolveScoopModel(scoop);
  agent.state.model = model;
  const thinking = thinkingFor(scoop);
  const requested = getLockedEffortLevel() ?? thinking.level;
  agent.state.thinkingLevel = resolveThinkingLevel(requested, model);
  log.info('Model updated on running agent', {
    folder: scoop.folder,
    model: model.id,
    thinkingLevel: agent.state.thinkingLevel,
  });
  return model.reasoning ? thinking.effortOverride : undefined;
}

export function applyThinkingLevel(agent: Agent, level: ThinkingLevel | undefined): ThinkingLevel {
  if (getLockedEffortLevel()) return agent.state.thinkingLevel;
  const resolved = resolveThinkingLevel(level, agent.state.model);
  agent.state.thinkingLevel = resolved;
  return resolved;
}

export async function rebuildSystemPrompt(
  agent: Agent,
  deps: {
    scoop: RegisteredScoop;
    unit: WorkUnitDescriptor;
    fs: VirtualFS | RestrictedFS;
    skillsFs: VirtualFS | null;
    getGlobalMemory: () => Promise<string>;
  }
): Promise<void> {
  const skills = await loadSkills((deps.skillsFs ?? deps.fs) as VirtualFS, SKILLS_LIBRARY_DIR);
  const scoopMemory = await readUnitMemory(deps.fs, deps.unit.workspace.memoryPath);
  const globalMemory = await deps.getGlobalMemory();

  const systemPrompt = buildScoopSystemPrompt(
    deps.scoop,
    deps.unit,
    globalMemory,
    scoopMemory,
    skills
  );
  const activeTools = getCurrentTools(agent.state.messages);
  agent.state.messages = [
    {
      role: 'system',
      content: systemPrompt,
      ...(activeTools.length > 0 ? { toolsAdded: activeTools } : {}),
      timestamp: Date.now(),
    },
    ...agent.state.messages.filter((message) => message.role !== 'system'),
  ];

  log.info('Skills reloaded', { folder: deps.scoop.folder, skillCount: skills.length });
}
