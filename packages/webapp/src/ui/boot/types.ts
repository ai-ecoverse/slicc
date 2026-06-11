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
