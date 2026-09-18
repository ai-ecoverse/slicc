import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodePath, nodePath } from '../../../../src/kernel/realm/helpers/node-path.js';

describe('createNodePath', () => {
  it('resolves one relative argument against the realm cwd, not /', () => {
    const path = createNodePath(() => '/tmp');
    expect(path.resolve('out.pdf')).toBe('/tmp/out.pdf');
    expect(path.dirname(path.resolve('fixtures/x.pdf'))).toBe('/tmp/fixtures');
  });

  it('leaves an absolute argument unchanged', () => {
    const path = createNodePath(() => '/tmp');
    expect(path.resolve('/abs/out.pdf')).toBe('/abs/out.pdf');
    expect(path.resolve('/fixtures/x.pdf')).toBe('/fixtures/x.pdf');
  });

  it('still resolves path.resolve(cwd, rel) against the given base', () => {
    const path = createNodePath(() => '/home/user');
    expect(path.resolve('/tmp', 'out.pdf')).toBe('/tmp/out.pdf');
    expect(path.resolve('/tmp', 'sub', 'out.pdf')).toBe('/tmp/sub/out.pdf');
  });

  it('path.resolve() with no arguments returns cwd', () => {
    const path = createNodePath(() => '/tmp');
    expect(path.resolve()).toBe('/tmp');
  });

  it('reads cwd at resolve time, not at module construction', () => {
    let cwd = '/first';
    const path = createNodePath(() => cwd);
    expect(path.resolve('out.pdf')).toBe('/first/out.pdf');
    cwd = '/second';
    expect(path.resolve('out.pdf')).toBe('/second/out.pdf');
  });
});

describe('nodePath singleton', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('one-arg relative resolve uses process.cwd()', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/tmp');
    expect(nodePath.resolve('out.pdf')).toBe('/tmp/out.pdf');
    expect(nodePath.resolve('/abs/out.pdf')).toBe('/abs/out.pdf');
    expect(nodePath.resolve(process.cwd(), 'out.pdf')).toBe('/tmp/out.pdf');
  });
});
