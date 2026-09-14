import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join, relative, resolve } from 'path';
import { deflateRawSync } from 'zlib';

const FIXED_ZIP_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
const ZIP_VERSION = 20;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_FILE_MODE = 0o100644;

export interface PackageMetadata {
  name: string;
  version: string;
}

export interface ZipEntry {
  path: string;
  data: Buffer;
  mode: number;
}

export interface ReleaseManifest {
  version: string;
  extensionArchive: string;
  npmPackageTarball: string;
}

const CRC32_TABLE = buildCrc32Table();

export function comparePaths(left: string, right: string): number {
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

export function requirePath(path: string, description: string): void {
  if (!existsSync(path)) {
    throw new Error(
      `${description} was not found at ${path}. Run the required build command(s) first.`
    );
  }
}

export function toProjectRelative(projectRoot: string, path: string): string {
  return relative(projectRoot, path).split('\\').join('/');
}

export function resolveNpmCommand(
  options: { npmExecPath?: string; execPath?: string; platform?: NodeJS.Platform } = {}
): { command: string; argsPrefix: string[] } {
  const npmExecPath = options.npmExecPath ?? process.env['npm_execpath'];
  if (npmExecPath) {
    return { command: options.execPath ?? process.execPath, argsPrefix: [npmExecPath] };
  }

  return {
    command: (options.platform ?? process.platform) === 'win32' ? 'npm.cmd' : 'npm',
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

export function createExtensionArchive(
  metadata: PackageMetadata,
  projectRoot: string,
  releaseDir: string
): string {
  const extensionDir = resolve(projectRoot, 'dist', 'extension');
  requirePath(extensionDir, 'Extension build output');

  const zipPath = resolve(
    releaseDir,
    `${sanitizeArtifactName(metadata.name)}-extension-v${metadata.version}.zip`
  );
  const zipBuffer = createDeterministicZip(collectZipEntries(extensionDir));
  writeFileSync(zipPath, zipBuffer);
  return zipPath;
}

interface NpmPackResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function createNpmPackageTarball(options: {
  projectRoot: string;
  releaseDir: string;
  npm?: { command: string; argsPrefix: string[] };
  spawn?: (command: string, args: string[], options: object) => NpmPackResult;
}): string {
  requirePath(resolve(options.projectRoot, 'dist', 'node-server'), 'CLI build output');
  requirePath(resolve(options.projectRoot, 'dist', 'ui'), 'UI build output');

  const npm = options.npm ?? resolveNpmCommand();
  const args = [
    ...npm.argsPrefix,
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    options.releaseDir,
  ];
  const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
    cwd: options.projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  const result: NpmPackResult = options.spawn
    ? options.spawn(npm.command, args, spawnOptions)
    : spawnSync(npm.command, args, spawnOptions);

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'npm pack failed').trim());
  }

  return resolve(options.releaseDir, parseNpmPackFilename(result.stdout));
}

export function writeReleaseManifest(manifest: ReleaseManifest, releaseDir: string): string {
  const manifestPath = resolve(releaseDir, 'release-artifacts.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

export function packageReleaseArtifacts(options: {
  projectRoot: string;
  releaseDir?: string;
  spawn?: (command: string, args: string[], options: object) => NpmPackResult;
}): ReleaseManifest {
  const releaseDir = options.releaseDir ?? resolve(options.projectRoot, 'artifacts', 'release');
  const packageJson = readJsonFile<PackageMetadata>(resolve(options.projectRoot, 'package.json'));

  rmSync(releaseDir, { recursive: true, force: true });
  mkdirSync(releaseDir, { recursive: true });

  const extensionArchive = createExtensionArchive(packageJson, options.projectRoot, releaseDir);
  const npmPackageTarball = createNpmPackageTarball({
    projectRoot: options.projectRoot,
    releaseDir,
    spawn: options.spawn,
  });
  const manifest: ReleaseManifest = {
    version: packageJson.version,
    extensionArchive: toProjectRelative(options.projectRoot, extensionArchive),
    npmPackageTarball: toProjectRelative(options.projectRoot, npmPackageTarball),
  };

  writeReleaseManifest(manifest, releaseDir);
  return manifest;
}
