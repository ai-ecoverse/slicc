/**
 * Changes applied to an ALREADY-RUNNING agent.
 *
 * Owns: re-resolving the model and thinking level onto `agent.state` after the
 * record or the provider catalogue changed, and rebuilding the system prompt
 * after skills or memories changed.
 *
 * Changes when the set of hot-swappable agent state grows. It is separate from
 * `agent-factory.ts` on purpose: building an agent and mutating a live one
 * have different failure modes, and only these three are safe to mutate.
 */

import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
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

/**
 * Re-resolve THIS unit's model from its own record (#2310) and apply it to the
 * running agent. Also re-resolves the thinking level against the new model:
 * `xhigh` clamps to `high` on a family that doesn't advertise it, and any
 * non-`off` level snaps to `off` on a non-reasoning model.
 *
 * The user's *intent* is read off the persisted record, not
 * `agent.state.thinkingLevel` (which a previous resolution may already have
 * clamped), so a swap back to an xhigh-capable model restores the higher tier
 * instead of leaving the clamped value in place. Returns the effort override
 * that should now be active — cleared when the new model cannot reason.
 */
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

/**
 * Apply a requested reasoning level to the running agent, after model-aware
 * resolution. A deployment-wide effort lock wins: the request is ignored and
 * the level already in force is returned unchanged.
 */
export function applyThinkingLevel(agent: Agent, level: ThinkingLevel | undefined): ThinkingLevel {
  if (getLockedEffortLevel()) return agent.state.thinkingLevel;
  const resolved = resolveThinkingLevel(level, agent.state.model);
  agent.state.thinkingLevel = resolved;
  return resolved;
}

/**
 * Hot-reload skills from the VFS and rebuild the running agent's system
 * prompt from them plus the unit's (re-read) memories.
 */
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

  agent.state.systemPrompt = buildScoopSystemPrompt(
    deps.scoop,
    deps.unit,
    globalMemory,
    scoopMemory,
    skills
  );

  log.info('Skills reloaded', { folder: deps.scoop.folder, skillCount: skills.length });
}
