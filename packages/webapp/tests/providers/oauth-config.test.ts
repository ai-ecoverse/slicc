import { describe, expect, it } from 'vitest';
import { config as adobeProvider } from '../../providers/adobe.js';
import { config as githubProvider } from '../../providers/github.js';

describe('OAuth provider domain config', () => {
  it('github provider has bare github.com (for git push)', () => {
    expect(githubProvider.oauthTokenDomains).toContain('github.com');
    expect(githubProvider.oauthTokenDomains).toContain('api.github.com');
    expect(githubProvider.oauthTokenDomains).toContain('*.github.com');
  });
  it('adobe provider has IMS hosts', () => {
    expect(adobeProvider.oauthTokenDomains?.length).toBeGreaterThan(0);
    expect(adobeProvider.oauthTokenDomains).toContain('admin.hlx.page');
    expect(adobeProvider.oauthTokenDomains).toContain('admin.hlx.live');
    expect(adobeProvider.oauthTokenDomains).toContain('admin.aem.page');
    expect(adobeProvider.oauthTokenDomains).toContain('admin.aem.live');
  });
});
