const ALL_URLS_ORIGIN = { origins: ['<all_urls>'] };

export async function hasHostPermission(): Promise<boolean> {
  return chrome.permissions.contains(ALL_URLS_ORIGIN);
}

export async function requestHostPermission(): Promise<boolean> {
  return chrome.permissions.request(ALL_URLS_ORIGIN);
}

export function onHostPermissionRevoked(callback: () => void): void {
  chrome.permissions.onRemoved.addListener((permissions) => {
    if (permissions.origins?.includes('<all_urls>')) {
      callback();
    }
  });
}

const APPROVAL_HTML = `
<div class="sprinkle-action-card">
  <div class="sprinkle-action-card__header">Web access required <span class="sprinkle-badge sprinkle-badge--notice">approval</span></div>
  <div class="sprinkle-action-card__body">The agent needs permission to access web pages for cross-origin requests. This enables fetching external resources and connecting to APIs.</div>
  <div class="sprinkle-action-card__actions">
    <button class="sprinkle-btn sprinkle-btn--secondary" data-action="deny">Deny</button>
    <button class="sprinkle-btn sprinkle-btn--primary" data-action="grant">Grant access</button>
  </div>
</div>
`;

/**
 * Ensure host permission is available for cross-origin fetch.
 * Outside extension mode, returns true (no permission needed).
 * In extension mode with permission already granted, returns true.
 * Otherwise shows a Tool UI approval card if a tool context exists.
 * Returns false if permission is denied or no tool context is available.
 */
export async function ensureHostPermission(): Promise<boolean> {
  const isExtension =
    typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  if (!isExtension) return true;

  if (await hasHostPermission()) return true;

  // Dynamic import to avoid circular deps (tool-ui imports from core/)
  const { getToolExecutionContext, showToolUIFromContext } =
    await import('../tools/tool-ui.js');
  const ctx = getToolExecutionContext();
  if (!ctx) return false;

  const result = await showToolUIFromContext({
    html: APPROVAL_HTML,
    onAction: async (action) => {
      if (action === 'grant') {
        const granted = await requestHostPermission();
        return { granted };
      }
      return { denied: true };
    },
  });

  if (!result) return false;
  const res = result as { granted?: boolean; denied?: boolean };
  return !!res.granted;
}
