/**
 * `recovery-screen.ts` — the pre-boot recovery surface rendered by
 * `main().catch()` when the shell never booted (kernel-worker boot
 * timeout, a fatal error in the boot path, etc.).
 *
 * Replaces the old dead-end "Failed to start" screen: as well as the
 * error message it offers a "Reset local data & reload" button that runs
 * the same wipe as `nuke` (all OPFS root entries + every IndexedDB DB +
 * SW unregister) and a plain "Reload" retry. Both are reachable even
 * when the shell never booted, so a user whose local state is corrupt
 * can recover without DevTools.
 *
 * Rendered with `createElement`/`textContent` (never `innerHTML`) so a
 * boot error message can't inject markup. The wipe imports the shared,
 * shell-free `wipeLocalStorageState` helper — no `just-bash` in the page
 * bundle.
 */

import { wipeLocalStorageState } from '../../shell/supplemental-commands/wipe-local-storage-state.js';

/** Injectable seams so the render test can assert wipe+reload without
 *  touching real OPFS/IDB or navigating the test page. */
export interface RecoveryScreenDeps {
  /** Wipe local state. Defaults to the shared `wipeLocalStorageState`. */
  wipe?: () => Promise<void>;
  /** Reload the page. Defaults to `location.reload()`. */
  reload?: () => void;
}

/**
 * Render the recovery screen into `app`, replacing its contents. Shows
 * the boot error message plus two buttons:
 *   - "Reset local data & reload" — awaits {@link RecoveryScreenDeps.wipe}
 *     then reloads. Requires an explicit click; there is no auto-wipe.
 *   - "Reload" — a plain retry that just reloads.
 */
export function renderBootRecoveryScreen(
  app: HTMLElement,
  error: unknown,
  deps: RecoveryScreenDeps = {}
): void {
  const wipe = deps.wipe ?? wipeLocalStorageState;
  const reload = deps.reload ?? (() => location.reload());
  const message = error instanceof Error ? error.message : String(error);

  const box = document.createElement('div');
  box.style.cssText = 'padding:2rem;text-align:center;font-family:system-ui;';

  const h1 = document.createElement('h1');
  h1.style.color = 'var(--s2-negative, #e34850)';
  h1.textContent = 'Failed to start';

  const p = document.createElement('p');
  p.style.color = 'var(--s2-content-tertiary, #717171)';
  p.textContent = message;

  const actions = document.createElement('div');
  actions.style.cssText =
    'display:flex;gap:0.75rem;justify-content:center;flex-wrap:wrap;margin-top:1.5rem;';

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.textContent = 'Reset local data & reload';
  resetBtn.style.cssText =
    'padding:0.5rem 1rem;cursor:pointer;border:1px solid var(--s2-negative, #e34850);' +
    'background:var(--s2-negative, #e34850);color:#fff;border-radius:4px;';

  const reloadBtn = document.createElement('button');
  reloadBtn.type = 'button';
  reloadBtn.textContent = 'Reload';
  reloadBtn.style.cssText =
    'padding:0.5rem 1rem;cursor:pointer;border:1px solid var(--s2-content-tertiary, #717171);' +
    'background:transparent;color:inherit;border-radius:4px;';

  // Explicit click is the confirmation — no auto-wipe. Disable both
  // buttons while the wipe runs so a double-click can't fire it twice,
  // then reload from the now-clean slate. Best-effort: even if the wipe
  // rejects (it shouldn't — it's guarded) we still reload.
  resetBtn.addEventListener('click', () => {
    resetBtn.disabled = true;
    reloadBtn.disabled = true;
    resetBtn.textContent = 'Resetting…';
    void (async () => {
      try {
        await wipe();
      } catch {
        /* wipe is best-effort (already guarded) — reload regardless */
      }
      reload();
    })();
  });

  reloadBtn.addEventListener('click', () => {
    reload();
  });

  actions.append(resetBtn, reloadBtn);
  box.append(h1, p, actions);

  while (app.firstChild) app.removeChild(app.firstChild);
  app.appendChild(box);
}
