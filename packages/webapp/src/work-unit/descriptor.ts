/**
 * Pure projection of a `RegisteredScoop` (+ live tab state) onto a
 * {@link WorkUnitDescriptor}. No I/O, no globals — safe to call from tests,
 * the kernel, and (later) wire projections.
 */

import type { RegisteredScoop, ScoopTabState } from '../scoops/types.js';
import { deriveCompletion, derivePolicy, isRootUnit } from './policy.js';
import { statusFromTab, type WorkUnitDescriptor, type WorkUnitWorkspace } from './types.js';

/**
 * Filesystem coordinates for a unit. These encode the directory convention
 * the runtime uses today (`scoop-context.ts`); computing them in one place
 * is what lets Phase 3 replace the scattered `isCone ? '/workspace' : …`
 * ternaries.
 */
export function workspaceFor(
  scoop: Pick<RegisteredScoop, 'parentJid' | 'folder'>
): WorkUnitWorkspace {
  if (isRootUnit(scoop)) {
    return { root: '/workspace', memoryPath: '/workspace/CLAUDE.md', scratch: '/tmp' };
  }
  const home = `/scoops/${scoop.folder}`;
  return { root: `${home}/workspace`, memoryPath: `${home}/CLAUDE.md`, scratch: home };
}

/** Project a record (and optional live tab) onto a descriptor. */
export function toDescriptor(scoop: RegisteredScoop, tab?: ScoopTabState): WorkUnitDescriptor {
  const root = isRootUnit(scoop);
  return {
    id: scoop.jid,
    parentId: scoop.parentJid,
    name: scoop.name,
    folder: scoop.folder,
    status: statusFromTab(tab?.status),
    display: {
      role: root ? 'primary' : 'child',
      label: scoop.assistantLabel,
    },
    workspace: workspaceFor(scoop),
    policy: derivePolicy(scoop),
    completion: deriveCompletion(scoop),
  };
}
