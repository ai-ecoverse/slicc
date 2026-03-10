/**
 * Manifest parsing and validation
 */

import type { VirtualFS } from '../fs/index.js';
import type { SkillManifest } from './types.js';
import { MANIFEST_FILE } from './constants.js';

/**
 * Parse YAML content into a SkillManifest.
 * Simple YAML parser - handles basic key: value and arrays.
 */
function parseYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');
  let currentKey = '';
  let currentArray: string[] | null = null;
  let inStructured = false;
  let structuredObj: Record<string, unknown> = {};
  let structuredKey = '';
  let structuredArray: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Check for array item
    if (trimmed.startsWith('- ')) {
      const value = trimmed.slice(2).trim();
      if (inStructured && structuredArray) {
        structuredArray.push(value);
      } else if (currentArray) {
        currentArray.push(value);
      }
      continue;
    }

    // Check for key: value
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    // Handle indentation for structured section
    const indent = line.search(/\S/);

    if (key === 'structured') {
      inStructured = true;
      structuredObj = {};
      result.structured = structuredObj;
      continue;
    }

    if (inStructured && indent >= 2) {
      if (indent >= 4 && structuredArray) {
        // This is an array item without dash (shouldn't happen in our format)
        continue;
      }
      if (value === '' || value === '[]') {
        structuredKey = key;
        structuredArray = [];
        structuredObj[key] = structuredArray;
      } else {
        structuredObj[key] = value;
        structuredArray = null;
      }
      continue;
    }

    if (indent === 0) {
      inStructured = false;
    }

    // Top-level key
    if (value === '' || value === '[]') {
      currentKey = key;
      currentArray = [];
      result[key] = currentArray;
    } else {
      result[key] = value;
      currentArray = null;
    }
  }

  return result;
}

/**
 * Parse manifest YAML content and validate required fields.
 */
export function parseManifestContent(
  content: string,
  manifestPath: string = MANIFEST_FILE,
): SkillManifest {
  const parsed = parseYaml(content);

  if (!parsed.skill || typeof parsed.skill !== 'string') {
    throw new Error(`Invalid manifest: missing 'skill' field in ${manifestPath}`);
  }
  if (!parsed.version || typeof parsed.version !== 'string') {
    throw new Error(`Invalid manifest: missing 'version' field in ${manifestPath}`);
  }

  return {
    skill: parsed.skill as string,
    version: parsed.version as string,
    description: (parsed.description as string) || '',
    adds: (parsed.adds as string[]) || [],
    modifies: (parsed.modifies as string[]) || [],
    structured: parsed.structured as SkillManifest['structured'],
    conflicts: (parsed.conflicts as string[]) || [],
    depends: (parsed.depends as string[]) || [],
    test: parsed.test as string | undefined,
    author: parsed.author as string | undefined,
  };
}

/**
 * Read and parse a skill manifest from the virtual filesystem.
 */
export async function readManifest(
  fs: VirtualFS,
  skillDir: string,
): Promise<SkillManifest> {
  const manifestPath = `${skillDir}/${MANIFEST_FILE}`;
  const content = await fs.readTextFile(manifestPath);
  return parseManifestContent(content, manifestPath);
}

/**
 * Check if a skill's dependencies are satisfied.
 */
export function checkDependencies(
  manifest: SkillManifest,
  appliedSkills: string[],
): { ok: boolean; missing: string[] } {
  const missing = (manifest.depends || []).filter(
    (dep) => !appliedSkills.includes(dep),
  );
  return { ok: missing.length === 0, missing };
}

/**
 * Check if a skill conflicts with any installed skills.
 */
export function checkConflicts(
  manifest: SkillManifest,
  appliedSkills: string[],
): { ok: boolean; conflicting: string[] } {
  const conflicting = (manifest.conflicts || []).filter((c) =>
    appliedSkills.includes(c),
  );
  return { ok: conflicting.length === 0, conflicting };
}
