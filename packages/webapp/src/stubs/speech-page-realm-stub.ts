/**
 * Worker-build stub for the page-realm speech modules (`speech/speak.ts`,
 * `speech/hear.ts`).
 *
 * `say` / `hear` run in whichever realm owns the shell. In a **page** realm
 * they call the engines directly; in the **kernel worker** they bridge to the
 * page over panel-RPC (`speak-text`, `hear-capture`, …). Both branches live in
 * one module, so the worker build emitted the page branch too — dragging
 * `kokoro-js` + `@huggingface/transformers` (~1.8 MB) into the worker bundle as
 * a second copy of chunks the page graph already ships.
 *
 * The local branch is guarded by `typeof window !== 'undefined' && typeof
 * speechSynthesis !== 'undefined'` (`say-command.ts`), which is false in a
 * DedicatedWorker by construction — so in the worker build the page branch is
 * dead code. This stub replaces it there (see `stubPageRealmSpeechPlugin` in
 * `vite.config.ts`, applied to `worker.plugins` ONLY). The page build keeps the
 * real modules.
 *
 * Every export throws: reaching one means a realm check regressed, and a loud
 * error beats silently speaking nothing.
 */

function pageRealmOnly(name: string): never {
  throw new Error(
    `speech.${name} is page-realm only — the kernel worker must bridge over panel-RPC`
  );
}

// --- speech/speak.ts ---
export const pickSpeakEngine = (): never => pageRealmOnly('pickSpeakEngine');
export const speechTextFromMarkdown = (): never => pageRealmOnly('speechTextFromMarkdown');
export const kokoroVoicesIfReady = (): never => pageRealmOnly('kokoroVoicesIfReady');
export const ensureVoicesLoaded = (): never => pageRealmOnly('ensureVoicesLoaded');
export const hasVoiceForLang = (): never => pageRealmOnly('hasVoiceForLang');
export const setSpeakAssetsInstanceId = (): never => pageRealmOnly('setSpeakAssetsInstanceId');
export const kokoroStatus = (): never => pageRealmOnly('kokoroStatus');
export const kokoroWarmup = (): never => pageRealmOnly('kokoroWarmup');
export const speak = (): never => pageRealmOnly('speak');
export const resetSpeakForTests = (): never => pageRealmOnly('resetSpeakForTests');
export const synthesizeToWav = (): never => pageRealmOnly('synthesizeToWav');

// --- speech/hear.ts ---
export const setHearDepsForTests = (): never => pageRealmOnly('setHearDepsForTests');
export const resetHearDepsForTests = (): never => pageRealmOnly('resetHearDepsForTests');
export const hearCapture = (): never => pageRealmOnly('hearCapture');
export const hearTranscribe = (): never => pageRealmOnly('hearTranscribe');
export const hearStatus = (): never => pageRealmOnly('hearStatus');
export const hearWarmup = (): never => pageRealmOnly('hearWarmup');
