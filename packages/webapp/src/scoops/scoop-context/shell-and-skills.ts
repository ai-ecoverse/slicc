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

import { BlindReadLog } from '../../base/blind-reads.js';
import { isMemoryPassSandbox } from '../../base/memory-budget.js';
import type { BrowserAPI } from '../../cdp/index.js';
import { createLogger } from '../../core/index.js';
import { buildEnvFromMaskedEntries } from '../../core/secret-env.js';
import { getToolResultScrubber } from '../../core/secret-scrub.js';
import { createBlindReadFs } from '../../fs/blind-read-fs.js';
import type { VirtualFS } from '../../fs/index.js';
import { createMemoryGuardedFs } from '../../fs/memory-guard-fs.js';
import { RestrictedFS } from '../../fs/restricted-fs.js';
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
  /** Shared skills library filesystem, when the unit has one. */
  skillsFs: VirtualFS | null;
  getBrowserAPI: () => BrowserAPI;
  sudoManager: SudoManager | null;
  /**
   * Privileged-capability adapter for this float (#2276). Production
   * always injects the host's one broker. Tests that omit it get the
   * `node-rest` adapter, whose `localNodeServer` is a composition-time fact
   * needing no transport — the Node test env's topology.
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
  /**
   * The sudo-gated view of the unit's filesystem the agent's tools and shell
   * get, with memory files write-guarded (`fs/memory-guard-fs.ts`): a
   * `write_file`, `edit`, `cp` or `cat >` onto a memory file is refused and
   * points at `memory_write`.
   */
  gatedFs: VirtualFS;
  /**
   * The same sudo-gated handle WITHOUT the memory guard — handed to the
   * `memory_write` tool alone, which is what makes it the single write path
   * for memory files (#3157).
   */
  memoryFs: VirtualFS;
  /**
   * Ledger of the paths a memory pass probed outside its visible roots
   * (#3459), or `null` for every other unit. The `bash` tool appends its
   * note to each result and `memory_write` refuses to persist a refutation
   * of a recorded path.
   */
  blindReads: BlindReadLog | null;
  skills: Skill[];
}

/**
 * A memory pass is the one unit for which the sandbox's "not found" answer
 * outside `visiblePaths` is dangerous rather than convenient: what it reads
 * becomes durable memory. It is recognised by its grant on a staged
 * curation draft, so a restored pass or a customized `/etc/MEMORY.md` is
 * covered the same as a fresh spawn.
 */
function blindReadLogFor(
  unit: WorkUnitDescriptor,
  fs: VirtualFS | RestrictedFS
): BlindReadLog | null {
  const policy = unit.policy.filesystem;
  if (policy.kind !== 'restricted' || !(fs instanceof RestrictedFS)) return null;
  if (!isMemoryPassSandbox(policy.writablePaths)) return null;
  return new BlindReadLog(policy.visiblePaths);
}

/**
 * Masked secrets for the shell env, via the injected broker (#2276).
 *
 * Total by construction: a rejected `listMaskedEnv()`, an `ok: false`
 * result, or a reply whose `entries` is not an array all degrade to `{}`
 * rather than throwing — this sits on `initShellAndSkills`'s hot path, so an
 * unhandled rejection here would fail `ScoopContext.init()` and the unit
 * would never reach `ready`, over an optional convenience. Every non-`{}`
 * outcome still logs, so a broken masked-secrets path stays visible instead
 * of silently degrading like `core/secret-env.ts`'s old helper's inner
 * catches did.
 */
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
  // #2276: secrets + webhook/crontask topology come from the injected
  // broker, never a probe. See `work-unit/capability/index.ts` for the full
  // slice-C inventory (now empty except `ui/` and documented `shell/`
  // topology owners).
  const broker = deps.capabilityBroker ?? createRestCapabilityBroker();
  const secretEnv = await loadSecretEnv(broker);
  const localNode = await broker.network.localNodeServer();
  const hasLocalNodeServer = () => localNode.ok;

  // Wire the sudo enforcement surface. For non-cone scoops the broker
  // routes to the cone (via the `onSudoRequest` callback the orchestrator
  // already hooked up — same wire as `createConeApprovalBroker`), the
  // policy is the per-scoop merge (global ∪ `/etc/sudoers.d/scoop-<folder>`),
  // and the default disposition is `'require-approval'` so any unmatched
  // write OR command escalates to the cone instead of dying with a hard
  // wall. The cone keeps the user broker + `'allow'` default — unchanged.
  const sudoWiring = buildSudoWiring({
    sudoManager: deps.sudoManager,
    unit,
    folder: scoop.folder,
    onSudoRequest: deps.onSudoRequest,
  });
  const sudoFs = (
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
  // A memory pass must not mistake the sandbox edge for an absent file
  // (#3459): its reads outside `visiblePaths` are recorded and answered as
  // "not visible" instead of "not found". Above the sudo gate (a sudoers
  // read grant widens the ACL, and `readAccess` sees it), below the memory
  // guard (a refused write is not a read).
  const blindReads = blindReadLogFor(unit, fs);
  const memoryFs = blindReads ? createBlindReadFs(sudoFs, fs as RestrictedFS, blindReads) : sudoFs;
  // Memory files change through `memory_write` only (#3157); every other
  // writer — the file tools and any shell command — sees the guarded view.
  const gatedFs = createMemoryGuardedFs(memoryFs);

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
  return { shell, gatedFs, memoryFs, blindReads, skills };
}
