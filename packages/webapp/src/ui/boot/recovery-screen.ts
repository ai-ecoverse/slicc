import { isStaleBridgeTokenError } from '../../base/api-endpoint.js';
import { NUKE_LOCAL_STORAGE_KEYS } from '../../shell/supplemental-commands/nuke-channel.js';
import { wipeLocalStorageState } from '../../shell/supplemental-commands/wipe-local-storage-state.js';
import type { WorkerTriageVerdict } from './worker-triage.js';

export interface RecoveryScreenDeps {
  wipe?: () => Promise<void>;

  reload?: () => void;

  verdict?: WorkerTriageVerdict;
}

export function renderBootRecoveryScreen(
  app: HTMLElement,
  error: unknown,
  deps: RecoveryScreenDeps = {}
): void {
  if (app.dataset['recoveryBusy'] === '1') return;

  const wipe = deps.wipe ?? wipeLocalStorageState;
  const reload = deps.reload ?? (() => location.reload());
  const message = error instanceof Error ? error.message : String(error);
  const wedged = deps.verdict === 'browser-wedged';

  const staleToken = isStaleBridgeTokenError(error);
  const softenReset = wedged || staleToken;

  const box = document.createElement('div');
  box.style.cssText = 'padding:2rem;text-align:center;font-family:system-ui;';

  const h1 = document.createElement('h1');
  h1.style.color = 'var(--s2-negative, #e34850)';
  h1.textContent = wedged ? 'Your browser needs a restart' : 'Failed to start';

  const p = document.createElement('p');
  p.style.color = 'var(--s2-content-tertiary, #717171)';
  p.textContent = message;

  const actions = document.createElement('div');
  actions.style.cssText =
    'display:flex;gap:0.75rem;justify-content:center;flex-wrap:wrap;margin-top:1.5rem;';

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.textContent = 'Reset local data & reload';

  resetBtn.dataset['variant'] = softenReset ? 'demoted' : 'destructive';
  resetBtn.style.cssText = softenReset
    ? 'padding:0.5rem 1rem;cursor:pointer;border:1px solid var(--s2-content-tertiary, #717171);' +
      'background:transparent;color:inherit;border-radius:4px;'
    : 'padding:0.5rem 1rem;cursor:pointer;border:1px solid var(--s2-negative, #e34850);' +
      'background:var(--s2-negative, #e34850);color:#fff;border-radius:4px;';

  const reloadBtn = document.createElement('button');
  reloadBtn.type = 'button';
  reloadBtn.textContent = 'Reload';
  reloadBtn.style.cssText = wedged
    ? 'padding:0.5rem 1rem;cursor:pointer;border:1px solid var(--s2-accent, #0265dc);' +
      'background:var(--s2-accent, #0265dc);color:#fff;border-radius:4px;'
    : 'padding:0.5rem 1rem;cursor:pointer;border:1px solid var(--s2-content-tertiary, #717171);' +
      'background:transparent;color:inherit;border-radius:4px;';

  resetBtn.addEventListener('click', () => {
    resetBtn.disabled = true;
    reloadBtn.disabled = true;
    resetBtn.textContent = 'Resetting…';
    app.dataset['recoveryBusy'] = '1';
    void (async () => {
      try {
        await wipe();
      } catch {}

      for (const key of NUKE_LOCAL_STORAGE_KEYS) {
        try {
          localStorage.removeItem(key);
        } catch {}
      }
      reload();
    })();
  });

  reloadBtn.addEventListener('click', () => {
    reload();
  });

  if (wedged) {
    const why = document.createElement('p');
    why.style.cssText = 'max-width:34rem;margin:1rem auto 0;';
    why.textContent =
      'This browser has stopped starting web workers — a browser process ' +
      'issue, not a problem with your data. Quit the browser completely, ' +
      'reopen it, and come back. Your local data is intact; resetting it ' +
      'will not fix this.';
    box.append(h1, p, why);
    actions.append(reloadBtn, resetBtn);
  } else {
    box.append(h1, p);
    actions.append(resetBtn, reloadBtn);
  }
  box.append(actions);

  while (app.firstChild) app.removeChild(app.firstChild);
  app.appendChild(box);
}
