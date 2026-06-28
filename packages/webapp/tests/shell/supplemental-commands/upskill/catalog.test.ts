import { describe, expect, it } from 'vitest';
import { scoreSkills } from '../../../../src/shell/supplemental-commands/upskill/index.js';

describe('scoreSkills', () => {
  const catalog = [
    {
      name: 'aem',
      displayName: 'AEM',
      description: 'AEM skill',
      source: { repo: 'adobe/skills', path: 'skills/aem', skill: 'aem' },
      affinity: {
        apps: ['aem'],
        tasks: ['build-websites', 'seo'],
        role: ['developer'],
        purpose: ['work'],
      },
    },
    {
      name: 'bluebubbles',
      displayName: 'BlueBubbles',
      description: 'iMessage',
      source: { repo: 'ai-ecoverse/skills', skill: 'bluebubbles' },
      affinity: { apps: ['imessage'], purpose: ['personal'] },
    },
    {
      name: 'skill-creator',
      displayName: 'Skill Creator',
      description: 'Create skills',
      source: { repo: 'anthropics/skills', skill: 'skill-creator' },
      affinity: { role: ['developer'], purpose: ['work', 'side-project'] },
      priority: 0.8,
    },
    {
      name: 'xlsx',
      displayName: 'XLSX',
      description: 'Spreadsheets',
      source: { repo: 'anthropics/skills', skill: 'xlsx' },
      affinity: { tasks: ['extract-data'], role: ['researcher'] },
    },
  ];

  it('scores skills by affinity weights (apps=3, tasks=2, role=1, purpose=1)', () => {
    const profile = {
      purpose: 'work',
      role: 'developer',
      tasks: ['build-websites'],
      apps: ['aem'],
      name: 'Test',
    };
    const scored = scoreSkills(catalog, profile);

    // AEM: apps(aem)=3 + tasks(build-websites)=2 + role(developer)=1 + purpose(work)=1 = 7
    expect(scored[0].entry.name).toBe('aem');
    expect(scored[0].score).toBe(7);
    expect(scored[0].matchReasons).toContain('apps(aem)');
  });

  it('applies priority multiplier', () => {
    const profile = { purpose: 'work', role: 'developer', tasks: [], apps: [], name: 'Test' };
    const scored = scoreSkills(catalog, profile);

    const skillCreator = scored.find((s) => s.entry.name === 'skill-creator');
    // role(developer)=1 + purpose(work)=1 = 2, * 0.8 priority = 1.6
    expect(skillCreator).toBeDefined();
    expect(skillCreator!.score).toBeCloseTo(1.6);
  });

  it('excludes skills with zero score', () => {
    const profile = {
      purpose: 'school',
      role: 'student',
      tasks: ['research'],
      apps: [],
      name: 'Test',
    };
    const scored = scoreSkills(catalog, profile);

    // AEM and bluebubbles should not match
    expect(scored.find((s) => s.entry.name === 'aem')).toBeUndefined();
    expect(scored.find((s) => s.entry.name === 'bluebubbles')).toBeUndefined();
  });

  it('sorts by score descending', () => {
    const profile = {
      purpose: 'work',
      role: 'developer',
      tasks: ['build-websites', 'extract-data'],
      apps: ['aem'],
      name: 'Test',
    };
    const scored = scoreSkills(catalog, profile);

    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1].score).toBeGreaterThanOrEqual(scored[i].score);
    }
  });

  it('returns empty array when no skills match', () => {
    const profile = { purpose: 'school', role: 'student', tasks: [], apps: [], name: 'Test' };
    const scored = scoreSkills(catalog, profile);
    expect(scored).toHaveLength(0);
  });
});
