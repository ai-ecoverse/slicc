import { describe, it, expect } from 'vitest';
import { config as githubProvider } from '../../providers/github.js';
import { config as adobeProvider } from '../../providers/adobe.js';

describe('OAuth provider domain config', () => {
  it('github provider has bare github.com (for git push)', () => {
    expect(githubProvider.oauthTokenDomains).toContain('github.com');
    expect(githubProvider.oauthTokenDomains).toContain('api.github.com');
    expect(githubProvider.oauthTokenDomains).toContain('*.github.com');
  });
  it('adobe provider has IMS hosts', () => {
    expect(adobeProvider.oauthTokenDomains?.length).toBeGreaterThan(0);
  });
});
