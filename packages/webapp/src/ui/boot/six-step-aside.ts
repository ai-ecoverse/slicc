import { SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';

export const SIX_UPGRADED_KEY = 'slicc-os.six';
export const SIX_UPGRADED_VALUE = 'upgraded';

export const SEVEN_OS_URL_PATH = '/os/';

export interface StepAsideWindow {
  location: { origin: string; replace(url: string): void };
  localStorage?: Pick<Storage, 'getItem'> | null;
  addEventListener?(type: 'storage', listener: (event: { key: string | null }) => void): void;
}

function readMarker(win: StepAsideWindow): string | null {
  try {
    return win.localStorage?.getItem(SIX_UPGRADED_KEY) ?? null;
  } catch {
    return null;
  }
}

export function shouldStepAsideForSeven(win: StepAsideWindow): boolean {
  return win.location.origin === SLICC_HOSTED_ORIGIN && readMarker(win) === SIX_UPGRADED_VALUE;
}

export function stepAsideForSeven(win: StepAsideWindow): boolean {
  if (shouldStepAsideForSeven(win)) {
    win.location.replace(SEVEN_OS_URL_PATH);
    return true;
  }
  if (win.location.origin === SLICC_HOSTED_ORIGIN) {
    win.addEventListener?.('storage', (event) => {
      if (event.key !== SIX_UPGRADED_KEY && event.key !== null) return;
      if (shouldStepAsideForSeven(win)) win.location.replace(SEVEN_OS_URL_PATH);
    });
  }
  return false;
}
