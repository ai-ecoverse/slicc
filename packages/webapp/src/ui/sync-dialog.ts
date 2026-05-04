import { copyTextToClipboard } from './clipboard.js';

export interface SyncEnabledDialogOptions {
  joinUrl: string;
  copied: boolean;
  onReset?: (() => Promise<unknown>) | null;
}

export function showSyncEnabledDialog(options: SyncEnabledDialogOptions): void {
  document.querySelectorAll('.dialog-overlay[data-sync-dialog]').forEach((el) => el.remove());

  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';
  overlay.dataset.syncDialog = '1';

  const dialog = document.createElement('div');
  dialog.className = 'dialog';
  overlay.appendChild(dialog);

  const title = document.createElement('div');
  title.className = 'dialog__title';
  title.textContent = 'Multi-browser sync is on';
  dialog.appendChild(title);

  const desc = document.createElement('div');
  desc.className = 'dialog__desc';
  desc.textContent = options.copied
    ? 'The sync URL is copied to your clipboard. Paste it into another SLICC browser to mirror this one.'
    : 'Couldn\u2019t copy automatically. Use the button below to copy the sync URL, then paste it into another SLICC browser.';
  dialog.appendChild(desc);

  const stepsBox = document.createElement('div');
  stepsBox.style.cssText =
    'margin-bottom: 12px; padding: 10px 12px; background: var(--s2-bg-layer-1); border-radius: var(--s2-radius-default); border: 1px solid var(--s2-border-subtle); line-height: 1.5; font-size: 12px; color: var(--s2-content-secondary);';
  const stepsList = document.createElement('ol');
  stepsList.style.cssText = 'margin: 0; padding-left: 20px;';
  const steps = [
    'Open SLICC in another browser.',
    'Click the avatar (top right) \u2192 \u201cConnect to another browser\u201d.',
    'Paste the URL there. Both browsers must be on the same SLICC version.',
  ];
  for (const step of steps) {
    const li = document.createElement('li');
    li.textContent = step;
    stepsList.appendChild(li);
  }
  stepsBox.appendChild(stepsList);
  dialog.appendChild(stepsBox);

  const urlDisplay = document.createElement('div');
  urlDisplay.style.cssText =
    'font-family: var(--s2-font-mono); font-size: 11px; color: var(--s2-content-secondary); word-break: break-all; margin-bottom: 12px; padding: 8px 12px; background: var(--s2-bg-sunken); border-radius: var(--s2-radius-default); border: 1px solid var(--s2-border-subtle);';
  urlDisplay.textContent = options.joinUrl;
  dialog.appendChild(urlDisplay);

  const statusEl = document.createElement('div');
  statusEl.style.cssText =
    'font-size: 12px; color: var(--s2-content-secondary); margin-bottom: 8px; display: none;';
  dialog.appendChild(statusEl);
  if (options.copied) {
    statusEl.textContent = 'URL copied to clipboard.';
    statusEl.style.display = '';
  }

  const copyAgainBtn = document.createElement('button');
  copyAgainBtn.className = 'dialog__btn dialog__btn--secondary';
  copyAgainBtn.style.marginBottom = '8px';
  copyAgainBtn.textContent = options.copied ? 'Copy again' : 'Copy URL';
  copyAgainBtn.addEventListener('click', async () => {
    const ok = await copyTextToClipboard(options.joinUrl);
    statusEl.textContent = ok
      ? 'URL copied to clipboard.'
      : 'Couldn\u2019t copy. Select and copy manually.';
    statusEl.style.color = ok ? 'var(--s2-content-secondary)' : 'var(--slicc-cone)';
    statusEl.style.display = '';
  });
  dialog.appendChild(copyAgainBtn);

  const doneBtn = document.createElement('button');
  doneBtn.className = 'dialog__btn';
  doneBtn.textContent = 'Done';
  doneBtn.addEventListener('click', () => overlay.remove());
  dialog.appendChild(doneBtn);

  if (options.onReset) {
    const resetBtn = document.createElement('button');
    resetBtn.className = 'dialog__btn dialog__btn--secondary';
    resetBtn.style.marginTop = '8px';
    resetBtn.textContent = 'Reset URL (disconnect connected browsers)';
    resetBtn.addEventListener('click', async () => {
      resetBtn.disabled = true;
      doneBtn.disabled = true;
      copyAgainBtn.disabled = true;
      statusEl.textContent = 'Resetting sync URL\u2026';
      statusEl.style.color = 'var(--s2-content-secondary)';
      statusEl.style.display = '';
      try {
        await options.onReset!();
        statusEl.textContent =
          'Sync URL reset. Reopen this dialog from the avatar to share the new URL.';
        statusEl.style.color = 'var(--s2-content-secondary)';
        urlDisplay.textContent = '\u2014';
        copyAgainBtn.disabled = true;
      } catch (err) {
        statusEl.textContent = `Reset failed: ${err instanceof Error ? err.message : String(err)}`;
        statusEl.style.color = 'var(--slicc-cone)';
        resetBtn.disabled = false;
        doneBtn.disabled = false;
        copyAgainBtn.disabled = false;
      }
    });
    dialog.appendChild(resetBtn);
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.body.appendChild(overlay);
}
