import { DEFAULT_JSH_SEARCH_ROOTS } from '../../shell/jsh-discovery.js';
import { LICK_TARGET_ENV } from '../../shell/lick-target-env.js';
import type { WorkUnitDescriptor } from '../../work-unit/types.js';
import type { RegisteredScoop } from '../types.js';

export interface ScoopShellEnvOptions {
  isCone: boolean;
  folder: string;
  secretEnv: Record<string, string>;

  tmpDir: string;

  lickTarget?: string;
}

export function buildScoopShellEnv(options: ScoopShellEnvOptions): Record<string, string> {
  const { isCone, folder, secretEnv, tmpDir, lickTarget } = options;
  const lickTargetEnv: Record<string, string> = lickTarget ? { [LICK_TARGET_ENV]: lickTarget } : {};
  if (isCone) return { ...secretEnv, TMPDIR: tmpDir, ...lickTargetEnv };
  return {
    ...secretEnv,
    HOME: `/scoops/${folder}/home`,
    TMPDIR: tmpDir,
    USER: folder,
    PATH: [
      '/usr/bin',
      `/scoops/${folder}/workspace/skills`,
      `/scoops/${folder}/workspace/bin`,
      ...DEFAULT_JSH_SEARCH_ROOTS,
    ].join(':'),
    ...lickTargetEnv,
  };
}

export function ownLickTargetFor(
  unit: Pick<WorkUnitDescriptor, 'display'>,
  scoop: Pick<RegisteredScoop, 'parentJid' | 'folder' | 'jid'>,
  defaultLickRootJid: string | undefined
): string | undefined {
  if (unit.display.role === 'child') return scoop.folder;
  return scoop.jid === defaultLickRootJid ? undefined : scoop.folder;
}
