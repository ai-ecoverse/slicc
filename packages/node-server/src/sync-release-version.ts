import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

interface ExtensionManifest {
  version: string;
  [key: string]: unknown;
}

interface VfsRootVersionFile {
  version: string;
  releasedAt: string | null;
}

export function updateManifestVersionContents(contents: string, version: string): string {
  const manifest = JSON.parse(contents) as Partial<ExtensionManifest>;

  if (typeof manifest.version !== 'string') {
    throw new Error(
      'manifest.json must contain a string version before semantic-release can update it.'
    );
  }

  manifest.version = version;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function writeManifestVersion(manifestPath: string, version: string): void {
  writeFileSync(
    manifestPath,
    updateManifestVersionContents(readFileSync(manifestPath, 'utf8'), version)
  );
}

export function buildVfsRootVersionContents(version: string, releasedAt: string): string {
  const payload: VfsRootVersionFile = { version, releasedAt };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function writeVfsRootVersion(
  versionFilePath: string,
  version: string,
  releasedAt: string
): void {
  writeFileSync(versionFilePath, buildVfsRootVersionContents(version, releasedAt));
}

function main(): void {
  const version = process.argv[2];

  if (!version) {
    throw new Error('Usage: node dist/node-server/sync-release-version.js <version>');
  }

  writeManifestVersion(resolve(PROJECT_ROOT, 'packages/chrome-extension/manifest.json'), version);
  console.log(`Updated manifest.json version to ${version}`);

  const releasedAt = new Date().toISOString();
  writeVfsRootVersion(
    resolve(PROJECT_ROOT, 'packages/vfs-root/shared/version.json'),
    version,
    releasedAt
  );
  console.log(`Updated vfs-root/shared/version.json to ${version} (releasedAt=${releasedAt})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[sync-release-version] ${message}`);
    process.exit(1);
  }
}
