export const CLAUDE_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const;

export type ClaudeFamily = (typeof CLAUDE_FAMILIES)[number];

export interface ClaudeVersion {
  family: ClaudeFamily;
  major: number;
  minor: number;
}

function matchCandidates(modelId: string, modelName?: string): string[] {
  const values = modelName ? [modelId, modelName] : [modelId];
  return values.flatMap((value) => {
    const lower = value.toLowerCase();
    return [lower, lower.replace(/[\s_.:]+/g, '-')];
  });
}

const CLAUDE_VERSION_RE = new RegExp(
  `(${CLAUDE_FAMILIES.join('|')})-(\\d{1,2})(?:-(\\d{1,2}))?(?!\\d)`
);

export function parseClaudeVersion(modelId: string, modelName?: string): ClaudeVersion | null {
  for (const candidate of matchCandidates(modelId, modelName)) {
    const m = candidate.match(CLAUDE_VERSION_RE);
    if (m) {
      return {
        family: m[1] as ClaudeFamily,
        major: Number(m[2]),
        minor: m[3] !== undefined ? Number(m[3]) : 0,
      };
    }
  }
  return null;
}

const SAME_CLAUDE_MODEL_RE = new RegExp(
  `^(?:(?:us|eu|global|apac|au|jp)\\.)?(?:anthropic[./])?` +
    `claude-(${CLAUDE_FAMILIES.join('|')})-(\\d{1,2})(?:-(\\d{1,2}))?` +
    `(?:-\\d{8}-v\\d+(?::\\d+)?)?$`,
  'i'
);

export function canonicalModelId(modelId: string): string {
  const match = SAME_CLAUDE_MODEL_RE.exec(modelId);
  if (!match) return modelId;
  const family = (match[1] ?? '').toLowerCase();
  const major = match[2] ?? '';
  const minor = match[3];
  const base = `claude-${family}-${major}`;
  return minor === undefined || minor === '0' ? base : `${base}-${minor}`;
}

export function representativeModelId(ids: readonly string[], preferred?: string): string {
  if (ids.length === 0) return preferred ?? '';
  const key = canonicalModelId(ids[0] ?? '');
  if (preferred && canonicalModelId(preferred) === key) return preferred;
  if (ids.includes(key)) return key;
  return ids.reduce((best, id) =>
    id.length < best.length || (id.length === best.length && id < best) ? id : best
  );
}

function compareVersion(
  a: { major: number; minor: number },
  b: { major: number; minor: number }
): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  return 0;
}

export function claudeSupportsAdaptiveThinking(modelId: string, modelName?: string): boolean {
  const v = parseClaudeVersion(modelId, modelName);
  if (!v) return false;
  if (v.family === 'haiku') return false;
  return compareVersion(v, { major: 4, minor: 6 }) >= 0;
}

export function claudeSupportsNativeXhighEffort(modelId: string, modelName?: string): boolean {
  const v = parseClaudeVersion(modelId, modelName);
  if (!v) return false;
  if (v.family === 'opus') return compareVersion(v, { major: 4, minor: 7 }) >= 0;
  if (v.family === 'sonnet') return compareVersion(v, { major: 5, minor: 0 }) >= 0;
  if (v.family === 'fable') return compareVersion(v, { major: 5, minor: 0 }) >= 0;
  return false;
}

export function claudeSupportsMaxEffort(modelId: string, modelName?: string): boolean {
  const v = parseClaudeVersion(modelId, modelName);
  if (!v) return false;
  if (v.family === 'opus') return v.major === 4 && v.minor === 6;
  if (v.family === 'sonnet') return v.major === 4 && v.minor === 6;
  return false;
}

export function claudeSupportsPromptCaching(modelId: string, modelName?: string): boolean {
  const v = parseClaudeVersion(modelId, modelName);
  if (v) return v.major >= 4;
  return matchCandidates(modelId, modelName).some(
    (s) => s.includes('claude-3-7-sonnet') || s.includes('claude-3-5-haiku')
  );
}

export function claudeRejectsTemperature(modelId: string, modelName?: string): boolean {
  const v = parseClaudeVersion(modelId, modelName);
  if (!v) return false;
  if (v.family === 'opus') return compareVersion(v, { major: 4, minor: 7 }) >= 0;
  if (v.family === 'sonnet') return compareVersion(v, { major: 5, minor: 0 }) >= 0;
  if (v.family === 'fable') return true;
  return false;
}
