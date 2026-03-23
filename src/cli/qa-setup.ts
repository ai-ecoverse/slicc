import { existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  CLI_PROFILE_NAMES,
  ensureQaProfileScaffold,
  findChromeExecutable,
  resolveQaProfilesRoot,
} from './chrome-launch.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');

async function main(): Promise<void> {
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    console.error('Could not find Chrome or Chrome for Testing. Set CHROME_PATH and retry.');
    process.exit(1);
  }

  const extensionPath = resolve(projectRoot, 'dist', 'extension');
  if (!existsSync(extensionPath)) {
    console.error('dist/extension was not found. Run `npm run build:extension` first.');
    process.exit(1);
  }

  const profiles = await ensureQaProfileScaffold(projectRoot);
  console.log('SLICC QA profiles are ready.');
  console.log(`Chrome executable: ${chromePath}`);
  console.log(`QA profile root: ${resolveQaProfilesRoot(projectRoot)}`);
  console.log(`Extension build: ${extensionPath}`);
  console.log('Profiles:');
  for (const profile of profiles) {
    const extensionLabel = profile.extensionPath ? ' (auto-loads dist/extension)' : '';
    console.log(`- ${profile.id}: ${profile.userDataDir}${extensionLabel}`);
  }
  console.log('Next commands:');
  for (const profileName of CLI_PROFILE_NAMES) {
    console.log(`- npm run qa:${profileName}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
