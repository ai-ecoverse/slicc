function pageRealmOnly(name: string): never {
  throw new Error(
    `speech.${name} is page-realm only — the kernel worker must bridge over panel-RPC`
  );
}

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

export const setHearDepsForTests = (): never => pageRealmOnly('setHearDepsForTests');
export const resetHearDepsForTests = (): never => pageRealmOnly('resetHearDepsForTests');
export const hearCapture = (): never => pageRealmOnly('hearCapture');
export const hearTranscribe = (): never => pageRealmOnly('hearTranscribe');
export const hearStatus = (): never => pageRealmOnly('hearStatus');
export const hearWarmup = (): never => pageRealmOnly('hearWarmup');
