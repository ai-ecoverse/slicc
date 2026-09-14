const WC_SRC_PREFIX = 'packages/webcomponents/src/';
const STORY_SUFFIX = '.stories.ts';

export const GLOBAL_AREAS = new Set(['theme', 'internal']);

export function classifyChangedFile(repoRelPath) {
  if (typeof repoRelPath !== 'string') return null;
  if (!repoRelPath.startsWith(WC_SRC_PREFIX)) return null;
  const rest = repoRelPath.slice(WC_SRC_PREFIX.length);
  const slash = rest.indexOf('/');

  if (slash <= 0) return null;
  const area = rest.slice(0, slash);
  return {
    area,
    isStoryFile: repoRelPath.endsWith(STORY_SUFFIX),
    importPath: `./src/${rest}`,
  };
}

function areaFromImportPath(importPath) {
  if (typeof importPath !== 'string') return null;
  const prefix = './src/';
  if (!importPath.startsWith(prefix)) return null;
  const rest = importPath.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  return rest.slice(0, slash);
}

export function resolveAffectedStories(changedFiles, indexJson) {
  const entries = Object.values(indexJson?.entries ?? {}).filter(
    (e) => (e?.type ?? 'story') === 'story' && typeof e?.importPath === 'string'
  );

  const picked = new Map();

  for (const raw of changedFiles ?? []) {
    const info = classifyChangedFile(raw);
    if (info == null) continue;
    const { area, isStoryFile, importPath } = info;
    const areaPrefix = `./src/${area}/`;

    const isGlobalChange = !isStoryFile && GLOBAL_AREAS.has(area);

    for (const entry of entries) {
      if (isGlobalChange) {
      } else {
        const matchesArea = entry.importPath.startsWith(areaPrefix);
        if (!matchesArea) continue;

        if (isStoryFile && entry.importPath !== importPath) continue;
      }

      const entryArea = areaFromImportPath(entry.importPath) ?? area;
      const existing = picked.get(entry.id);
      if (existing) {
        existing.triggers.add(raw);
      } else {
        picked.set(entry.id, { entry, area: entryArea, triggers: new Set([raw]) });
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

export function screenshotFileName(storyId, theme) {
  return `${storyId}-${theme}.png`;
}
