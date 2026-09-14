import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageReleaseArtifacts, toProjectRelative } from './release-package.js';

const dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = resolve(dirname, '..', '..');
const releaseDir = resolve(projectRoot, 'artifacts', 'release');

try {
  const manifest = packageReleaseArtifacts({ projectRoot, releaseDir });
  console.log(`Created extension archive: ${manifest.extensionArchive}`);
  console.log(`Created npm package tarball: ${manifest.npmPackageTarball}`);
  console.log(
    `Created release manifest: ${toProjectRelative(projectRoot, resolve(releaseDir, 'release-artifacts.json'))}`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[package:release] ${message}`);
  process.exit(1);
}
