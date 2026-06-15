/*
 * Affected-story resolver for the Storybook screenshot-on-PR workflow (Spec).
 *
 * Pure logic — no I/O. The capture script (storybook-affected-screenshots.mjs)
 * and the CI workflow (Task 2) read a built Storybook `index.json` plus a list
 * of changed files, then ask `resolveAffectedStories()` which stories to
 * screenshot.
 *
 * Heuristic (directory-level — decided in the task note):
 *   - A changed `*.stories.ts` selects only the stories declared in that file
 *     (matched by Storybook's `importPath`).
 *   - Any other changed file under `packages/webcomponents/src/<area>/` selects
 *     ALL stories whose `importPath` lives anywhere under that `<area>`.
 *   - Changed files outside `packages/webcomponents/src/<area>/` (no area
 *     subdirectory, or outside the package) contribute nothing.
 *
 * The output is deterministic (sorted by storyId) and carries `triggeredBy` so
 * the PR-comment builder in Task 2 can show reviewers WHY each story was shot.
 */

/** Storybook 10 stores stories at `<configRoot>/src/<area>/...`; importPath is repo-relative-to-package, leading `./`. */
const WC_SRC_PREFIX = 'packages/webcomponents/src/';
const STORY_SUFFIX = '.stories.ts';

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   name: string,
 *   importPath: string,
 *   type?: 'story' | 'docs',
 * }} StoryEntry
 *
 * @typedef {{ v: number, entries: Record<string, StoryEntry> }} StoryIndex
 *
 * @typedef {{
 *   storyId: string,
 *   title: string,
 *   name: string,
 *   area: string,
 *   importPath: string,
 *   triggeredBy: string[],
 * }} AffectedStory
 */

/**
 * Parse a repo-relative path into `{ area, isStoryFile, importPath }` if it
 * lives under `packages/webcomponents/src/<area>/...`; otherwise `null`.
 *
 * `importPath` is the Storybook-style path you'd match against `index.json`
 * entries (relative to the Storybook config root, which IS the package root),
 * e.g. `./src/pill/slicc-pill.stories.ts`.
 */
export function classifyChangedFile(repoRelPath) {
  if (typeof repoRelPath !== 'string') return null;
  if (!repoRelPath.startsWith(WC_SRC_PREFIX)) return null;
  const rest = repoRelPath.slice(WC_SRC_PREFIX.length);
  const slash = rest.indexOf('/');
  // Files directly under src/ (e.g. src/index.ts) have no area — skip.
  if (slash <= 0) return null;
  const area = rest.slice(0, slash);
  return {
    area,
    isStoryFile: repoRelPath.endsWith(STORY_SUFFIX),
    importPath: `./src/${rest}`,
  };
}

/**
 * Resolve the set of Storybook stories affected by `changedFiles`.
 *
 * @param {string[]} changedFiles - Paths relative to the repo root.
 * @param {StoryIndex} indexJson  - The contents of `storybook-static/index.json`.
 * @returns {AffectedStory[]}     - Stable-sorted by `storyId`; only `type==='story'` entries.
 */
export function resolveAffectedStories(changedFiles, indexJson) {
  const entries = Object.values(indexJson?.entries ?? {}).filter(
    (e) => (e?.type ?? 'story') === 'story' && typeof e?.importPath === 'string'
  );

  // For each affected story we accumulate the changed-file paths that
  // triggered it (deduped, original repo-relative form) so the PR comment can
  // explain its selection.
  /** @type {Map<string, { entry: StoryEntry, area: string, triggers: Set<string> }>} */
  const picked = new Map();

  for (const raw of changedFiles ?? []) {
    const info = classifyChangedFile(raw);
    if (info == null) continue;
    const { area, isStoryFile, importPath } = info;
    const areaPrefix = `./src/${area}/`;

    for (const entry of entries) {
      const matchesArea = entry.importPath.startsWith(areaPrefix);
      if (!matchesArea) continue;
      // A changed *.stories.ts narrows to that exact stories file; any other
      // changed source file under the area selects every story in the area.
      if (isStoryFile && entry.importPath !== importPath) continue;

      const existing = picked.get(entry.id);
      if (existing) {
        existing.triggers.add(raw);
      } else {
        picked.set(entry.id, { entry, area, triggers: new Set([raw]) });
      }
    }
  }

  return [...picked.values()]
    .map(({ entry, area, triggers }) => ({
      storyId: entry.id,
      title: entry.title,
      name: entry.name,
      area,
      importPath: entry.importPath,
      triggeredBy: [...triggers].sort(),
    }))
    .sort((a, b) => (a.storyId < b.storyId ? -1 : a.storyId > b.storyId ? 1 : 0));
}

/**
 * Filename used for a captured screenshot. Story IDs are already
 * filesystem-safe ([a-z0-9-]) per Storybook's slugger, so we just append the
 * theme. The capture script and Task 2 share this so the manifest's `file`
 * field stays in sync with what gets uploaded.
 */
export function screenshotFileName(storyId, theme) {
  return `${storyId}-${theme}.png`;
}
