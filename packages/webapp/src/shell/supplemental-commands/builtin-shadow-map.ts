import { INSTALL_PACKAGES } from './biome-command.js';
import { ESBUILD_VERSION } from './esbuild-wasm.js';
import { BUNDLED_FFMPEG_CORE_VERSION } from './ffmpeg-wasm.js';
import { BUNDLED_MAGICK_VERSION } from './magick-wasm.js';
import { TYPESCRIPT_VFS_INSTALL_COMMAND } from './shared.js';
import { V86_PINNED_VERSION } from './v86-wasm.js';
import { VPOD_PACKAGE, VPOD_PINNED_VERSION } from './vpod-loader.js';

export interface BuiltinShadow {
  command: string;
  example: string;
  bootstrap?: string;
}

const biome: BuiltinShadow = {
  command: 'biome',
  example: 'biome check foo.js',
  bootstrap: `ipk add ${INSTALL_PACKAGES}`,
};
const playwright: BuiltinShadow = {
  command: 'playwright-cli',
  example: 'playwright-cli open https://example.com',
};
const puppeteer: BuiltinShadow = {
  command: 'puppeteer',
  example: 'puppeteer open https://example.com',
};
const convert: BuiltinShadow = {
  command: 'convert',
  example: 'convert input.png output.jpg',
  bootstrap: `ipk add @imagemagick/magick-wasm@${BUNDLED_MAGICK_VERSION}`,
};
const magick: BuiltinShadow = {
  ...convert,
  command: 'magick',
  example: 'magick input.png output.jpg',
};

export const BUILTIN_SHADOW_MAP: Readonly<Record<string, BuiltinShadow>> = {
  '@biomejs/biome': biome,
  biome,
  esbuild: {
    command: 'esbuild',
    example: 'esbuild --bundle src/index.js --outfile=dist/bundle.js',
    bootstrap: `ipk add esbuild-wasm@${ESBUILD_VERSION}`,
  },
  playwright,
  '@playwright/test': playwright,
  'playwright-core': playwright,
  puppeteer,
  'puppeteer-core': puppeteer,
  typescript: {
    command: 'tsc',
    example: 'tsc --noEmit',
    bootstrap: TYPESCRIPT_VFS_INSTALL_COMMAND,
  },
  imagemagick: convert,
  'imagemagick-cli': convert,
  'imagemagick-convert': convert,
  'magick-cli': magick,
  '@imagemagick/magick-wasm': magick,
  ffmpeg: {
    command: 'ffmpeg',
    example: 'ffmpeg -i input.mp4 output.webm',
    bootstrap: `ipk add @ffmpeg/core@${BUNDLED_FFMPEG_CORE_VERSION}`,
  },
  '@ffmpeg/ffmpeg': {
    command: 'ffmpeg',
    example: 'ffmpeg -i input.mp4 output.webm',
    bootstrap: `ipk add @ffmpeg/core@${BUNDLED_FFMPEG_CORE_VERSION}`,
  },
  sqlite3: { command: 'sqlite3', example: 'sqlite3 database.db "SELECT 1"' },
  v86: {
    command: 'v86',
    example: 'v86 start -cdrom alpine.iso',
    bootstrap: `ipk add v86@${V86_PINNED_VERSION}`,
  },
  [VPOD_PACKAGE]: {
    command: 'vpod',
    example: 'vpod run uname -a',
    bootstrap: `ipk add ${VPOD_PACKAGE}@${VPOD_PINNED_VERSION}`,
  },
};

export function lookupBuiltinShadow(requestedPackage: string): BuiltinShadow | undefined {
  return Object.hasOwn(BUILTIN_SHADOW_MAP, requestedPackage)
    ? BUILTIN_SHADOW_MAP[requestedPackage]
    : undefined;
}

function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function formatBuiltinShadowHint(
  runnerName: string,
  requestedPackage: string,
  requestedArgs: readonly string[],
  shadow: BuiltinShadow
): string {
  const invocation = requestedArgs.length
    ? [shadow.command, ...requestedArgs].map(quoteArg).join(' ')
    : shadow.example;
  const lines = [
    `${runnerName}: SLICC has a built-in \`${shadow.command}\` for npm package \`${requestedPackage}\`.`,
    `  try: ${invocation}`,
  ];
  if (shadow.bootstrap) lines.push(`  first run: ${shadow.bootstrap}`);
  lines.push(
    `  install anyway: ${[runnerName, '--force', requestedPackage, ...requestedArgs].map(quoteArg).join(' ')}`
  );
  return `${lines.join('\n')}\n`;
}
