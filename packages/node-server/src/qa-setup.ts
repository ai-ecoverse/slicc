import { resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  CLI_PROFILE_NAMES,
  ensureQaProfileScaffold,
  findChromeExecutable,
  resolveQaProfilesRoot,
} from './chrome-launch.js';

const Dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = resolve(Dirname, '..', '..');

async function main(): Promise<void> {
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    console.error('Could not find Chrome or Chrome for Testing. Set CHROME_PATH and retry.');
    process.exit(1);
  }

  const profiles = await ensureQaProfileScaffold(projectRoot);
  console.log('SLICC QA profiles are ready.');
  console.log(`Chrome executable: ${chromePath}`);
  console.log(`QA profile root: ${resolveQaProfilesRoot(projectRoot)}`);
  console.log('Profiles:');
  for (const profile of profiles) {
    console.log(`- ${profile.id}: ${profile.userDataDir}`);
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
