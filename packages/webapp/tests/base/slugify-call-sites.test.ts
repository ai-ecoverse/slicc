/**
 * #2904 — the eight drifted slugify copies in webapp must call the shared
 * helper. Wrappers keep their own maxLen / fallback / suffix.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { slugifyAppName } from '../../src/shell/mcp/apps.js';
import { slugifyCompany } from '../../src/shell/supplemental-commands/upskill/catalog/catalog.js';
import { slugify as archiveSlugify } from '../../src/transcript/frozen-archive-writer.js';
import { slugifyUnitName } from '../../src/work-unit/record.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (...parts: string[]): string =>
  readFileSync(join(here, '..', '..', 'src', ...parts), 'utf8');

const FORMER_COPIES: { path: string[]; label: string }[] = [
  { path: ['work-unit', 'record.ts'], label: 'slugifyUnitName' },
  { path: ['shell', 'mcp', 'apps.ts'], label: 'slugifyAppName' },
  { path: ['transcript', 'frozen-archive-writer.ts'], label: 'slugify' },
  { path: ['transcript', 'zip-stream.ts'], label: 'makeFilename' },
  {
    path: ['shell', 'supplemental-commands', 'upskill', 'catalog', 'catalog.ts'],
    label: 'slugifyCompany',
  },
  { path: ['scoops', 'scoop-management-tools.ts'], label: 'folderFromDisplayName' },
  { path: ['scoops', 'onboarding-orchestrator.ts'], label: 'persistProfile' },
  { path: ['ui', 'wc', 'wc-settings.ts'], label: 'generateId' },
];

const INLINE_RECIPE = /replace\(\/\[\^a-z0-9\]\+\/g,\s*'-'\)/;

describe('#2904 former slugify copies go through @slicc/shared-ts', () => {
  it.each(FORMER_COPIES)('$label imports slugify from @slicc/shared-ts', ({ path }) => {
    const source = src(...path);
    expect(source).toContain("from '@slicc/shared-ts'");
    expect(source).toMatch(/\bslugify\b/);
    expect(source).not.toMatch(INLINE_RECIPE);
  });
});

describe('#2904 exported wrappers keep call-site maxLen / fallback', () => {
  it('slugifyUnitName: NFKD, multi-hyphen trim, cap 40, fallback cone', () => {
    expect(slugifyUnitName('Café Ölçü')).toBe('cafe-olcu');
    expect(slugifyUnitName('--foo--')).toBe('foo');
    expect(slugifyUnitName('***')).toBe('cone');
    expect(slugifyUnitName('x'.repeat(80))).toHaveLength(40);
  });

  it('slugifyAppName: NFKD, multi-hyphen trim, cap 64, fallback app', () => {
    expect(slugifyAppName('Café Ölçü')).toBe('cafe-olcu');
    expect(slugifyAppName('--foo--')).toBe('foo');
    expect(slugifyAppName('!!!')).toBe('app');
    expect(slugifyAppName('x'.repeat(200))).toHaveLength(64);
  });

  it('archive slugify: NFKD, multi-hyphen trim, cap 48, fallback session', () => {
    expect(archiveSlugify('Café Ölçü')).toBe('cafe-olcu');
    expect(archiveSlugify('--foo--')).toBe('foo');
    expect(archiveSlugify('')).toBe('session');
    expect(archiveSlugify('x'.repeat(80))).toHaveLength(48);
  });

  it('slugifyCompany: NFKD, multi-hyphen trim, null for empty / non-string', () => {
    expect(slugifyCompany('Café Ölçü')).toBe('cafe-olcu');
    expect(slugifyCompany('--foo--')).toBe('foo');
    expect(slugifyCompany('!!!')).toBeNull();
    expect(slugifyCompany('')).toBeNull();
    expect(slugifyCompany(42)).toBeNull();
  });
});
