/**
 * upskill — public barrel.
 *
 * Re-exports the command factories and the symbols imported by external
 * consumers (`almost-bash-shell-headless.ts`, `playwright/discover.ts`, and the
 * upskill/playwright tests). This is the single entry point for the upskill
 * subsystem; the responsibility-organized modules live alongside it.
 */

export { scoreSkills } from './catalog/catalog.js';
export { _resetGlobalFsCache } from './github/github-auth.js';
export { parseGitHubRef } from './github/github-install.js';
export { type InstallRecommendationsResult, installRecommendedSkills } from './recommendations.js';
export {
  _resetBrowseShCatalogCache,
  fetchBrowseShCatalog,
  normalizeHostname,
  parseBrowseShRef,
} from './registries/browse-sh.js';
export { createSkillCommand } from './skill-command.js';
export type {
  BrowseShSkillSummary,
  TabCatalogMatch,
  TabUpskillLink,
  TabUpskillResult,
} from './types.js';
export { createUpskillCommand } from './upskill-command.js';
