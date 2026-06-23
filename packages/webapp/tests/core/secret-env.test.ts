import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSecretEnvVars } from '../../src/core/secret-env.js';
import { callSecretsBridge } from '../../src/core/secrets-bridge-client.js';
import {
  setBridgeToken,
  setExtensionDelegateId,
  setLocalApiBaseUrl,
} from '../../src/shell/proxied-fetch.js';

// The extension-delegate (thin-bridge) topology routes secret reads over the
// secrets.crud Port; mock that transport so we can assert the call site uses it
// instead of REST.
vi.mock('../../src/core/secrets-bridge-client.js', () => ({
  callSecretsBridge: vi.fn(),
}));

describe('fetchSecretEnvVars', () => {
  let originalChrome: unknown;

  beforeEach(() => {
    originalChrome = (globalThis as any).chrome;
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

    // Internal subsystem secrets (s3.*, oauth.*, db.*) must NOT be exposed
    // as shell env vars. Only valid POSIX identifiers are emitted.
    it('filters out dotted / non-POSIX names from the shell env', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { name: 'GITHUB_TOKEN', maskedValue: 'ghp_masked', domains: ['github.com'] },
          { name: 's3.r2.access_key_id', maskedValue: 'AKIAmasked', domains: ['*.r2.com'] },
          { name: 's3.r2.secret_access_key', maskedValue: 'secretmasked', domains: ['*.r2.com'] },
          { name: 'oauth.adobe.token', maskedValue: 'eyJmasked', domains: ['*.adobe.io'] },
          { name: 'NPM_TOKEN', maskedValue: 'npm_masked', domains: ['npmjs.org'] },
          { name: '0LEADING_DIGIT', maskedValue: 'should-skip', domains: ['x.com'] },
          { name: 'WITH-HYPHEN', maskedValue: 'should-skip', domains: ['x.com'] },
        ],
      } as Response);

      const result = await fetchSecretEnvVars();
      expect(result).toEqual({
        GITHUB_TOKEN: 'ghp_masked',
        NPM_TOKEN: 'npm_masked',
      });
      // Negative assertions — none of these may appear
      expect(result['s3.r2.access_key_id']).toBeUndefined();
      expect(result['oauth.adobe.token']).toBeUndefined();
      expect(result['0LEADING_DIGIT']).toBeUndefined();
      expect(result['WITH-HYPHEN']).toBeUndefined();
    });

    // GitHub OAuth env-alias bridge: when oauth.github.token is present
    // in the masked secrets feed, surface it as GITHUB_TOKEN / GH_TOKEN
    // so `git push` works after a single OAuth login (no manual export).
    describe('GitHub OAuth env-alias bridge', () => {
      it('exposes GITHUB_TOKEN and GH_TOKEN when oauth.github.token is present', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              name: 'oauth.github.token',
              maskedValue: 'ghp_masked_oauth',
              domains: ['github.com'],
            },
          ],
        } as Response);

        const result = await fetchSecretEnvVars();
        expect(result.GITHUB_TOKEN).toBe('ghp_masked_oauth');
        expect(result.GH_TOKEN).toBe('ghp_masked_oauth');
        // The dot-form must NOT leak into printenv — only the aliases do.
        expect(result['oauth.github.token']).toBeUndefined();
      });

      it('does not expose GITHUB_TOKEN/GH_TOKEN when oauth.github.token is absent', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { name: 'NPM_TOKEN', maskedValue: 'npm_masked', domains: ['npmjs.org'] },
            { name: 'oauth.adobe.token', maskedValue: 'eyJmasked', domains: ['*.adobe.io'] },
          ],
        } as Response);

        const result = await fetchSecretEnvVars();
        expect(result).toEqual({ NPM_TOKEN: 'npm_masked' });
        expect(result.GITHUB_TOKEN).toBeUndefined();
        expect(result.GH_TOKEN).toBeUndefined();
      });

      it('user-set GITHUB_TOKEN wins over the OAuth alias', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { name: 'GITHUB_TOKEN', maskedValue: 'user_masked_github', domains: ['github.com'] },
            {
              name: 'oauth.github.token',
              maskedValue: 'ghp_masked_oauth',
              domains: ['github.com'],
            },
          ],
        } as Response);

        const result = await fetchSecretEnvVars();
        expect(result.GITHUB_TOKEN).toBe('user_masked_github');
        // GH_TOKEN was not user-set, so the OAuth alias still fills it.
        expect(result.GH_TOKEN).toBe('ghp_masked_oauth');
        expect(result['oauth.github.token']).toBeUndefined();
      });

      it('user-set GH_TOKEN wins over the OAuth alias', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { name: 'GH_TOKEN', maskedValue: 'user_masked_gh', domains: ['github.com'] },
            {
              name: 'oauth.github.token',
              maskedValue: 'ghp_masked_oauth',
              domains: ['github.com'],
            },
          ],
        } as Response);

        const result = await fetchSecretEnvVars();
        expect(result.GH_TOKEN).toBe('user_masked_gh');
        // GITHUB_TOKEN was not user-set, so the OAuth alias still fills it.
        expect(result.GITHUB_TOKEN).toBe('ghp_masked_oauth');
        expect(result['oauth.github.token']).toBeUndefined();
      });
    });

    describe('thin-bridge URL + token', () => {
      afterEach(() => {
        setLocalApiBaseUrl(null);
        setBridgeToken(null);
      });

      it('legacy / same-origin: hits the relative path with no X-Bridge-Token', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValueOnce({
          ok: true,
          json: async () => [],
        } as Response);
        await fetchSecretEnvVars();
        const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [
          string,
          RequestInit | undefined,
        ];
        expect(url).toBe('/api/secrets/masked');
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers['X-Bridge-Token']).toBeUndefined();
      });

      it('thin-bridge: hits the bridge origin with X-Bridge-Token', async () => {
        setLocalApiBaseUrl('http://localhost:5710');
        setBridgeToken('abc-123');
        vi.mocked(globalThis.fetch).mockResolvedValueOnce({
          ok: true,
          json: async () => [],
        } as Response);
        await fetchSecretEnvVars();
        const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [
          string,
          RequestInit | undefined,
        ];
        expect(url).toBe('http://localhost:5710/api/secrets/masked');
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers['X-Bridge-Token']).toBe('abc-123');
      });

      it('base set but no token → absolute URL, still no X-Bridge-Token', async () => {
        setLocalApiBaseUrl('http://localhost:5710');
        vi.mocked(globalThis.fetch).mockResolvedValueOnce({
          ok: true,
          json: async () => [],
        } as Response);
        await fetchSecretEnvVars();
        const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [
          string,
          RequestInit | undefined,
        ];
        expect(url).toBe('http://localhost:5710/api/secrets/masked');
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers['X-Bridge-Token']).toBeUndefined();
      });

      it('token set but no base → relative path, X-Bridge-Token omitted', async () => {
        setBridgeToken('abc-123');
        vi.mocked(globalThis.fetch).mockResolvedValueOnce({
          ok: true,
          json: async () => [],
        } as Response);
        await fetchSecretEnvVars();
        const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [
          string,
          RequestInit | undefined,
        ];
        expect(url).toBe('/api/secrets/masked');
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers['X-Bridge-Token']).toBeUndefined();
      });
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
      vi.mocked((globalThis as any).chrome.runtime.sendMessage).mockImplementation(
        (_msg: any, callback?: (resp: any) => void) => {
          if (callback) callback({ entries: [] });
          return Promise.resolve();
        }
      );

      const result = await fetchSecretEnvVars();
      expect(result).toEqual({});
    });

    it('returns empty object when SW returns undefined entries', async () => {
      vi.mocked((globalThis as any).chrome.runtime.sendMessage).mockImplementation(
        (_msg: any, callback?: (resp: any) => void) => {
          if (callback) callback({});
          return Promise.resolve();
        }
      );

      const result = await fetchSecretEnvVars();
      expect(result).toEqual({});
    });

    it('populates env from SW message in extension mode', async () => {
      vi.mocked((globalThis as any).chrome.runtime.sendMessage).mockImplementation(
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
        .mocked((globalThis as any).chrome.runtime.sendMessage)
        .mockImplementation((_msg: any, callback?: (resp: any) => void) => {
          if (callback) callback({ entries: [] });
          return Promise.resolve();
        });

      await fetchSecretEnvVars();

      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'secrets.list-masked-entries' },
        expect.any(Function)
      );
    });

    it('filters out dotted / non-POSIX names in extension mode too', async () => {
      vi.mocked((globalThis as any).chrome.runtime.sendMessage).mockImplementation(
        (_msg: any, callback?: (resp: any) => void) => {
          if (callback) {
            callback({
              entries: [
                { name: 'GITHUB_TOKEN', maskedValue: 'ghp_masked', domains: ['github.com'] },
                { name: 's3.r2.access_key_id', maskedValue: 'AKIAmasked', domains: ['*.r2.com'] },
                { name: 'oauth.adobe.token', maskedValue: 'eyJmasked', domains: ['*.adobe.io'] },
              ],
            });
          }
          return Promise.resolve();
        }
      );

      const result = await fetchSecretEnvVars();
      expect(result).toEqual({ GITHUB_TOKEN: 'ghp_masked' });
    });

    // GitHub OAuth env-alias bridge — extension mode mirror of the CLI suite.
    describe('GitHub OAuth env-alias bridge', () => {
      it('exposes GITHUB_TOKEN and GH_TOKEN when oauth.github.token is present', async () => {
        vi.mocked((globalThis as any).chrome.runtime.sendMessage).mockImplementation(
          (_msg: any, callback?: (resp: any) => void) => {
            if (callback) {
              callback({
                entries: [
                  {
                    name: 'oauth.github.token',
                    maskedValue: 'ghp_masked_oauth',
                    domains: ['github.com'],
                  },
                ],
              });
            }
            return Promise.resolve();
          }
        );

        const result = await fetchSecretEnvVars();
        expect(result.GITHUB_TOKEN).toBe('ghp_masked_oauth');
        expect(result.GH_TOKEN).toBe('ghp_masked_oauth');
        expect(result['oauth.github.token']).toBeUndefined();
      });

      it('does not expose GITHUB_TOKEN/GH_TOKEN when oauth.github.token is absent', async () => {
        vi.mocked((globalThis as any).chrome.runtime.sendMessage).mockImplementation(
          (_msg: any, callback?: (resp: any) => void) => {
            if (callback) {
              callback({
                entries: [{ name: 'NPM_TOKEN', maskedValue: 'npm_masked', domains: ['npmjs.org'] }],
              });
            }
            return Promise.resolve();
          }
        );

        const result = await fetchSecretEnvVars();
        expect(result).toEqual({ NPM_TOKEN: 'npm_masked' });
        expect(result.GITHUB_TOKEN).toBeUndefined();
        expect(result.GH_TOKEN).toBeUndefined();
      });

      it('user-set GITHUB_TOKEN wins over the OAuth alias', async () => {
        vi.mocked((globalThis as any).chrome.runtime.sendMessage).mockImplementation(
          (_msg: any, callback?: (resp: any) => void) => {
            if (callback) {
              callback({
                entries: [
                  {
                    name: 'GITHUB_TOKEN',
                    maskedValue: 'user_masked_github',
                    domains: ['github.com'],
                  },
                  {
                    name: 'oauth.github.token',
                    maskedValue: 'ghp_masked_oauth',
                    domains: ['github.com'],
                  },
                ],
              });
            }
            return Promise.resolve();
          }
        );

        const result = await fetchSecretEnvVars();
        expect(result.GITHUB_TOKEN).toBe('user_masked_github');
        expect(result.GH_TOKEN).toBe('ghp_masked_oauth');
      });

      it('user-set GH_TOKEN wins over the OAuth alias', async () => {
        vi.mocked((globalThis as any).chrome.runtime.sendMessage).mockImplementation(
          (_msg: any, callback?: (resp: any) => void) => {
            if (callback) {
              callback({
                entries: [
                  { name: 'GH_TOKEN', maskedValue: 'user_masked_gh', domains: ['github.com'] },
                  {
                    name: 'oauth.github.token',
                    maskedValue: 'ghp_masked_oauth',
                    domains: ['github.com'],
                  },
                ],
              });
            }
            return Promise.resolve();
          }
        );

        const result = await fetchSecretEnvVars();
        expect(result.GH_TOKEN).toBe('user_masked_gh');
        expect(result.GITHUB_TOKEN).toBe('ghp_masked_oauth');
      });
    });
  });

  describe('Extension delegate (thin-bridge) mode', () => {
    beforeEach(() => {
      delete (globalThis as any).chrome;
      setExtensionDelegateId('delegate-ext-id');
      globalThis.fetch = vi.fn();
      vi.mocked(callSecretsBridge).mockReset();
    });

    afterEach(() => {
      setExtensionDelegateId(null);
    });

    it('routes through callSecretsBridge (not REST) and maps entries', async () => {
      vi.mocked(callSecretsBridge).mockResolvedValueOnce({
        entries: [{ name: 'GITHUB_TOKEN', maskedValue: 'ghp_masked', domains: ['github.com'] }],
      });

      const result = await fetchSecretEnvVars();
      expect(callSecretsBridge).toHaveBeenCalledWith('secrets.list-masked-entries');
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(result).toEqual({ GITHUB_TOKEN: 'ghp_masked' });
    });

    it('returns empty object when the bridge is unavailable (undefined)', async () => {
      vi.mocked(callSecretsBridge).mockResolvedValueOnce(undefined);

      const result = await fetchSecretEnvVars();
      expect(result).toEqual({});
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });
});
