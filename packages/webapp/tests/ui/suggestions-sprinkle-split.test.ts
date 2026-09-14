import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

const read = (relPath: string): string => readFileSync(resolve(repoRoot, relPath), 'utf8');

const SUGGESTIONS_VFS_PATH = '/shared/sprinkles/suggestions/suggestions.shtml';

const suggestionsShtml = read('packages/vfs-root/shared/sprinkles/suggestions/suggestions.shtml');
const welcomeShtml = read('packages/vfs-root/shared/sprinkles/welcome/welcome.shtml');
const gelatiereSkill = read('packages/vfs-root/workspace/skills/gelatiere/SKILL.md');
const skillsSource = read('packages/webapp/src/scoops/skills.ts');
const followerSource = read('packages/webapp/src/ui/wc/wc-follower.ts');

describe('suggestions.shtml — the stream, standalone', () => {
  it('reads the store and carries the three card licks', () => {
    expect(suggestionsShtml).toContain("'/shared/.gelatiere/suggestions.json'");
    expect(suggestionsShtml).toContain("action: 'gelatiere-dismiss'");
    expect(suggestionsShtml).toContain("action: 'gelatiere-install'");
    expect(suggestionsShtml).toContain("action: 'gelatiere-try'");

    expect(suggestionsShtml).toContain('renderGelatiereStream();');
  });

  it('has no onboarding in it — a follower rendering it can never see a wizard', () => {
    expect(suggestionsShtml).not.toContain('startWizard');
    expect(suggestionsShtml).not.toContain('/shared/.welcomed');
    expect(suggestionsShtml).not.toContain('onboarding-complete');
  });

  it('wears the gelatiere cone as its rail glyph', () => {
    expect(suggestionsShtml).toContain('<link rel="icon" href="ice-cream-cone" />');
  });
});

describe('welcome.shtml — onboarding only', () => {
  it('still drives the wizard off the welcomed marker', () => {
    expect(welcomeShtml).toContain('startWizard');
    expect(welcomeShtml).toContain("slicc.exists('/shared/.welcomed')");
  });

  it('carries none of the stream — no store read, no cards, no stream mount', () => {
    expect(welcomeShtml).not.toContain('gelatiereStream');
    expect(welcomeShtml).not.toContain('/shared/.gelatiere/suggestions.json');
    expect(welcomeShtml).not.toContain('gelatiere-install');
  });
});

describe('the four namers of the stream path agree', () => {
  it('the gelatiere skill has cones post the stream dip at the real file', () => {
    expect(gelatiereSkill).toContain(`![Suggestions](${SUGGESTIONS_VFS_PATH})`);

    expect(gelatiereSkill).not.toContain('/shared/sprinkles/welcome/welcome.shtml');
  });

  it('the boot re-seed list keeps the bundled stream current like the other system dips', () => {
    expect(skillsSource).toContain(`'${SUGGESTIONS_VFS_PATH}',`);
  });

  it("the follower's drop prefix covers the stream dip and nothing of welcome's", () => {
    expect(followerSource).toContain(
      "const SUGGESTIONS_DIP_SRC_PREFIX = '/shared/sprinkles/suggestions/';"
    );
    expect(SUGGESTIONS_VFS_PATH.startsWith('/shared/sprinkles/suggestions/')).toBe(true);

    expect(SUGGESTIONS_VFS_PATH.startsWith('/shared/sprinkles/welcome/')).toBe(false);
  });
});
