/**
 * Typed dependency contracts for the surviving `ui/boot/*` stage modules.
 * The Layout-coupled stage contracts were removed with the legacy UI in
 * the WC migration (PR #961); the WC shell threads its own deps through
 * `ui/wc/wc-live.ts`.
 */

/** Minimal logger surface used by the boot stages. */
export interface BootStageLogger {
  debug(message: string, ...data: unknown[]): void;
  info(message: string, ...data: unknown[]): void;
  warn(message: string, ...data: unknown[]): void;
  error(message: string, ...data: unknown[]): void;
}

/**
 * Dependencies for `setupSudoStandalone()` / `setupSudoExtension()` —
 * thin async wrappers around the sudo broker hooks the boot path
 * publishes.
 */
export interface SudoSetupDeps {
  /** Logger for status messages from the install path. */
  log: BootStageLogger;
}

/** The single orchestrator capability `runFirstRunDetection` needs. */
export interface OnboardingFirstRunHandler {
  handleFirstRun(): void;
}

/**
 * Dependencies for `runFirstRunDetection()` — the welcome detection
 * chain shared by the WC live and extension boots.
 */
export interface OnboardingSetupDeps {
  /** Page-side VirtualFS used for the `/shared/.welcomed` probe. */
  vfs: import('../../fs/index.js').VirtualFS;
  /** Page-side `localStorage` — checked for an active tray-join URL. */
  storage: Storage;
  /** The in-memory dedup ledger, mutated when a fresh first-run fires. */
  firedWelcomeActions: Set<string>;
  /**
   * Persist the dedup ledger to `localStorage` after mutation. Injected
   * so the boot stage stays free of the page-only persistence helper.
   */
  persistFiredWelcomeActions(set: Set<string>): void;
  /**
   * Resolver for the onboarding orchestrator — kept lazy so floats can
   * supply their own singletons. Invoked only after
   * `detectWelcomeFirstRun` confirms a genuine first-run boot.
   */
  getOrchestrator(): OnboardingFirstRunHandler;
  /** Logger for the warn/info trace from the detection chain. */
  log: BootStageLogger;
}
