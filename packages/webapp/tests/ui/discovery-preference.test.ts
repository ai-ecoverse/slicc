import { afterEach, describe, expect, it, vi } from 'vitest';
import { setExtensionDelegateId } from '../../src/shell/proxied-fetch.js';
import { getDiscoveryEnabled, setDiscoveryEnabled } from '../../src/ui/discovery-preference.js';

function makeMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setExtensionDelegateId(null);
});

describe('discovery-preference', () => {
  it('defaults to enabled when unset', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    expect(getDiscoveryEnabled()).toBe(true);
  });

  it('defaults to enabled when storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(getDiscoveryEnabled()).toBe(true);
  });

  it('round-trips true/false through localStorage', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    setDiscoveryEnabled(false);
    expect(localStorage.getItem('slicc_discovery_enabled')).toBe('false');
    expect(getDiscoveryEnabled()).toBe(false);
    setDiscoveryEnabled(true);
    expect(getDiscoveryEnabled()).toBe(true);
  });

  it('treats only an explicit "false" as disabled (opt-out)', () => {
    const storage = makeMemoryStorage();
    storage.setItem('slicc_discovery_enabled', 'anything-else');
    vi.stubGlobal('localStorage', storage);
    expect(getDiscoveryEnabled()).toBe(true);
  });

  it('does not mirror to the extension SW outside the extension float', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    const sendMessage = vi.fn();
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    // No delegate id set → not the extension float.
    setDiscoveryEnabled(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('mirrors the value to the extension SW when a delegate id is present', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    const sendMessage = vi.fn();
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    setExtensionDelegateId('delegate-123');
    setDiscoveryEnabled(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [id, message] = sendMessage.mock.calls[0];
    expect(id).toBe('delegate-123');
    expect(message).toEqual({ type: 'discovery.set-enabled', enabled: false });
  });

  it('never throws if the SW mirror send fails', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: () => {
          throw new Error('no receiving end');
        },
      },
    });
    setExtensionDelegateId('delegate-123');
    expect(() => setDiscoveryEnabled(true)).not.toThrow();
    expect(getDiscoveryEnabled()).toBe(true);
  });
});
