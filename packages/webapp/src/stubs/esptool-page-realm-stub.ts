/**
 * Worker-build stub for the page-realm esptool-js operations
 * (`kernel/esptool-operations.ts`).
 *
 * The `esptool` command runs in whichever realm owns the shell. In a **page**
 * realm `LocalEsptoolBackend` dynamic-imports `esptool-operations` and drives
 * esptool-js over Web Serial; in the **kernel worker** `BridgedEsptoolBackend`
 * forwards every op to the page over panel-RPC. Both backends live in one
 * module, so the worker build still emitted the local branch: a second copy of
 * `esptool-operations` plus every per-chip stub-flasher chunk (~300 KB with
 * esptool-js 0.7), unreachable in a worker.
 *
 * The local branch is gated on `hasLocalDom()` (`typeof window` and `typeof
 * document`), which is false in a DedicatedWorker by construction, so in the
 * worker build it is dead code. This stub replaces it there (see
 * `stubPageRealmEsptoolPlugin` in `vite.config.ts`, applied to
 * `worker.plugins` ONLY). The page build keeps the real module.
 *
 * Every export throws: reaching one means a realm check regressed, and a loud
 * error beats a silent no-op on a flashing tool.
 */

function pageRealmOnly(name: string): never {
  throw new Error(
    `esptool.${name} is page-realm only — the kernel worker must bridge over panel-RPC`
  );
}

export const esptoolChipInfo = (): never => pageRealmOnly('esptoolChipInfo');
export const esptoolReadMac = (): never => pageRealmOnly('esptoolReadMac');
export const esptoolEraseFlash = (): never => pageRealmOnly('esptoolEraseFlash');
export const esptoolFlash = (): never => pageRealmOnly('esptoolFlash');
export const esptoolReadFlash = (): never => pageRealmOnly('esptoolReadFlash');
export const esptoolReadReg = (): never => pageRealmOnly('esptoolReadReg');
export const esptoolFlashId = (): never => pageRealmOnly('esptoolFlashId');
export const esptoolEraseRegion = (): never => pageRealmOnly('esptoolEraseRegion');
export const esptoolRun = (): never => pageRealmOnly('esptoolRun');
