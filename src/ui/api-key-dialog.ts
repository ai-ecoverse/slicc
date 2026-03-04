/**
 * API Key Dialog — first-run prompt for API key.
 * Supports Anthropic (direct), Azure AI Foundry, and AWS Bedrock.
 * Key, provider, and resource are stored in localStorage.
 */

export type ApiProvider = 'anthropic' | 'azure' | 'bedrock';

const STORAGE_KEY = 'anthropic_api_key';
const RESOURCE_KEY = 'azure_resource';
const PROVIDER_KEY = 'api_provider';
const REGION_KEY = 'bedrock_region';

export function getApiKey(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function setApiKey(key: string): void {
  localStorage.setItem(STORAGE_KEY, key);
}

export function clearApiKey(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function getAzureResource(): string | null {
  return localStorage.getItem(RESOURCE_KEY);
}

export function setAzureResource(resource: string): void {
  if (resource) {
    localStorage.setItem(RESOURCE_KEY, resource);
  } else {
    localStorage.removeItem(RESOURCE_KEY);
  }
}

export function clearAzureResource(): void {
  localStorage.removeItem(RESOURCE_KEY);
}

export function getProvider(): ApiProvider {
  return (localStorage.getItem(PROVIDER_KEY) as ApiProvider) || 'anthropic';
}

export function setProvider(provider: ApiProvider): void {
  localStorage.setItem(PROVIDER_KEY, provider);
}

export function clearProvider(): void {
  localStorage.removeItem(PROVIDER_KEY);
}

export function getBedrockRegion(): string | null {
  return localStorage.getItem(REGION_KEY);
}

export function setBedrockRegion(region: string): void {
  if (region) {
    localStorage.setItem(REGION_KEY, region);
  } else {
    localStorage.removeItem(REGION_KEY);
  }
}

export function clearBedrockRegion(): void {
  localStorage.removeItem(REGION_KEY);
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

    const title = document.createElement('div');
    title.className = 'dialog__title';
    title.textContent = 'Welcome to slicc';
    dialog.appendChild(title);

    // Provider selector — segmented control
    const providerGroup = document.createElement('div');
    providerGroup.style.cssText = 'display: flex; gap: 0; margin-bottom: 16px; border-radius: 6px; overflow: hidden; border: 1px solid #3a3a5a;';
    const providers: [ApiProvider, string][] = [
      ['anthropic', 'Anthropic'],
      ['azure', 'Azure'],
      ['bedrock', 'Bedrock'],
    ];
    let selectedProvider: ApiProvider = getProvider();
    const providerBtns: HTMLButtonElement[] = [];
    for (const [value, label] of providers) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.dataset.provider = value;
      b.style.cssText = 'flex: 1; padding: 8px 0; border: none; font-size: 13px; font-weight: 600; cursor: pointer; transition: background .15s, color .15s;';
      providerBtns.push(b);
      providerGroup.appendChild(b);
    }

    function styleProviderBtns() {
      for (const b of providerBtns) {
        const active = b.dataset.provider === selectedProvider;
        b.style.background = active ? '#e94560' : '#1a1a2e';
        b.style.color = active ? '#fff' : '#a0a0b0';
      }
    }
    styleProviderBtns();

    for (const b of providerBtns) {
      b.addEventListener('click', () => {
        selectedProvider = b.dataset.provider as ApiProvider;
        styleProviderBtns();
        updateProviderUI();
      });
    }
    dialog.appendChild(providerGroup);

    // API key input
    const keyDesc = document.createElement('div');
    keyDesc.className = 'dialog__desc';
    keyDesc.textContent = 'API key — stored locally in your browser.';
    dialog.appendChild(keyDesc);

    const keyInput = document.createElement('input');
    keyInput.className = 'dialog__input';
    keyInput.type = 'password';
    keyInput.autocomplete = 'off';
    keyInput.spellcheck = false;
    dialog.appendChild(keyInput);

    // Azure resource input (shown only for azure)
    const azureSection = document.createElement('div');

    const azureDesc = document.createElement('div');
    azureDesc.className = 'dialog__desc';
    azureDesc.style.cssText = 'margin-top: 12px;';
    azureDesc.textContent = 'Azure AI Foundry resource name:';
    azureSection.appendChild(azureDesc);

    const resourceInput = document.createElement('input');
    resourceInput.className = 'dialog__input';
    resourceInput.type = 'text';
    resourceInput.placeholder = 'my-resource';
    resourceInput.autocomplete = 'off';
    resourceInput.spellcheck = false;
    azureSection.appendChild(resourceInput);

    dialog.appendChild(azureSection);

    // Bedrock endpoint input (shown only for bedrock)
    const bedrockSection = document.createElement('div');

    const bedrockDesc = document.createElement('div');
    bedrockDesc.className = 'dialog__desc';
    bedrockDesc.style.cssText = 'margin-top: 12px;';
    bedrockDesc.textContent = 'Bedrock endpoint:';
    bedrockSection.appendChild(bedrockDesc);

    const bedrockEndpointInput = document.createElement('input');
    bedrockEndpointInput.className = 'dialog__input';
    bedrockEndpointInput.type = 'text';
    bedrockEndpointInput.placeholder = 'https://bedrock-runtime.us-east-1.amazonaws.com';
    bedrockEndpointInput.value = getBedrockRegion() || '';
    bedrockEndpointInput.autocomplete = 'off';
    bedrockEndpointInput.spellcheck = false;
    bedrockSection.appendChild(bedrockEndpointInput);

    dialog.appendChild(bedrockSection);

    // Submit button
    const btn = document.createElement('button');
    btn.className = 'dialog__btn';
    btn.style.marginTop = '16px';
    btn.textContent = 'Start';
    btn.disabled = true;
    dialog.appendChild(btn);

    // Update UI based on provider selection
    function updateProviderUI() {
      azureSection.style.display = selectedProvider === 'azure' ? '' : 'none';
      bedrockSection.style.display = selectedProvider === 'bedrock' ? '' : 'none';
      switch (selectedProvider) {
        case 'anthropic':
          keyInput.placeholder = 'sk-ant-...';
          break;
        case 'azure':
          keyInput.placeholder = 'Azure API key';
          break;
        case 'bedrock':
          keyInput.placeholder = 'Bedrock API key';
          break;
      }
      btn.disabled = keyInput.value.trim().length < 10;
    }
    updateProviderUI();

    // Pre-fill resource if previously stored
    const existingResource = getAzureResource();
    if (existingResource) {
      resourceInput.value = existingResource;
    }

    keyInput.addEventListener('input', () => {
      btn.disabled = keyInput.value.trim().length < 10;
    });

    function submit() {
      const key = keyInput.value.trim();
      if (key.length < 10) return;
      setApiKey(key);
      setProvider(selectedProvider);
      if (selectedProvider === 'azure') {
        setAzureResource(resourceInput.value.trim());
      } else {
        clearAzureResource();
      }
      if (selectedProvider === 'bedrock') {
        setBedrockRegion(bedrockEndpointInput.value.trim());
      } else {
        clearBedrockRegion();
      }
      overlay.remove();
      resolve(key);
    }

    btn.addEventListener('click', submit);
    keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    resourceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => keyInput.focus());
  });
}
