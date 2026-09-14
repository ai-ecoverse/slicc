export interface BootStageLogger {
  debug(message: string, ...data: unknown[]): void;
  info(message: string, ...data: unknown[]): void;
  warn(message: string, ...data: unknown[]): void;
  error(message: string, ...data: unknown[]): void;
}

export interface SudoSetupDeps {
  log: BootStageLogger;
}

export interface OnboardingFirstRunHandler {
  handleFirstRun(): void;
}

export interface OnboardingSetupDeps {
  vfs: import('../../fs/index.js').VirtualFS;

  storage: Storage;

  firedWelcomeActions: Set<string>;

  persistFiredWelcomeActions(set: Set<string>): void;

  getOrchestrator(): OnboardingFirstRunHandler;

  log: BootStageLogger;
}
