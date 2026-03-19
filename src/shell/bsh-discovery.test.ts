import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../fs/virtual-fs.js';
import {
  discoverBshScripts,
  extractHostnamePattern,
  parseMatchDirectives,
  hostnameMatches,
  urlMatchesPattern,
  findMatchingScripts,
  type BshEntry,
} from './bsh-discovery.js';

let dbCounter = 0;

describe('extractHostnamePattern', () => {
  it('extracts exact hostname from a simple filename', () => {
    expect(extractHostnamePattern('/workspace/login.okta.com.bsh')).toBe('login.okta.com');
  });

  it('converts dash-dot prefix to wildcard', () => {
    expect(extractHostnamePattern('/workspace/-.okta.com.bsh')).toBe('*.okta.com');
  });

  it('handles deeply nested paths', () => {
    expect(extractHostnamePattern('/workspace/scripts/auth/-.example.com.bsh')).toBe('*.example.com');
  });

  it('returns null for non-.bsh files', () => {
    expect(extractHostnamePattern('/workspace/foo.jsh')).toBeNull();
  });

  it('returns null for empty basename', () => {
    expect(extractHostnamePattern('/workspace/.bsh')).toBeNull();
  });

  it('handles single-level domains', () => {
    expect(extractHostnamePattern('/workspace/localhost.bsh')).toBe('localhost');
  });
});

describe('parseMatchDirectives', () => {
  it('parses a single @match directive', () => {
    const content = '// @match *://login.okta.com/*\nconst x = 1;';
    expect(parseMatchDirectives(content)).toEqual(['*://login.okta.com/*']);
  });

  it('parses multiple @match directives', () => {
    const content = [
      '// @match *://login.okta.com/*',
      '// @match https://example.com/app/*',
      'const x = 1;',
    ].join('\n');
    expect(parseMatchDirectives(content)).toEqual([
      '*://login.okta.com/*',
      'https://example.com/app/*',
    ]);
  });

  it('returns empty array when no @match directives', () => {
    const content = 'const x = 1;\nconsole.log(x);';
    expect(parseMatchDirectives(content)).toEqual([]);
  });

  it('only parses within first 10 lines', () => {
    const lines = Array.from({ length: 12 }, (_, i) =>
      i === 11 ? '// @match *://late.com/*' : `// line ${i}`,
    );
    expect(parseMatchDirectives(lines.join('\n'))).toEqual([]);
  });

  it('handles whitespace variations', () => {
    const content = '  //  @match   https://example.com/*  ';
    expect(parseMatchDirectives(content)).toEqual(['https://example.com/*']);
  });
});

describe('hostnameMatches', () => {
  it('matches exact hostname', () => {
    expect(hostnameMatches('login.okta.com', 'login.okta.com')).toBe(true);
  });

  it('rejects non-matching exact hostname', () => {
    expect(hostnameMatches('other.okta.com', 'login.okta.com')).toBe(false);
  });

  it('matches wildcard subdomain', () => {
    expect(hostnameMatches('login.okta.com', '*.okta.com')).toBe(true);
  });

  it('matches nested wildcard subdomain', () => {
    expect(hostnameMatches('foo.bar.okta.com', '*.okta.com')).toBe(true);
  });

  it('does not match bare domain against wildcard', () => {
    expect(hostnameMatches('okta.com', '*.okta.com')).toBe(false);
  });

  it('does not match unrelated domain', () => {
    expect(hostnameMatches('evil.com', '*.okta.com')).toBe(false);
  });
});

describe('urlMatchesPattern', () => {
  it('matches wildcard scheme and any path', () => {
    expect(urlMatchesPattern('https://login.okta.com/foo', '*://login.okta.com/*')).toBe(true);
    expect(urlMatchesPattern('http://login.okta.com/bar', '*://login.okta.com/*')).toBe(true);
  });

  it('rejects wrong scheme when specific', () => {
    expect(urlMatchesPattern('http://example.com/', 'https://example.com/*')).toBe(false);
  });

  it('matches wildcard host in pattern', () => {
    expect(urlMatchesPattern('https://sub.example.com/app', '*://*.example.com/app*')).toBe(true);
  });

  it('rejects non-matching host', () => {
    expect(urlMatchesPattern('https://evil.com/', '*://example.com/*')).toBe(false);
  });

  it('matches path prefix with wildcard', () => {
    expect(urlMatchesPattern('https://example.com/app/page', 'https://example.com/app/*')).toBe(true);
  });

  it('rejects non-matching path', () => {
    expect(urlMatchesPattern('https://example.com/other', 'https://example.com/app/*')).toBe(false);
  });

  it('handles invalid URLs gracefully', () => {
    expect(urlMatchesPattern('not-a-url', '*://example.com/*')).toBe(false);
  });

  it('handles invalid patterns gracefully', () => {
    expect(urlMatchesPattern('https://example.com/', 'bad-pattern')).toBe(false);
  });
});

