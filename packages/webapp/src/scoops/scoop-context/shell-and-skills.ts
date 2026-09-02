/**
 * Shell construction + skill loading for one work unit.
 *
 * Owns: seeding the bundled skills, wrapping the unit's filesystem in the sudo
 * gate, and building the `AlmostBashShellHeadless` with the right env, process
 * ownership and discovery roots.
 *
 * Changes when the shell gains an option or the sandbox boundary moves. It
 * runs exactly once per unit, before the agent exists, so keeping it out of
 * the context separates "how this unit is assembled" from "how it runs".
 */

import type { BrowserAPI } from '../../cdp/index.js';
import { createLogger } from '../../core/index.js';
import { fetchSecretEnvVars } from '../../core/secret-env.js';
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
  createPageCapabilityBroker,
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
  /** Shared skills library filesystem, when the unit has one. */
  skillsFs: VirtualFS | null;
  getBrowserAPI: () => BrowserAPI;
  sudoManager: SudoManager | null;
  /**
   * Privileged-capability adapter for this float (#2276). Production
   * always injects the host's one broker. Tests that omit it get a page
   * stub with `localNodeServer` available — the Node test env's topology.
   */
  capabilityBroker?: CapabilityBroker | null;
  onSudoRequest?: (request: SudoRequest) => Promise<SudoDecision>;
  processManager: ProcessManager | null;
  processOwner: ProcessOwner;
  /** Pid of the in-flight turn, so realm children parent to it (#1166). */
  getTurnPid: () => number | undefined;
  /** `SLICC_LICK_TARGET` for this unit, or `undefined` for the default root. */
  lickTarget: string | undefined;
  /** `$TMPDIR` for this unit (`tmpDirFor`, `work-unit/descriptor.ts`). */
  tmpDir: string;
}

export interface ShellAndSkills {
  shell: AlmostBashShellHeadless;
  /** The sudo-gated view of the unit's filesystem the agent's tools get. */
  gatedFs: VirtualFS;
  skills: Skill[];
}

/** Create shell and load skills. */
export async function initShellAndSkills(deps: ShellAndSkillsDeps): Promise<ShellAndSkills> {
  const { scoop, unit, fs, skillsFs } = deps;
  const cwd = unit.workspace.root;
  const browser = deps.getBrowserAPI();

  // Only a unit that sees the whole workspace seeds the bundled skills.
  if (unit.policy.filesystem.kind === 'full-workspace') {
    await createDefaultSkills(fs as VirtualFS, SKILLS_LIBRARY_DIR);
  }

  const effectiveSkillsFs = (skillsFs ?? fs) as VirtualFS;
  const secretEnv = await fetchSecretEnvVars();
  // Slice A of #2276: webhook topology comes from the injected broker.
  // Remaining call sites: `work-unit/capability/index.ts`.
  const broker = deps.capabilityBroker ?? createPageCapabilityBroker({ localNodeServer: true });
  const localNode = await broker.network.localNodeServer();
  const hasLocalNodeServer = () => localNode.ok;

  // Wire the sudo enforcement surface. For non-cone scoops the broker
  // routes to the cone (via the `onSudoRequest` callback the orchestrator
  // already hooked up — same wire as `createConeApprovalBroker`), the
  // policy is the per-scoop merge (global ∪ `/scoops/<folder>/etc/sudoers`),
  // and the default disposition is `'require-approval'` so any unmatched
  // write OR command escalates to the cone instead of dying with a hard
  // wall. The cone keeps the user broker + `'allow'` default — unchanged.
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
          // Non-cone scoops get a no-op sink (#2416): their `always` grants
          // are persisted scoped by the approval router, not globally.
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
    jshDiscoveryFs: skillsFs ? effectiveSkillsFs : undefined,
    allowedCommands: scoop.config?.allowedCommands,
    getParentJid: () => scoop.jid,
    isScoop: () => unit.display.role === 'child',
    sudo: sudoWiring?.shellConfig,
    // Progress-card labels carry argv; scrub them with the same pipeline the
    // tool results go through.
    scrubProgressLabel: getToolResultScrubber(),
    // Wire the scoop's process context so realm-backed commands (`node` /
    // `.jsh` / `python`) launched by the agent's `bash` tool parent their
    // realm child to the scoop-turn pid. Without this `buildJshProcessConfig`
    // returns `undefined` and the realm child registers at `ppid:1`, so the
    // `stop()`/`dispose()`/`drop_scoop` fan-out from the `kind:'scoop-turn'`
    // pid never reaches it and it survives the turn (#1166).
    processManager: deps.processManager ?? undefined,
    processOwner: deps.processOwner,
    getCurrentShellPid: deps.getTurnPid,
  });

  log.info('AlmostBashShell initialized', { folder: scoop.folder });
  const skills = await loadSkills(effectiveSkillsFs, SKILLS_LIBRARY_DIR);
  return { shell, gatedFs, skills };
}
