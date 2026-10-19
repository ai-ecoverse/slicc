import type { ProfileExportDeps } from './profile-export.js';

let current: (() => ProfileExportDeps) | null = null;

export function registerProfileExportDeps(factory: () => ProfileExportDeps): () => void {
  current = factory;
  return () => {
    if (current === factory) current = null;
  };
}

export function getProfileExportDeps(): ProfileExportDeps {
  if (!current) throw new Error('Export for SLICC 7 is only available in the SLICC 6 leader tab.');
  return current();
}

export interface ProfileExportRunResult {
  report: string;
  archives: string[];
}

export type ProfileExportRunner = (opts: { dryRun: boolean }) => Promise<ProfileExportRunResult>;

let runner: ProfileExportRunner | null = null;

export function registerProfileExportRunner(run: ProfileExportRunner): () => void {
  runner = run;
  return () => {
    if (runner === run) runner = null;
  };
}

export function getProfileExportRunner(): ProfileExportRunner | null {
  return runner;
}