describe('findMatchingScripts', () => {
  const entries: BshEntry[] = [
    {
      path: '/workspace/-.okta.com.bsh',
      hostnamePattern: '*.okta.com',
      matchPatterns: ['*://login.okta.com/*'],
    },
    {
      path: '/workspace/-.example.com.bsh',
      hostnamePattern: '*.example.com',
      matchPatterns: [],
    },
    {
      path: '/workspace/exact.host.com.bsh',
      hostnamePattern: 'exact.host.com',
      matchPatterns: [],
    },
  ];

  it('matches by hostname and @match pattern', () => {
    const result = findMatchingScripts(entries, 'https://login.okta.com/home');
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/workspace/-.okta.com.bsh');
  });

  it('rejects hostname match when @match pattern does not match', () => {
    const result = findMatchingScripts(entries, 'https://admin.okta.com/home');
    expect(result).toHaveLength(0);
  });

  it('matches by hostname alone when no @match patterns', () => {
    const result = findMatchingScripts(entries, 'https://app.example.com/anything');
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/workspace/-.example.com.bsh');
  });

  it('matches exact hostname', () => {
    const result = findMatchingScripts(entries, 'https://exact.host.com/page');
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/workspace/exact.host.com.bsh');
  });

  it('returns empty for no matches', () => {
    const result = findMatchingScripts(entries, 'https://unrelated.com/');
    expect(result).toHaveLength(0);
  });

  it('handles invalid URLs gracefully', () => {
    const result = findMatchingScripts(entries, 'not-a-url');
    expect(result).toHaveLength(0);
  });
});

describe('discoverBshScripts', () => {
  let vfs: VirtualFS;

  beforeEach(async () => {
    vfs = await VirtualFS.create({
      dbName: `test-bsh-discovery-${dbCounter++}`,
      wipe: true,
    });
  });

  it('returns empty array when no .bsh files exist', async () => {
    const result = await discoverBshScripts(vfs);
    expect(result).toHaveLength(0);
  });

  it('discovers a .bsh file in /workspace', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', '// @match *://login.okta.com/*\nconsole.log("hi");');
    const result = await discoverBshScripts(vfs);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/workspace/-.okta.com.bsh');
    expect(result[0].hostnamePattern).toBe('*.okta.com');
    expect(result[0].matchPatterns).toEqual(['*://login.okta.com/*']);
  });

  it('discovers a .bsh file in /shared', async () => {
    await vfs.writeFile('/shared/login.example.com.bsh', 'console.log("hello");');
    const result = await discoverBshScripts(vfs);
    expect(result).toHaveLength(1);
    expect(result[0].hostnamePattern).toBe('login.example.com');
    expect(result[0].matchPatterns).toEqual([]);
  });

  it('discovers multiple .bsh files', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("okta");');
    await vfs.writeFile('/workspace/-.github.com.bsh', 'console.log("gh");');
    const result = await discoverBshScripts(vfs);
    expect(result).toHaveLength(2);
  });

  it('ignores non-.bsh files', async () => {
    await vfs.writeFile('/workspace/script.jsh', 'echo hello');
    await vfs.writeFile('/workspace/readme.md', '# Hello');
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');
    const result = await discoverBshScripts(vfs);
    expect(result).toHaveLength(1);
  });

  it('ignores files outside /workspace and /shared', async () => {
    await vfs.writeFile('/other/-.evil.com.bsh', 'console.log("evil");');
    const result = await discoverBshScripts(vfs);
    expect(result).toHaveLength(0);
  });
});
