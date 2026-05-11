import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchSecretEnvVars } from '../../src/core/secret-env.js';

describe('fetchSecretEnvVars', () => {
  let originalChrome: typeof globalThis.chrome | undefined;

  beforeEach(() => {
    originalChrome = globalThis.chrome;
  });

  afterEach(() => {
    if (originalChrome === undefined) {
      delete (globalThis as any).chrome;
    } else {
      (globalThis as any).chrome = originalChrome;
    }
  });

  describe('CLI mode', () => {
    beforeEach(() => {
      delete (globalThis as any).chrome;
      globalThis.fetch = vi.fn();
    });

    it('returns empty object when fetch fails', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      const result = await fetchSecretEnvVars();
      expect(result).toEqual({});
    });

    it('returns empty object when response is not an array', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ not: 'an array' }),
      } as Response);

      const result = await fetchSecretEnvVars();
      expect(result).toEqual({});
    });

    it('returns empty object when response is an empty array', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      } as Response);

      const result = await fetchSecretEnvVars();
      expect(result).toEqual({});
    });

    it('returns mapped env vars from server response', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { name: 'GITHUB_TOKEN', maskedValue: 'ghp_masked_xyz', domains: ['github.com'] },
          { name: 'NPM_TOKEN', maskedValue: 'npm_masked_abc', domains: ['npmjs.org'] },
        ],
      } as Response);

      const result = await fetchSecretEnvVars();
      expect(result).toEqual({
        GITHUB_TOKEN: 'ghp_masked_xyz',
        NPM_TOKEN: 'npm_masked_abc',
      });
    });

    it('filters out entries with missing name or maskedValue', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { name: 'GITHUB_TOKEN', maskedValue: 'ghp_masked_xyz', domains: ['github.com'] },
          { name: '', maskedValue: 'npm_masked_abc', domains: ['npmjs.org'] },
          { name: 'AWS_KEY', maskedValue: '', domains: ['amazonaws.com'] },
        ],
      } as Response);

      const result = await fetchSecretEnvVars();
      expect(result).toEqual({
        GITHUB_TOKEN: 'ghp_masked_xyz',
      });
    });

    it('returns empty object on network error', async () => {
      vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('Network error'));

      const result = await fetchSecretEnvVars();
      expect(result).toEqual({});
    });
  });

  describe('Extension mode', () => {
    beforeEach(() => {
      (globalThis as any).chrome = {
        runtime: {
          id: 'test-extension-id',
          sendMessage: vi.fn(),
        },
      };
    });

    it('returns empty object when SW returns no entries', async () => {
      vi.mocked(globalThis.chrome.runtime.sendMessage).mockImplementation(
        (msg: any, callback?: (resp: any) => void) => {
          if (callback) callback({ entries: [] });
          return Promise.resolve();
        }
      );

      const result = await fetchSecretEnvVars();
      expect(result).toEqual({});
    });

    it('returns empty object when SW returns undefined entries', async () => {
      vi.mocked(globalThis.chrome.runtime.sendMessage).mockImplementation(
        (msg: any, callback?: (resp: any) => void) => {
          if (callback) callback({});
          return Promise.resolve();
        }
      );

      const result = await fetchSecretEnvVars();
      expect(result).toEqual({});
    });

    it('populates env from SW message in extension mode', async () => {
      vi.mocked(globalThis.chrome.runtime.sendMessage).mockImplementation(
        (msg: any, callback?: (resp: any) => void) => {
          if (callback && msg?.type === 'secrets.list-masked-entries') {
            callback({
              entries: [
                { name: 'GITHUB_TOKEN', maskedValue: 'ghp_masked_xyz', domains: ['github.com'] },
                { name: 'NPM_TOKEN', maskedValue: 'npm_masked_abc', domains: ['npmjs.org'] },
              ],
            });
          }
          return Promise.resolve();
        }
      );

      const result = await fetchSecretEnvVars();
      expect(result).toEqual({
        GITHUB_TOKEN: 'ghp_masked_xyz',
        NPM_TOKEN: 'npm_masked_abc',
      });
    });

    it('sends correct message type to SW', async () => {
      const sendMessageMock = vi
        .mocked(globalThis.chrome.runtime.sendMessage)
        .mockImplementation((msg: any, callback?: (resp: any) => void) => {
          if (callback) callback({ entries: [] });
          return Promise.resolve();
        });

      await fetchSecretEnvVars();

      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'secrets.list-masked-entries' },
        expect.any(Function)
      );
    });
  });
});
