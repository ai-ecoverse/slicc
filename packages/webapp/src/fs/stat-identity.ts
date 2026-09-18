export function inodeIdentity(namespace: string, ino?: number, dev = 0): string | undefined {
  if (!Number.isSafeInteger(ino) || (ino ?? 0) <= 0 || !Number.isSafeInteger(dev) || dev < 0) {
    return undefined;
  }
  return JSON.stringify([namespace, dev, ino]);
}
