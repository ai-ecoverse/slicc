let enabled = false;

export function setSyncFsBridgeEnabled(value: boolean): void {
  enabled = value;
}

export function isSyncFsBridgeEnabled(): boolean {
  return enabled;
}
