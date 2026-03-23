// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// localStorage mock shared across tests
const storage = new Map<string, string>();
const mockStorage = {
  getItem: vi.fn((key: string) => storage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { storage.set(key, value); }),
  removeItem: vi.fn((key: string) => { storage.delete(key); }),
  clear: vi.fn(() => storage.clear()),
  get length() { return storage.size; },
  key: vi.fn((_i: number) => null),
};

Object.defineProperty(globalThis, 'localStorage', { value: mockStorage });

// Import after defining localStorage so module picks it up
import {
  getTelemetryConsent,
  setTelemetryConsent,
  showTelemetryConsent,
  type ConsentState,
} from './telemetry-consent.js';

describe('getTelemetryConsent', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('returns null when no consent decision exists', () => {
    expect(getTelemetryConsent()).toBeNull();
  });

  it('returns granted when consent was granted', () => {
    storage.set('telemetry-consent', 'granted');
    expect(getTelemetryConsent()).toBe('granted');
  });

  it('returns denied when consent was denied', () => {
    storage.set('telemetry-consent', 'denied');
    expect(getTelemetryConsent()).toBe('denied');
  });

  it('returns null for unknown stored values', () => {
    storage.set('telemetry-consent', 'something-else');
    expect(getTelemetryConsent()).toBeNull();
  });
});

describe('setTelemetryConsent', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('stores granted state', () => {
    setTelemetryConsent('granted');
    expect(mockStorage.setItem).toHaveBeenCalledWith('telemetry-consent', 'granted');
    expect(storage.get('telemetry-consent')).toBe('granted');
  });

  it('stores denied state', () => {
    setTelemetryConsent('denied');
    expect(mockStorage.setItem).toHaveBeenCalledWith('telemetry-consent', 'denied');
    expect(storage.get('telemetry-consent')).toBe('denied');
  });
});

describe('showTelemetryConsent', () => {
  let container: HTMLElement;

  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('shows banner when no consent decision exists', () => {
    const { banner } = showTelemetryConsent(container);
    expect(banner).not.toBeNull();
    expect(container.querySelector('.telemetry-consent')).not.toBeNull();
  });

  it('returns resolved promise with existing state when already granted', async () => {
    storage.set('telemetry-consent', 'granted');
    const { banner, promise } = showTelemetryConsent(container);
    expect(banner).toBeNull();
    expect(container.querySelector('.telemetry-consent')).toBeNull();
    const result = await promise;
    expect(result).toBe('granted');
  });

  it('returns resolved promise with existing state when already denied', async () => {
    storage.set('telemetry-consent', 'denied');
    const { banner, promise } = showTelemetryConsent(container);
    expect(banner).toBeNull();
    expect(container.querySelector('.telemetry-consent')).toBeNull();
    const result = await promise;
    expect(result).toBe('denied');
  });

  it('sets granted flag and removes banner on Allow click', async () => {
    const { banner, promise } = showTelemetryConsent(container);
    expect(banner).not.toBeNull();

    const allowBtn = container.querySelector<HTMLElement>('[data-action="allow"]');
    expect(allowBtn).not.toBeNull();
    allowBtn!.click();

    const result = await promise;
    expect(result).toBe('granted');
    expect(storage.get('telemetry-consent')).toBe('granted');
    expect(container.querySelector('.telemetry-consent')).toBeNull();
  });

  it('sets denied flag and removes banner on decline click', async () => {
    const { banner, promise } = showTelemetryConsent(container);
    expect(banner).not.toBeNull();

    const declineBtn = container.querySelector<HTMLElement>('[data-action="decline"]');
    expect(declineBtn).not.toBeNull();
    declineBtn!.click();

    const result = await promise;
    expect(result).toBe('denied');
    expect(storage.get('telemetry-consent')).toBe('denied');
    expect(container.querySelector('.telemetry-consent')).toBeNull();
  });

  it('prepends banner to container (appears at top)', () => {
    const existingChild = document.createElement('div');
    existingChild.id = 'existing';
    container.appendChild(existingChild);

    showTelemetryConsent(container);

    const children = Array.from(container.children);
    expect(children[0]?.classList.contains('telemetry-consent')).toBe(true);
    expect(children[1]?.id).toBe('existing');
  });

  it('ignores clicks on non-action elements inside banner', async () => {
    const { banner } = showTelemetryConsent(container);
    expect(banner).not.toBeNull();

    // Click on the text area (no data-action)
    const textEl = container.querySelector<HTMLElement>('.telemetry-consent__text');
    textEl?.click();

    // Banner should still be present
    expect(container.querySelector('.telemetry-consent')).not.toBeNull();
  });
});
