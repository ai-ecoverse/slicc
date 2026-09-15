/**
 * Pins the gelatiere stream ↔ onboarding split (PR #3005 Track C, Grok #4).
 *
 * The stream used to live INSIDE `welcome.shtml`, which made it hostage to
 * every surface that special-cases onboarding: follower floats restarted the
 * wizard (`exists()` hard-coded false in the follower sprinkle bridge), and
 * the extension side panel swapped everything under the welcome src prefix
 * for a "Set up SLICC" hand-off card — masking the stream forever. These
 * tests read the ACTUAL bundled files and wiring so a refactor cannot
 * silently fold the two back together, and so the four places that name the
 * stream's path (the sprinkle file, the skill that tells cones to post it,
 * the boot-time re-seed list, and the follower's drop prefix) cannot drift
 * apart.
 */
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
    // Boots straight into the stream — no marker probe, no wizard fallback.
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

  // The stream fills a panel iframe edge to edge and neither host
  // (`.sprinkle-panel`, `.msg__dip`) adds padding, so the gutter is the
  // sprinkle's own job — without it the cards sit flush in the panel's
  // rounded corner. The `*` reset at the top is what makes it necessary.
  it('owns its gutter — body carries the padding the hosts do not', () => {
    expect(suggestionsShtml).toContain('* { box-sizing: border-box; margin: 0; padding: 0; }');
    const body = suggestionsShtml.match(/\n {6}body \{([^}]*)\}/);
    expect(body?.[1]).toMatch(/padding:\s*\d+px \d+px \d+px;/);
    // The entries draw no horizontal padding of their own, so the hairline
    // separators run the full width of the list.
    expect(suggestionsShtml).toContain('.gelatiere-entry { padding: 18px 0; }');
  });

  // The empty state is the first thing most users see here: before the first
  // pass there is nothing to render, and a bare "nothing yet" reads like a
  // broken panel.
  it('answers an empty store with what will land here, and three ways in meanwhile', () => {
    expect(suggestionsShtml).toContain("var EMPTY_HEADLINE = 'Nothing here yet';");
    expect(suggestionsShtml).toContain('Check back after your next session.');
    // The use cases come from the command's pinned-host fetch, never from
    // egress of the sprinkle's own.
    expect(suggestionsShtml).toContain(
      "var USE_CASE_COMMAND = 'gelatiere use-cases --limit 3 --json';"
    );
    expect(suggestionsShtml).toContain('Meanwhile, from sliccy.com');
    // Appended after the copy, so a site that will not answer costs nothing.
    expect(suggestionsShtml).toContain('appendUseCases(stream)');
    expect(suggestionsShtml).not.toContain('www.sliccy.com/sitemap.xml');
  });

  // Lucide REPLACES `<i data-lucide>` with an `<svg width="24" height="24">`,
  // so an `i`-only size rule stops matching the moment the icons render and
  // every glyph falls back to 24px.
  it('sizes icons through :is(i, svg), never `i` alone', () => {
    const iconRules = [
      ...suggestionsShtml.matchAll(/^ *\.gelatiere-[\w-]+ (.+?) \{[^}]*height: \d+px/gm),
    ];
    expect(iconRules.length).toBeGreaterThan(0);
    for (const rule of iconRules) expect(rule[1]).toBe(':is(i, svg)');
  });

  it('gives the two prompt-carrying kinds their own label and pill', () => {
    for (const [kind, label, action] of [
      ['skill-idea', 'New skill', 'Draft it'],
      ['issue', 'Report', 'Report it'],
    ]) {
      const row = suggestionsShtml.match(new RegExp(`'${kind}':.*`));
      expect(row?.[0], kind).toContain(`'${label}'`);
      expect(row?.[0], kind).toContain(`'${action}'`);
    }
    // Both ride the existing `gelatiere-try` lick — no new verb to settle.
    expect(suggestionsShtml).not.toContain('gelatiere-draft');
    expect(suggestionsShtml).not.toContain('gelatiere-report');
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

describe('the suggestion kinds agree across store, recipe and card', () => {
  const storeSource = read('packages/webapp/src/base/gelatiere-store.ts');
  const gelatiereMd = read('packages/vfs-root/shared/GELATIERE.md');

  it('every kind the store accepts is documented and renderable', () => {
    const declared = storeSource.match(/export type GelatiereSuggestionKind = ([^;]+);/)?.[1] ?? '';
    const kinds = [...declared.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    expect(kinds).toEqual(['skill', 'use-case', 'tip', 'skill-idea', 'issue']);
    for (const kind of kinds) {
      // The card must know how to draw it, and the recipe must say when to
      // write it — a kind the store accepts but neither renders nor teaches
      // is a suggestion the user never sees.
      expect(suggestionsShtml, kind).toContain(`'${kind}':`);
      expect(gelatiereMd, kind).toContain(`\`${kind}\``);
    }
  });

  it('the recipe sends skill-idea and issue somewhere a cone can act', () => {
    expect(gelatiereMd).toContain('ai-ecoverse/slicc');
    expect(gelatiereMd).toContain('`prompt` — what to ask a cone to author');
    expect(gelatiereMd).toContain('`prompt` — what to ask a cone to file');
  });
});

describe('the four namers of the stream path agree', () => {
  it('the gelatiere skill has cones post the stream dip at the real file', () => {
    expect(gelatiereSkill).toContain(`![Suggestions](${SUGGESTIONS_VFS_PATH})`);
    // Not the old home — a cone following the skill must never re-post the
    // onboarding sprinkle as the suggestions surface.
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
    // The split's whole point: the stream must NOT live under the welcome
    // prefix the extension panel swaps for the hand-off card.
    expect(SUGGESTIONS_VFS_PATH.startsWith('/shared/sprinkles/welcome/')).toBe(false);
  });
});
