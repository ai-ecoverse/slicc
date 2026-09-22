import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refreshModelCatalog: vi.fn(),
  getModelCatalogProviderIds: vi.fn(() => ['anthropic', 'amazon-bedrock']),
}));

vi.mock('../../../src/core/model-catalog-refresh.js', () => ({
  refreshModelCatalog: mocks.refreshModelCatalog,
}));
vi.mock('../../../src/providers/account-store.js', () => ({
  getModelCatalogProviderIds: mocks.getModelCatalogProviderIds,
}));

import {
  MODEL_CATALOG_CHECK_INTERVAL_MS,
  refreshModelCatalogForPage,
  setupModelCatalog,
  stopModelCatalogRefresh,
} from '../../../src/ui/boot/setup-model-catalog.js';

const storage = { getItem: () => null, setItem: () => {} };
const options = {
  locationHref: 'https://www.sliccy.ai/?slicc=leader',
  storage,
  envBaseUrl: null,
  isDev: false,
};

beforeEach(() => {
  vi.useFakeTimers();
  mocks.refreshModelCatalog.mockReset();
  mocks.refreshModelCatalog.mockResolvedValue({ updated: [], failed: [] });
});

afterEach(() => {
  stopModelCatalogRefresh();
  vi.useRealTimers();
});

describe('refreshModelCatalogForPage', () => {
  it("refreshes the accounts' catalogues through the page's worker origin", async () => {
    mocks.refreshModelCatalog.mockResolvedValue({ updated: ['anthropic'], failed: ['x'] });
    const result = await refreshModelCatalogForPage(options, true);
    expect(result).toEqual({ updated: ['anthropic'], failed: ['x'] });
    expect(mocks.refreshModelCatalog).toHaveBeenCalledWith({
      workerBaseUrl: 'https://www.sliccy.ai',
      providers: ['anthropic', 'amazon-bedrock'],
      storage,
      force: true,
    });
  });
});

describe('setupModelCatalog', () => {
  it('refreshes at once and then on every check interval, without stacking timers', async () => {
    await setupModelCatalog(options);
    await setupModelCatalog(options);
    expect(mocks.refreshModelCatalog).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MODEL_CATALOG_CHECK_INTERVAL_MS);
    expect(mocks.refreshModelCatalog).toHaveBeenCalledTimes(3);
    stopModelCatalogRefresh();
    await vi.advanceTimersByTimeAsync(MODEL_CATALOG_CHECK_INTERVAL_MS);
    expect(mocks.refreshModelCatalog).toHaveBeenCalledTimes(3);
  });
});
