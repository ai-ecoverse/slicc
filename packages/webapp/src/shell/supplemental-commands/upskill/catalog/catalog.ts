import { slugify } from '@slicc/shared-ts';
import type { VirtualFS } from '../../../../fs/index.js';
import type {
  CatalogSkill,
  CatalogSkillSource,
  RemoteCatalogRow,
  ScoredSkill,
  UserProfile,
} from '../types.js';
import { SKILLS_DIR } from '../types.js';

export function splitField(value: string): string[] | undefined {
  if (!value?.trim()) return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseInstallAll(raw: string | undefined): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

export function parseRemoteCatalog(data: RemoteCatalogRow[]): CatalogSkill[] {
  return data.map((row) => {
    const boost = row.boost ? parseFloat(row.boost) : NaN;
    const priority = Number.isFinite(boost) ? boost : undefined;

    return {
      name: row.name,
      displayName: row.displayName || row.name,
      description: row.description || '',
      source: {
        repo: row.repo,
        path: row.path || undefined,
        skill: row.skill || undefined,
        installAll: parseInstallAll(row.installAll),
      },
      affinity: {
        apps: splitField(row.apps),
        tasks: splitField(row.tasks),
        role: splitField(row.role),
        purpose: splitField(row.purpose),
      },
      priority,
    };
  });
}

const AFFINITY_WEIGHTS = { apps: 3, tasks: 2, role: 1, purpose: 1 };

export function scoreSkills(catalog: CatalogSkill[], profile: UserProfile): ScoredSkill[] {
  return catalog
    .map((entry) => {
      let score = 0;
      const reasons: string[] = [];

      const appMatches = (entry.affinity.apps ?? []).filter((a) => profile.apps.includes(a));
      if (appMatches.length) {
        score += appMatches.length * AFFINITY_WEIGHTS.apps;
        reasons.push(`apps(${appMatches.join(', ')})`);
      }

      const taskMatches = (entry.affinity.tasks ?? []).filter((t) => profile.tasks.includes(t));
      if (taskMatches.length) {
        score += taskMatches.length * AFFINITY_WEIGHTS.tasks;
        reasons.push(`tasks(${taskMatches.join(', ')})`);
      }

      if ((entry.affinity.role ?? []).includes(profile.role)) {
        score += AFFINITY_WEIGHTS.role;
        reasons.push(`role(${profile.role})`);
      }

      if ((entry.affinity.purpose ?? []).includes(profile.purpose)) {
        score += AFFINITY_WEIGHTS.purpose;
        reasons.push(`purpose(${profile.purpose})`);
      }

      score *= entry.priority ?? 1.0;

      return { entry, score, matchReasons: reasons };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function buildInstallCmd(source: CatalogSkillSource): string {
  let cmd = `upskill ${source.repo}`;
  if (source.path) cmd += ` --path ${source.path}`;
  if (source.installAll) cmd += ` --all`;
  else if (source.skill) cmd += ` --skill ${source.skill}`;
  return cmd;
}

export async function getInstalledSkillNames(fs: VirtualFS): Promise<Set<string>> {
  const names = new Set<string>();

  try {
    const entries = await fs.readDir(SKILLS_DIR);
    for (const e of entries) {
      if (e.type === 'directory') names.add(e.name);
    }
  } catch {}

  const COMPAT_DIRS = ['.agents', '.claude'] as const;
  try {
    const topLevel = await fs.readDir('/');
    for (const dir of topLevel) {
      if (dir.type !== 'directory') continue;
      for (const compatDir of COMPAT_DIRS) {
        try {
          const skillsRoot = `/${dir.name}/${compatDir}/skills`;
          const skillEntries = await fs.readDir(skillsRoot);
          for (const se of skillEntries) {
            if (se.type === 'directory') names.add(se.name);
          }
        } catch {}
      }
    }
  } catch {}
  return names;
}

export function normalizeProfile(profile: Partial<UserProfile>): UserProfile {
  return {
    purpose: profile.purpose ?? '',
    role: profile.role ?? '',
    tasks: Array.isArray(profile.tasks) ? profile.tasks : [],
    apps: Array.isArray(profile.apps) ? profile.apps : [],
    name: profile.name ?? '',
    company: typeof profile.company === 'string' ? profile.company : undefined,
  };
}

export function slugifyCompany(company: unknown): string | null {
  if (typeof company !== 'string' || !company) return null;
  return slugify(company) || null;
}

export function mergeCatalogs(base: CatalogSkill[], company: CatalogSkill[]): CatalogSkill[] {
  if (company.length === 0) return base;
  const companyNames = new Set(company.map((s) => s.name));
  return [...base.filter((s) => !companyNames.has(s.name)), ...company];
}
