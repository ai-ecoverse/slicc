import { describe, expect, it } from 'vitest';
import { isPathWithinServedRoot } from '../../src/scoops/preview-security.js';

describe('isPathWithinServedRoot', () => {
  it('accepts a path equal to the root', () => {
    expect(isPathWithinServedRoot('/workspace/dist', '/workspace/dist')).toBe(true);
  });

  it('accepts paths strictly under the root', () => {
    expect(isPathWithinServedRoot('/workspace/dist/index.html', '/workspace/dist')).toBe(true);
    expect(isPathWithinServedRoot('/workspace/dist/sub/asset.js', '/workspace/dist')).toBe(true);
  });

  it('rejects sibling-prefix paths (the "dist-secret" trick)', () => {
    expect(isPathWithinServedRoot('/workspace/dist-secret', '/workspace/dist')).toBe(false);
    expect(isPathWithinServedRoot('/workspace/dist-secret/foo.js', '/workspace/dist')).toBe(false);
  });

  it('rejects parent-traversal segments', () => {
    expect(isPathWithinServedRoot('/workspace/dist/../etc/passwd', '/workspace/dist')).toBe(false);
    expect(isPathWithinServedRoot('/workspace/dist/foo/../../etc', '/workspace/dist')).toBe(false);
  });

  it('rejects trailing-dot segments', () => {
    expect(isPathWithinServedRoot('/workspace/dist/./.', '/workspace/dist')).toBe(false);
  });

  it('rejects paths above the root', () => {
    expect(isPathWithinServedRoot('/workspace', '/workspace/dist')).toBe(false);
    expect(isPathWithinServedRoot('/etc/passwd', '/workspace/dist')).toBe(false);
  });

  it('normalizes trailing slashes on the root', () => {
    expect(isPathWithinServedRoot('/workspace/dist/x', '/workspace/dist/')).toBe(true);
  });

  it('is fail-closed when the root is `/` (defense against an over-broad serve)', () => {
    expect(isPathWithinServedRoot('/anything', '/')).toBe(false);
  });

  it('rejects empty paths', () => {
    expect(isPathWithinServedRoot('', '/workspace/dist')).toBe(false);
  });

  it('rejects non-absolute paths', () => {
    expect(isPathWithinServedRoot('workspace/dist/x', '/workspace/dist')).toBe(false);
  });

  it('rejects URL-encoded traversal', () => {
    expect(isPathWithinServedRoot('/workspace/dist/%2E%2E/etc', '/workspace/dist')).toBe(false);
  });

  it('accepts deep nesting', () => {
    expect(isPathWithinServedRoot('/workspace/dist/a/b/c/d/e/f/g.js', '/workspace/dist')).toBe(
      true
    );
  });

  it('rejects empty servedRoot', () => {
    expect(isPathWithinServedRoot('/anything', '')).toBe(false);
  });
});
