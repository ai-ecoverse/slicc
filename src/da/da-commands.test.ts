/**
 * Tests for DA commands.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DACommands } from './da-commands.js';
import { VirtualFS } from '../fs/index.js';

// Mock daFetch
vi.mock('./da-http.js', () => ({
  daFetch: vi.fn(),
}));

import { daFetch } from './da-http.js';
const mockFetch = vi.mocked(daFetch);

describe('DACommands', () => {
  let fs: VirtualFS;
  let da: DACommands;

  beforeEach(async () => {
    vi.clearAllMocks();
    fs = await VirtualFS.create({ dbName: `da-test-${Date.now()}-${Math.random()}` });
    da = new DACommands({ fs });
  });

  describe('help', () => {
    it('shows help with no args', async () => {
      const result = await da.execute([], '/');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('da — Document Authoring CLI');
      expect(result.stdout).toContain('config');
      expect(result.stdout).toContain('list');
      expect(result.stdout).toContain('get');
    });

    it('shows help with --help', async () => {
      const result = await da.execute(['--help'], '/');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('da — Document Authoring CLI');
    });
  });

  describe('unknown command', () => {
    it('returns error for unknown command', async () => {
      const result = await da.execute(['banana'], '/');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("'banana' is not a da command");
    });
  });

  describe('config', () => {
    it('shows empty config when none set', async () => {
      const result = await da.execute(['config'], '/');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No DA configuration');
    });

    it('sets and retrieves a config key', async () => {
      let result = await da.execute(['config', 'org', 'myorg'], '/');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Set org = myorg');

      result = await da.execute(['config', 'org'], '/');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('myorg\n');
    });

    it('masks secrets in full config display', async () => {
      await da.execute(['config', 'org', 'myorg'], '/');
      await da.execute(['config', 'client-secret', 'supersecret'], '/');
      await da.execute(['config', 'service-token', 'mytoken'], '/');

      const result = await da.execute(['config'], '/');
      expect(result.stdout).toContain('org = myorg');
      expect(result.stdout).toContain('clientSecret = ****');
      expect(result.stdout).toContain('serviceToken = ****');
      expect(result.stdout).not.toContain('supersecret');
      expect(result.stdout).not.toContain('mytoken');
    });

    it('normalizes kebab-case config keys', async () => {
      await da.execute(['config', 'client-id', 'my-id'], '/');
      const result = await da.execute(['config', 'clientId'], '/');
      expect(result.stdout).toBe('my-id\n');
    });

    it('persists config to VFS', async () => {
      await da.execute(['config', 'org', 'testorg'], '/');
      const content = await fs.readTextFile('/shared/.da-config.json');
      const parsed = JSON.parse(content);
      expect(parsed.org).toBe('testorg');
    });

    it('returns error for unset key', async () => {
      const result = await da.execute(['config', 'org'], '/');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("key 'org' not set");
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      // Set up config
      await fs.writeFile('/shared/.da-config.json', JSON.stringify({
        org: 'testorg', repo: 'testrepo', clientId: 'cid', clientSecret: 'cs', serviceToken: 'st',
      }));
    });

    it('requires config', async () => {
      // Use a fresh DA instance without config
      const freshFs = await VirtualFS.create({ dbName: `da-test-fresh-${Date.now()}` });
      const freshDa = new DACommands({ fs: freshFs });
      const result = await freshDa.execute(['list'], '/');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not configured');
    });

    it('lists pages from DA', async () => {
      // Mock IMS token
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'tok123', expires_in: 3600,
      }), { status: 200 }));

      // Mock list response
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([
        { name: 'index.html', ext: 'html', path: '/testorg/testrepo/tavex/index.html' },
        { name: 'dosing.html', ext: 'html', path: '/testorg/testrepo/tavex/dosing.html' },
        { name: 'media', path: '/testorg/testrepo/tavex/media' },
      ]), { status: 200 }));

      const result = await da.execute(['list', '/tavex'], '/');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('index.html');
      expect(result.stdout).toContain('dosing.html');
    });

    it('shows empty message when no entries', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'tok', expires_in: 3600,
      }), { status: 200 }));
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

      const result = await da.execute(['list'], '/');
      expect(result.stdout).toContain('(empty)');
    });
  });

  describe('get', () => {
    beforeEach(async () => {
      await fs.writeFile('/shared/.da-config.json', JSON.stringify({
        org: 'testorg', repo: 'testrepo', clientId: 'cid', clientSecret: 'cs', serviceToken: 'st',
      }));
    });

    it('returns usage when no path given', async () => {
      const result = await da.execute(['get'], '/');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Usage');
    });

    it('fetches and returns page HTML', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'tok', expires_in: 3600,
      }), { status: 200 }));
      mockFetch.mockResolvedValueOnce(new Response('<html><body>Hello</body></html>', { status: 200 }));

      const result = await da.execute(['get', '/tavex/dosing'], '/');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('<html>');
    });

    it('saves to VFS with --output flag', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'tok', expires_in: 3600,
      }), { status: 200 }));
      mockFetch.mockResolvedValueOnce(new Response('<html>saved</html>', { status: 200 }));

      const result = await da.execute(['get', '/tavex/dosing', '--output', '/workspace/out.html'], '/');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Saved to /workspace/out.html');

      const content = await fs.readTextFile('/workspace/out.html');
      expect(content).toBe('<html>saved</html>');
    });
  });

  describe('put', () => {
    beforeEach(async () => {
      await fs.writeFile('/shared/.da-config.json', JSON.stringify({
        org: 'testorg', repo: 'testrepo', clientId: 'cid', clientSecret: 'cs', serviceToken: 'st',
      }));
    });

    it('returns usage when no path given', async () => {
      const result = await da.execute(['put'], '/');
      expect(result.exitCode).toBe(1);
    });

    it('puts file content to DA', async () => {
      await fs.writeFile('/workspace/page.html', '<html>new content</html>');

      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'tok', expires_in: 3600,
      }), { status: 200 }));
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));

      const result = await da.execute(['put', '/tavex/dosing', '/workspace/page.html'], '/');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Saved: tavex/dosing.html');

      // Verify the fetch was called with PUT
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const putCall = mockFetch.mock.calls[1];
      expect(putCall[0]).toContain('/source/testorg/testrepo/tavex/dosing.html');
      expect(putCall[1]?.method).toBe('PUT');
    });
  });

  describe('preview', () => {
    beforeEach(async () => {
      await fs.writeFile('/shared/.da-config.json', JSON.stringify({
        org: 'testorg', repo: 'testrepo', ref: 'main', clientId: 'cid', clientSecret: 'cs', serviceToken: 'st',
      }));
    });

    it('sends preview request', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'tok', expires_in: 3600,
      }), { status: 200 }));
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        preview: { url: 'https://main--testrepo--testorg.aem.page/tavex/dosing' },
      }), { status: 200 }));

      const result = await da.execute(['preview', '/tavex/dosing'], '/');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Preview:');
      expect(result.stdout).toContain('aem.page');
    });
  });

  describe('publish', () => {
    beforeEach(async () => {
      await fs.writeFile('/shared/.da-config.json', JSON.stringify({
        org: 'testorg', repo: 'testrepo', ref: 'main', clientId: 'cid', clientSecret: 'cs', serviceToken: 'st',
      }));
    });

    it('sends publish request', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'tok', expires_in: 3600,
      }), { status: 200 }));
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        live: { url: 'https://main--testrepo--testorg.aem.live/tavex/dosing' },
      }), { status: 200 }));

      const result = await da.execute(['publish', '/tavex/dosing'], '/');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Published:');
      expect(result.stdout).toContain('aem.live');
    });
  });

  describe('token caching', () => {
    beforeEach(async () => {
      await fs.writeFile('/shared/.da-config.json', JSON.stringify({
        org: 'testorg', repo: 'testrepo', clientId: 'cid', clientSecret: 'cs', serviceToken: 'st',
      }));
    });

    it('caches IMS token across calls', async () => {
      // First call — token exchange
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'tok', expires_in: 3600,
      }), { status: 200 }));
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

      await da.execute(['list'], '/');

      // Second call — should reuse cached token (no new IMS call)
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

      await da.execute(['list'], '/');

      // 3 total calls: 1 IMS + 2 list (token cached for second)
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('path normalization', () => {
    beforeEach(async () => {
      await fs.writeFile('/shared/.da-config.json', JSON.stringify({
        org: 'testorg', repo: 'testrepo', clientId: 'cid', clientSecret: 'cs', serviceToken: 'st',
      }));
    });

    it('normalizes DA paths correctly', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'tok', expires_in: 3600,
      }), { status: 200 }));
      mockFetch.mockResolvedValueOnce(new Response('<html/>', { status: 200 }));

      await da.execute(['get', '/tavex/'], '/');

      // Path /tavex/ → tavex/index.html
      const getUrl = mockFetch.mock.calls[1][0] as string;
      expect(getUrl).toContain('/source/testorg/testrepo/tavex/index.html');
    });
  });
});
