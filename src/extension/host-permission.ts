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
