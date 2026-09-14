import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishChromeWebStoreRelease } from './publish-chrome-web-store.js';

const dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = resolve(dirname, '..', '..');
const manifestPath = process.argv[2]
  ? resolve(projectRoot, process.argv[2])
  : resolve(projectRoot, 'artifacts', 'release', 'release-artifacts.json');

void publishChromeWebStoreRelease({ manifestPath }).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[publish-chrome-web-store] ${message}`);
  process.exit(1);
});
