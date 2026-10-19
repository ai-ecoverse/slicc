/**
 * Realm-local registry for the SLICC 7 profile exporter's dependencies.
 * The leader page registers them at boot (`wc-live.ts`); the Settings entry,
 * the banner and the `export-profile` command read them here. Only the page
 * registers: the kernel worker reaches it over panel RPC (`profile-export`).
 */

import type { ProfileExportDeps } from './profile-export.js';

let current: (() => ProfileExportDeps) | null = null;

/** Register the factory; the returned teardown clears only this registration. */
export function registerProfileExportDeps(factory: () => ProfileExportDeps): () => void {
  current = factory;
  return () => {
    if (current === factory) current = null;
  };
}

/** The registered dependencies. Throws when this realm has none. */
export function getProfileExportDeps(): ProfileExportDeps {
  if (!current) throw new Error('Export for SLICC 7 is only available in the SLICC 6 leader tab.');
  return current();
}

/** What `export-profile` gets back: the printed report and the zip names. */
export interface ProfileExportRunResult {
  report: string;
  archives: string[];
}

export type ProfileExportRunner = (opts: { dryRun: boolean }) => Promise<ProfileExportRunResult>;

let runner: ProfileExportRunner | null = null;

/** The page registers the headless run (plan, save to Downloads, report). */
export function registerProfileExportRunner(run: ProfileExportRunner): () => void {
  runner = run;
  return () => {
    if (runner === run) runner = null;
  };
}

/** This realm's runner, or null (the kernel worker goes through panel RPC). */
export function getProfileExportRunner(): ProfileExportRunner | null {
  return runner;
}
