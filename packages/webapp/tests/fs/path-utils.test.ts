import { describe, it, expect } from 'vitest';
import { normalizePath, splitPath, pathSegments, joinPath } from '../../src/fs/path-utils.js';

describe('normalizePath', () => {
  it('returns / for empty string', () => {
    expect(normalizePath('')).toBe('/');
  });

  it('returns / for root', () => {
    expect(normalizePath('/')).toBe('/');
  });

  it('adds leading slash', () => {
    expect(normalizePath('a/b')).toBe('/a/b');
  });

  it('removes trailing slash', () => {
    expect(normalizePath('/a/b/')).toBe('/a/b');
  });

  it('collapses double slashes', () => {
    expect(normalizePath('/a//b///c')).toBe('/a/b/c');
  });

  it('resolves . segments', () => {
    expect(normalizePath('/a/./b/./c')).toBe('/a/b/c');
  });

  it('resolves .. segments', () => {
    expect(normalizePath('/a/b/../c')).toBe('/a/c');
  });

  it('does not go above root with ..', () => {
    expect(normalizePath('/../..')).toBe('/');
  });
});

describe('splitPath', () => {
  it('splits root', () => {
    expect(splitPath('/')).toEqual({ dir: '/', base: '' });
  });

  it('splits top-level path', () => {
    expect(splitPath('/file.txt')).toEqual({ dir: '/', base: 'file.txt' });
  });

  it('splits nested path', () => {
    expect(splitPath('/a/b/c.txt')).toEqual({ dir: '/a/b', base: 'c.txt' });
  });
});

describe('pathSegments', () => {
  it('returns empty for root', () => {
    expect(pathSegments('/')).toEqual([]);
  });

  it('returns segments', () => {
    expect(pathSegments('/a/b/c')).toEqual(['a', 'b', 'c']);
  });
});

describe('joinPath', () => {
  it('joins segments', () => {
    expect(joinPath('/a', 'b', 'c')).toBe('/a/b/c');
  });

  it('normalizes result', () => {
    expect(joinPath('/a/', '/b/', 'c')).toBe('/a/b/c');
  });
});
