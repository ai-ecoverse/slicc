import { describe, expect, it } from 'vitest';

import { scopesSatisfied } from '../../src/providers/oauth-scopes.js';

describe('scopesSatisfied', () => {
  it('returns false when the granted scopes are unknown', () => {
    expect(scopesSatisfied(undefined, 'repo')).toBe(false);
    expect(scopesSatisfied('', 'repo')).toBe(false);
    expect(scopesSatisfied('   ', 'repo')).toBe(false);
  });

  it('returns true when nothing is requested but something is granted', () => {
    expect(scopesSatisfied('repo', '')).toBe(true);
  });

  it.each([
    ['comma', 'repo,read:user,user:email'],
    ['space', 'repo read:user user:email'],
    ['mixed', 'repo, read:user  user:email'],
    ['trailing separators', ' repo,,read:user , user:email '],
  ])('normalizes %s separated grants', (_label, granted) => {
    expect(scopesSatisfied(granted, 'read:user,user:email')).toBe(true);
  });

  it('is case-insensitive on both sides', () => {
    expect(scopesSatisfied('Repo,READ:User', 'repo, read:user')).toBe(true);
    expect(scopesSatisfied('repo', 'PUBLIC_REPO')).toBe(true);
  });

  it.each(['repo:status', 'repo_deployment', 'public_repo', 'repo:invite', 'security_events'])(
    'treats repo as covering %s',
    (implied) => {
      expect(scopesSatisfied('repo', implied)).toBe(true);
    }
  );

  it.each(['read:user', 'user:email', 'user:follow'])('treats user as covering %s', (implied) => {
    expect(scopesSatisfied('user', implied)).toBe(true);
  });

  it('walks the admin: > write: > read: ladder transitively', () => {
    expect(scopesSatisfied('admin:org', 'write:org')).toBe(true);
    expect(scopesSatisfied('admin:org', 'read:org')).toBe(true);
    expect(scopesSatisfied('write:org', 'read:org')).toBe(true);
    expect(scopesSatisfied('read:org', 'write:org')).toBe(false);
  });

  it.each(['admin:repo_hook', 'admin:public_key', 'admin:org_hook', 'admin:gpg_key'])(
    'applies the ladder generically to %s',
    (granted) => {
      const suffix = granted.slice('admin:'.length);
      expect(scopesSatisfied(granted, `read:${suffix}`)).toBe(true);
    }
  );

  it('covers the discussion and project implications', () => {
    expect(scopesSatisfied('write:discussion', 'read:discussion')).toBe(true);
    expect(scopesSatisfied('project', 'read:project')).toBe(true);
  });

  it('rejects a scope that is not granted or implied', () => {
    expect(scopesSatisfied('repo,read:user', 'admin:org')).toBe(false);
    expect(scopesSatisfied('repo', 'workflow')).toBe(false);
  });

  it('requires every requested scope to be covered', () => {
    expect(scopesSatisfied('repo,workflow', 'repo,workflow')).toBe(true);
    expect(scopesSatisfied('repo,workflow', 'repo,workflow,gist')).toBe(false);
  });

  it('ignores a bare prefix with no suffix', () => {
    expect(scopesSatisfied('admin:', 'read:')).toBe(false);
  });
});
