import type { BrowserAPI } from '../../cdp/index.js';
import { createLogger } from '../../core/index.js';
import { buildEnvFromMaskedEntries } from '../../core/secret-env.js';
import { getToolResultScrubber } from '../../core/secret-scrub.js';
import type { VirtualFS } from '../../fs/index.js';
import type { RestrictedFS } from '../../fs/restricted-fs.js';
import { createSudoFs } from '../../fs/sudo-fs.js';
import type { ProcessManager, ProcessOwner } from '../../kernel/process-manager.js';
import { AlmostBashShellHeadless } from '../../shell/almost-bash-shell-headless.js';
import type { SudoManager } from '../../sudo/sudo-manager.js';
import type { SudoDecision, SudoRequest } from '../../sudo/types.js';
import {
  type CapabilityBroker,
  createRestCapabilityBroker,
} from '../../work-unit/capability/index.js';
import { SKILLS_LIBRARY_DIR } from '../../work-unit/descriptor.js';
import type { WorkUnitDescriptor } from '../../work-unit/types.js';
import { createDefaultSkills, loadSkills, type Skill } from '../skills.js';
import { getLeaderStatusWithFallback } from '../tray-leader.js';
import type { RegisteredScoop } from '../types.js';
import { buildScoopShellEnv } from './shell-env.js';
import { buildSudoWiring } from './sudo-wiring.js';

const log = createLogger('scoop-context');

export interface ShellAndSkillsDeps {
  scoop: RegisteredScoop;
  unit: WorkUnitDescriptor;
  fs: VirtualFS | RestrictedFS;

  skillsFs: VirtualFS | null;
  getBrowserAPI: () => BrowserAPI;
  sudoManager: SudoManager | null;

  capabilityBroker?: CapabilityBroker | null;
  onSudoRequest?: (request: SudoRequest) => Promise<SudoDecision>;
  processManager: ProcessManager | null;
  processOwner: ProcessOwner;

  getTurnPid: () => number | undefined;

  lickTarget: string | undefined;

  tmpDir: string;
}

export interface ShellAndSkills {
  shell: AlmostBashShellHeadless;

  gatedFs: VirtualFS;
  skills: Skill[];
}

async function loadSecretEnv(broker: CapabilityBroker): Promise<Record<string, string>> {
  try {
    const maskedSecrets = await broker.secrets.listMaskedEnv();
    if (!maskedSecrets.ok) {
      log.warn('Failed to fetch masked secrets', {
        capability: maskedSecrets.capability,
        operation: maskedSecrets.operation,
        message: maskedSecrets.message,
        status: 'status' in maskedSecrets ? maskedSecrets.status : undefined,
      });
      return {};
    }
    if (!Array.isArray(maskedSecrets.value.entries)) {
      log.warn('Masked secrets response was not an array', {
        entriesType: typeof maskedSecrets.value.entries,
      });
      return {};
    }
    return buildEnvFromMaskedEntries(maskedSecrets.value.entries);
  } catch (err) {
    log.warn('Failed to fetch masked secrets', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

export async function initShellAndSkills(deps: ShellAndSkillsDeps): Promise<ShellAndSkills> {
  const { scoop, unit, fs, skillsFs } = deps;
  const cwd = unit.workspace.root;
  const browser = deps.getBrowserAPI();

  if (unit.policy.filesystem.kind === 'full-workspace') {
    await createDefaultSkills(fs as VirtualFS, SKILLS_LIBRARY_DIR);
  }

  const effectiveSkillsFs = (skillsFs ?? fs) as VirtualFS;

  const broker = deps.capabilityBroker ?? createRestCapabilityBroker();
  const secretEnv = await loadSecretEnv(broker);
  const localNode = await broker.network.localNodeServer();
  const hasLocalNodeServer = () => localNode.ok;

  const sudoWiring = buildSudoWiring({
    sudoManager: deps.sudoManager,
    unit,
    folder: scoop.folder,
    onSudoRequest: deps.onSudoRequest,
  });
  const gatedFs = (
    sudoWiring
      ? createSudoFs(fs, {
          broker: sudoWiring.broker,
          getPolicy: sudoWiring.getPolicy,
          defaultDisposition: sudoWiring.defaultDisposition,

          ...(sudoWiring.onGrant ? { onGrant: sudoWiring.onGrant } : {}),
        })
      : fs
  ) as VirtualFS;

  const shellEnv = buildScoopShellEnv({
    isCone: unit.policy.filesystem.kind === 'full-workspace',
    folder: scoop.folder,
    secretEnv,
    tmpDir: deps.tmpDir,
    ...(deps.lickTarget ? { lickTarget: deps.lickTarget } : {}),
  });
  const shell = new AlmostBashShellHeadless({
    fs: gatedFs,
    cwd,
    env: Object.keys(shellEnv).length > 0 ? shellEnv : undefined,
    browserAPI: browser,
    webhook: {
      hasLocalNodeServer,
      getLeaderStatus: getLeaderStatusWithFallback,
    },
    crontask: { hasLocalNodeServer },
    jshDiscoveryFs: skillsFs ? effectiveSkillsFs : undefined,
    allowedCommands: scoop.config?.allowedCommands,
    getParentJid: () => scoop.jid,
    isScoop: () => unit.display.role === 'child',
    sudo: sudoWiring?.shellConfig,

    scrubProgressLabel: getToolResultScrubber(),

    processManager: deps.processManager ?? undefined,
    processOwner: deps.processOwner,
    getCurrentShellPid: deps.getTurnPid,
  });

  log.info('AlmostBashShell initialized', { folder: scoop.folder });
  const skills = await loadSkills(effectiveSkillsFs, SKILLS_LIBRARY_DIR);
  return { shell, gatedFs, skills };
}
