import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

interface ExtensionManifest {
  version: string;
  [key: string]: unknown;
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

function main(): void {
  const version = process.argv[2];

  if (!version) {
    throw new Error('Usage: node dist/node-server/sync-release-version.js <version>');
  }

  writeManifestVersion(resolve(PROJECT_ROOT, 'packages/chrome-extension/manifest.json'), version);
  console.log(`Updated manifest.json version to ${version}`);
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
