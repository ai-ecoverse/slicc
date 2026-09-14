import type { SudoSetupDeps } from './types.js';

export async function setupSudoStandalone(_deps: SudoSetupDeps): Promise<void> {
  const { createSudoBroker, installSudoTestHook } = await import('../../sudo/index.js');
  const { createRestCapabilityBroker } = await import('../../work-unit/capability/index.js');
  installSudoTestHook(createSudoBroker(createRestCapabilityBroker()));
}

export async function setupSudoExtension(_deps: SudoSetupDeps): Promise<void> {
  const { installPanelSudoResponder } = await import('../../sudo/index.js');
  installPanelSudoResponder();
}
