/**
 * API Key Dialog — first-run prompt for Anthropic API key.
 * Key is stored in localStorage.
 */

const STORAGE_KEY = 'anthropic_api_key';

export function getApiKey(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function setApiKey(key: string): void {
  localStorage.setItem(STORAGE_KEY, key);
}

export function clearApiKey(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Show the API key dialog. Returns a promise that resolves
 * with the key once the user submits it.
 */
export function showApiKeyDialog(): Promise<string> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog__title">Welcome</div>
      <div class="dialog__desc">
        Enter your Anthropic API key to get started. It will be stored locally in your browser.
      </div>
      <input
        class="dialog__input"
        type="password"
        placeholder="sk-ant-..."
        autocomplete="off"
        spellcheck="false"
      />
      <button class="dialog__btn" disabled>Start</button>
    `;

    const input = dialog.querySelector('.dialog__input') as HTMLInputElement;
    const btn = dialog.querySelector('.dialog__btn') as HTMLButtonElement;

    input.addEventListener('input', () => {
      btn.disabled = input.value.trim().length < 10;
    });

    function submit() {
      const key = input.value.trim();
      if (key.length < 10) return;
      setApiKey(key);
      overlay.remove();
      resolve(key);
    }

    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Focus the input after a tick (ensures DOM is rendered)
    requestAnimationFrame(() => input.focus());
  });
}
