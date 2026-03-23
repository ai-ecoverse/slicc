import { requestHostPermission } from '../extension/host-permission.js';

/**
 * Show a modal dialog explaining why <all_urls> permission is needed.
 * Returns true if granted, false if dismissed or denied.
 *
 * MUST be called from a user gesture context (click handler) because
 * chrome.permissions.request() requires a user gesture.
 */
export function showHostPermissionDialog(
  container: HTMLElement,
  reason: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.style.maxWidth = '420px';
    dialog.innerHTML = [
      '<div class="dialog__title">Web access required</div>',
      '<div class="dialog__desc">',
      `slicc needs permission to access web pages to <strong>${escapeHtml(reason)}</strong>. `,
      'This lets the agent interact with websites on your behalf. ',
      'No browsing data is collected — all processing stays local.',
      '</div>',
      '<div class="dialog__desc" style="font-size: 11px; opacity: 0.7;">',
      'You can revoke this anytime in chrome://extensions.',
      '</div>',
      '<div style="display:flex;gap:8px;margin-top:16px;">',
      '<button class="dialog__btn--secondary" style="flex:1;" data-action="dismiss">Not now</button>',
      '<button class="dialog__btn" style="flex:1;width:auto;" data-action="grant">Grant access</button>',
      '</div>',
    ].join('');

    overlay.appendChild(dialog);

    function cleanup(result: boolean): void {
      overlay.remove();
      resolve(result);
    }

    dialog.addEventListener('click', async (e) => {
      const action = (e.target as HTMLElement).dataset?.action;
      if (action === 'grant') {
        const granted = await requestHostPermission();
        cleanup(granted);
      } else if (action === 'dismiss') {
        cleanup(false);
      }
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });

    container.appendChild(overlay);
  });
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
