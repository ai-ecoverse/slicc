import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { relative, resolve } from 'path';

export interface PackageMetadata {
  name: string;
  version: string;
}

export interface ReleaseManifest {
  version: string;
  npmPackageTarball: string;
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

  const npmPackageTarball = createNpmPackageTarball({
    projectRoot: options.projectRoot,
    releaseDir,
    spawn: options.spawn,
  });
  const manifest: ReleaseManifest = {
    version: packageJson.version,
    npmPackageTarball: toProjectRelative(options.projectRoot, npmPackageTarball),
  };

  writeReleaseManifest(manifest, releaseDir);
  return manifest;
}
