import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INSTALL_PACKAGES } from '../../../src/shell/supplemental-commands/biome-command.js';
import {
  BUILTIN_SHADOW_MAP,
  formatBuiltinShadowHint,
  lookupBuiltinShadow,
} from '../../../src/shell/supplemental-commands/builtin-shadow-map.js';
import { ESBUILD_VERSION } from '../../../src/shell/supplemental-commands/esbuild-wasm.js';
import { BUNDLED_FFMPEG_CORE_VERSION } from '../../../src/shell/supplemental-commands/ffmpeg-wasm.js';
import { BUNDLED_MAGICK_VERSION } from '../../../src/shell/supplemental-commands/magick-wasm.js';
import { GLOBAL_IPK_ADD } from '../../../src/shell/supplemental-commands/shared.js';
import { V86_PINNED_VERSION } from '../../../src/shell/supplemental-commands/v86-wasm.js';

describe('built-in shadow map', () => {
  it('looks up unscoped and scoped package names', () => {
    expect(lookupBuiltinShadow('biome')?.command).toBe('biome');
    expect(lookupBuiltinShadow('@biomejs/biome')?.command).toBe('biome');
    expect(lookupBuiltinShadow('@playwright/test')?.command).toBe('playwright-cli');
    expect(lookupBuiltinShadow('@imagemagick/magick-wasm')?.command).toBe('magick');
  });

  it('returns undefined for an unknown package', () => {
    expect(lookupBuiltinShadow('some-unmapped-pkg')).toBeUndefined();
  });

  it('ignores inherited keys while resolving own entries', () => {
    expect(lookupBuiltinShadow('constructor')).toBeUndefined();
    expect(lookupBuiltinShadow('biome')?.command).toBe('biome');
  });

  it('keeps bootstrap versions tied to the command version constants', () => {
    expect(BUILTIN_SHADOW_MAP.biome.bootstrap).toBe(`${GLOBAL_IPK_ADD} ${INSTALL_PACKAGES}`);
    expect(BUILTIN_SHADOW_MAP.esbuild.bootstrap).toBe(
      `${GLOBAL_IPK_ADD} esbuild-wasm@${ESBUILD_VERSION}`
    );
    expect(BUILTIN_SHADOW_MAP.ffmpeg.bootstrap).toBe(
      `${GLOBAL_IPK_ADD} @ffmpeg/core@${BUNDLED_FFMPEG_CORE_VERSION}`
    );
    expect(BUILTIN_SHADOW_MAP.imagemagick.bootstrap).toBe(
      `${GLOBAL_IPK_ADD} @imagemagick/magick-wasm@${BUNDLED_MAGICK_VERSION}`
    );
    expect(BUILTIN_SHADOW_MAP.v86.bootstrap).toBe(`${GLOBAL_IPK_ADD} v86@${V86_PINNED_VERSION}`);
  });
});

describe('formatBuiltinShadowHint', () => {
  it('uses the runner name and repeats user arguments in the suggested invocation', () => {
    const shadow = lookupBuiltinShadow('@biomejs/biome')!;
    const hint = formatBuiltinShadowHint('npx', '@biomejs/biome', ['check', 'foo.js'], shadow);

    expect(hint).toMatch(/^npx:/);
    expect(hint).toContain('try: biome check foo.js');
    expect(hint).toContain(`first run: ${GLOBAL_IPK_ADD} ${INSTALL_PACKAGES}`);
    expect(hint).toContain('npx --force @biomejs/biome check foo.js');
  });

  it('uses the entry example when no user arguments were supplied', () => {
    const shadow = lookupBuiltinShadow('sqlite3')!;
    const hint = formatBuiltinShadowHint('ipx', 'sqlite3', [], shadow);

    expect(hint).toMatch(/^ipx:/);
    expect(hint).toContain(`try: ${shadow.example}`);
    expect(hint).not.toContain('first run:');
  });
});

describe('docs/shell-reference.md builtin-shadow-map table', () => {
  // The doc names builtin-shadow-map.ts as authoritative and claims to list
  // "exactly" these package names. Guard against drift so the two never diverge.
  const here = dirname(fileURLToPath(import.meta.url));
  const doc = readFileSync(
    join(here, '..', '..', '..', '..', '..', 'docs', 'shell-reference.md'),
    'utf8'
  );

  // Collect every backtick-wrapped npm package name from the shadow-map table
  // (left column) — the rows between the "npm package names" header and the
  // first blank line that follows it.
  const tableStart = doc.indexOf('| npm package names');
  const tableSection = doc.slice(tableStart, doc.indexOf('\n\n', tableStart));
  const documentedPackages = new Set<string>();
  for (const row of tableSection.split('\n')) {
    if (!row.startsWith('|') || row.includes('---') || row.includes('npm package names')) {
      continue;
    }
    const [leftCell] = row.slice(1).split('|');
    for (const match of leftCell.matchAll(/`([^`]+)`/g)) {
      documentedPackages.add(match[1]);
    }
  }

  it('locates the shadow-map table in the doc', () => {
    expect(tableStart).toBeGreaterThan(-1);
    expect(documentedPackages.size).toBeGreaterThan(0);
  });

  it('documents exactly the package names the code maps', () => {
    const mapped = Object.keys(BUILTIN_SHADOW_MAP).sort();
    expect([...documentedPackages].sort()).toEqual(mapped);
  });
});
