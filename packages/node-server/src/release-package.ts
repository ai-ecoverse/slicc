import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { resolve, relative, join } from 'path';
import { fileURLToPath } from 'url';
import { deflateRawSync } from 'zlib';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');
const RELEASE_DIR = resolve(PROJECT_ROOT, 'artifacts', 'release');
const FIXED_ZIP_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
const ZIP_VERSION = 20;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_FILE_MODE = 0o100644;

interface PackageMetadata {
  name: string;
  version: string;
}

interface ExtensionMetadata {
  name: string;
  version: string;
}

interface ZipEntry {
  path: string;
  data: Buffer;
  mode: number;
}

interface ReleaseManifest {
  version: string;
  extensionArchive: string;
  npmPackageTarball: string;
}

const CRC32_TABLE = buildCrc32Table();

function comparePaths(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function sanitizeArtifactName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function assertMatchingVersions(packageVersion: string, extensionVersion: string): void {
  if (packageVersion !== extensionVersion) {
    throw new Error(
      `package.json version (${packageVersion}) must match manifest.json version (${extensionVersion}) before packaging release artifacts.`
    );
  }
}

export function collectZipEntries(rootDir: string): ZipEntry[] {
  const entries: ZipEntry[] = [];

  const walk = (currentDir: string): void => {
    for (const name of readdirSync(currentDir).sort(comparePaths)) {
      const fullPath = join(currentDir, name);
      const stats = statSync(fullPath);

      if (stats.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!stats.isFile()) continue;

      entries.push({
        path: relative(rootDir, fullPath).split('\\').join('/'),
        data: readFileSync(fullPath),
        mode: ZIP_FILE_MODE,
      });
    }
  };

  walk(rootDir);
  return entries;
}

export function createDeterministicZip(entries: readonly ZipEntry[]): Buffer {
  const sortedEntries = [...entries].sort((left, right) => comparePaths(left.path, right.path));
  const { dosDate, dosTime } = encodeDosDateTime(FIXED_ZIP_DATE);
  const localSections: Buffer[] = [];
  const centralSections: Buffer[] = [];
  let offset = 0;

  for (const entry of sortedEntries) {
    const fileName = Buffer.from(entry.path, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(ZIP_VERSION, 4);
    localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    localHeader.writeUInt16LE(ZIP_METHOD_DEFLATE, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(fileName.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localSection = Buffer.concat([localHeader, fileName, compressed]);
    localSections.push(localSection);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | ZIP_VERSION, 4);
    centralHeader.writeUInt16LE(ZIP_VERSION, 6);
    centralHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(ZIP_METHOD_DEFLATE, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(fileName.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    const centralSection = Buffer.concat([centralHeader, fileName]);
    centralSections.push(centralSection);
    offset += localSection.length;
  }

  const centralDirectory = Buffer.concat(centralSections);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(sortedEntries.length, 8);
  endRecord.writeUInt16LE(sortedEntries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localSections, centralDirectory, endRecord]);
}

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[index] = value >>> 0;
  }

  return table;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;

  for (const value of buffer) {
    crc = CRC32_TABLE[(crc ^ value) & 0xff]! ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function encodeDosDateTime(value: Date): { dosDate: number; dosTime: number } {
  const year = Math.max(value.getUTCFullYear(), 1980);
  const dosDate = ((year - 1980) << 9) | ((value.getUTCMonth() + 1) << 5) | value.getUTCDate();
  const dosTime =
    (value.getUTCHours() << 11) |
    (value.getUTCMinutes() << 5) |
    Math.floor(value.getUTCSeconds() / 2);

  return { dosDate, dosTime };
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function requirePath(path: string, description: string): void {
  if (!existsSync(path)) {
    throw new Error(
      `${description} was not found at ${path}. Run the required build command(s) first.`
    );
  }
}

function toProjectRelative(path: string): string {
  return relative(PROJECT_ROOT, path).split('\\').join('/');
}

function resolveNpmCommand(): { command: string; argsPrefix: string[] } {
  const npmExecPath = process.env['npm_execpath'];
  if (npmExecPath) {
    return { command: process.execPath, argsPrefix: [npmExecPath] };
  }

  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    argsPrefix: [],
  };
}

export function parseNpmPackFilename(output: string): string {
  const parsed = JSON.parse(output) as Array<{ filename?: string }>;
  const filename = parsed[0]?.filename;
  if (!filename) {
    throw new Error(`npm pack did not report an output filename. Raw output: ${output.trim()}`);
  }

  return filename;
}

function createExtensionArchive(metadata: ExtensionMetadata): string {
  const extensionDir = resolve(PROJECT_ROOT, 'dist', 'extension');
  requirePath(extensionDir, 'Extension build output');

  const zipPath = resolve(
    RELEASE_DIR,
    `${sanitizeArtifactName(metadata.name)}-extension-v${metadata.version}.zip`
  );
  const zipBuffer = createDeterministicZip(collectZipEntries(extensionDir));
  writeFileSync(zipPath, zipBuffer);
  return zipPath;
}

function createNpmPackageTarball(): string {
  requirePath(resolve(PROJECT_ROOT, 'dist', 'node-server'), 'CLI build output');
  requirePath(resolve(PROJECT_ROOT, 'dist', 'ui'), 'UI build output');

  const npm = resolveNpmCommand();
  const result = spawnSync(
    npm.command,
    [...npm.argsPrefix, 'pack', '--json', '--ignore-scripts', '--pack-destination', RELEASE_DIR],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'npm pack failed').trim());
  }

  return resolve(RELEASE_DIR, parseNpmPackFilename(result.stdout));
}

function writeReleaseManifest(manifest: ReleaseManifest): string {
  const manifestPath = resolve(RELEASE_DIR, 'release-artifacts.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

export function packageReleaseArtifacts(): ReleaseManifest {
  const packageJson = readJsonFile<PackageMetadata>(resolve(PROJECT_ROOT, 'package.json'));
  const extensionManifest = readJsonFile<ExtensionMetadata>(resolve(PROJECT_ROOT, 'packages/chrome-extension/manifest.json'));
  assertMatchingVersions(packageJson.version, extensionManifest.version);

  rmSync(RELEASE_DIR, { recursive: true, force: true });
  mkdirSync(RELEASE_DIR, { recursive: true });

  const extensionArchive = createExtensionArchive(extensionManifest);
  const npmPackageTarball = createNpmPackageTarball();
  const manifest: ReleaseManifest = {
    version: packageJson.version,
    extensionArchive: toProjectRelative(extensionArchive),
    npmPackageTarball: toProjectRelative(npmPackageTarball),
  };

  writeReleaseManifest(manifest);
  return manifest;
}

function main(): void {
  const manifest = packageReleaseArtifacts();
  console.log(`Created extension archive: ${manifest.extensionArchive}`);
  console.log(`Created npm package tarball: ${manifest.npmPackageTarball}`);
  console.log(
    `Created release manifest: ${toProjectRelative(resolve(RELEASE_DIR, 'release-artifacts.json'))}`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[package:release] ${message}`);
    process.exit(1);
  }
}
