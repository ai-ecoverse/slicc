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
import { V86_PINNED_VERSION } from '../../../src/shell/supplemental-commands/v86-wasm.js';
import {
  VPOD_PACKAGE,
  VPOD_PINNED_VERSION,
} from '../../../src/shell/supplemental-commands/vpod-loader.js';

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
    expect(BUILTIN_SHADOW_MAP.biome.bootstrap).toBe(`ipk add ${INSTALL_PACKAGES}`);
    expect(BUILTIN_SHADOW_MAP.esbuild.bootstrap).toBe(`ipk add esbuild-wasm@${ESBUILD_VERSION}`);
    expect(BUILTIN_SHADOW_MAP.ffmpeg.bootstrap).toBe(
      `ipk add @ffmpeg/core@${BUNDLED_FFMPEG_CORE_VERSION}`
    );
    expect(BUILTIN_SHADOW_MAP.imagemagick.bootstrap).toBe(
      `ipk add @imagemagick/magick-wasm@${BUNDLED_MAGICK_VERSION}`
    );
    expect(BUILTIN_SHADOW_MAP.v86.bootstrap).toBe(`ipk add v86@${V86_PINNED_VERSION}`);
    expect(BUILTIN_SHADOW_MAP[VPOD_PACKAGE].command).toBe('vpod');
    expect(BUILTIN_SHADOW_MAP[VPOD_PACKAGE].bootstrap).toBe(
      `ipk add ${VPOD_PACKAGE}@${VPOD_PINNED_VERSION}`
    );
  });
});

describe('formatBuiltinShadowHint', () => {
  it('uses the runner name and repeats user arguments in the suggested invocation', () => {
    const shadow = lookupBuiltinShadow('@biomejs/biome')!;
    const hint = formatBuiltinShadowHint('npx', '@biomejs/biome', ['check', 'foo.js'], shadow);

    expect(hint).toMatch(/^npx:/);
    expect(hint).toContain('try: biome check foo.js');
    expect(hint).toContain(`first run: ipk add ${INSTALL_PACKAGES}`);
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
