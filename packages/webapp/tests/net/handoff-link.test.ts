import { describe, expect, it } from 'vitest';
import {
  extractHandoff,
  extractHandoffFromCdpHeaders,
  extractHandoffFromFetchHeaders,
  extractHandoffFromWebRequest,
  HANDOFF_REL,
  handoffFingerprint,
  UPSKILL_REL,
} from '../../src/net/handoff-link.js';
import { parseLinkHeader } from '../../src/net/link-header.js';

describe('extractHandoff', () => {
  it('matches the upskill rel and returns the GitHub URL as target', () => {
    const links = parseLinkHeader(`<https://github.com/o/r>; rel="${UPSKILL_REL}"`);
    expect(extractHandoff(links)).toEqual({
      verb: 'upskill',
      target: 'https://github.com/o/r',
    });
  });

  it('matches the handoff rel with a title parameter as instruction', () => {
    const links = parseLinkHeader(
      `<https://example.com/page>; rel="${HANDOFF_REL}"; title="Continue the signup flow"`,
      'https://example.com/page'
    );
    expect(extractHandoff(links)).toEqual({
      verb: 'handoff',
      target: 'https://example.com/page',
      instruction: 'Continue the signup flow',
    });
  });

  it('decodes a UTF-8 title* into instruction (emoji + CJK)', () => {
    const links = parseLinkHeader(
      `<>; rel="${HANDOFF_REL}"; title*=UTF-8''Continue%20%F0%9F%9A%80%20%E4%BD%A0%E5%A5%BD`,
      'https://example.com/page'
    );
    expect(extractHandoff(links)).toEqual({
      verb: 'handoff',
      target: 'https://example.com/page',
      instruction: 'Continue 🚀 你好',
    });
  });

  it('returns null when no recognised rel is present', () => {
    const links = parseLinkHeader('</foo>; rel="next"');
    expect(extractHandoff(links)).toBeNull();
  });

  it('rejects rels with wrong case (URI comparison is case-sensitive)', () => {
    const links = parseLinkHeader('</>; rel="https://www.SLICCY.ai/rel/handoff"');
    expect(extractHandoff(links)).toBeNull();
  });

  it('returns the first match when multiple recognised rels are present', () => {
    const links = parseLinkHeader(
      `<https://github.com/o/r>; rel="${UPSKILL_REL}", <>; rel="${HANDOFF_REL}"; title="x"`,
      'https://example.com/'
    );
    expect(extractHandoff(links)?.verb).toBe('upskill');
  });

  it('drops empty instruction strings', () => {
    const links = parseLinkHeader(`</>; rel="${HANDOFF_REL}"; title=""`);
    const match = extractHandoff(links);
    expect(match?.verb).toBe('handoff');
    expect(match?.instruction).toBeUndefined();
  });

  it('surfaces a branch param on the upskill rel', () => {
    const links = parseLinkHeader(`<https://github.com/o/r>; rel="${UPSKILL_REL}"; branch=main`);
    expect(extractHandoff(links)).toEqual({
      verb: 'upskill',
      target: 'https://github.com/o/r',
      branch: 'main',
    });
  });

  it('surfaces both branch and path params on the upskill rel', () => {
    const links = parseLinkHeader(
      `<https://github.com/o/r>; rel="${UPSKILL_REL}"; branch=main; path="skills/foo"`
    );
    expect(extractHandoff(links)).toEqual({
      verb: 'upskill',
      target: 'https://github.com/o/r',
      branch: 'main',
      path: 'skills/foo',
    });
  });

  it('surfaces a path-only upskill rel (no branch)', () => {
    const links = parseLinkHeader(
      `<https://github.com/o/r>; rel="${UPSKILL_REL}"; path="skills/foo"`
    );
    expect(extractHandoff(links)).toEqual({
      verb: 'upskill',
      target: 'https://github.com/o/r',
      path: 'skills/foo',
    });
  });

  it('strips a trailing /SKILL.md from the path param', () => {
    const links = parseLinkHeader(
      `<https://github.com/o/r>; rel="${UPSKILL_REL}"; branch=main; path="skills/foo/SKILL.md"`
    );
    expect(extractHandoff(links)).toEqual({
      verb: 'upskill',
      target: 'https://github.com/o/r',
      branch: 'main',
      path: 'skills/foo',
    });
  });

  it('strips a trailing /SKILL.md case-insensitively', () => {
    const links = parseLinkHeader(
      `<https://github.com/o/r>; rel="${UPSKILL_REL}"; path="skills/foo/Skill.MD"`
    );
    expect(extractHandoff(links)?.path).toBe('skills/foo');
  });

  it('drops a path param that is only "SKILL.md"', () => {
    const links = parseLinkHeader(
      `<https://github.com/o/r>; rel="${UPSKILL_REL}"; path="SKILL.md"`
    );
    const match = extractHandoff(links);
    expect(match?.verb).toBe('upskill');
    expect(match?.path).toBeUndefined();
  });

  it('handoff verb ignores branch and path params (upskill-only)', () => {
    const links = parseLinkHeader(
      `<>; rel="${HANDOFF_REL}"; title="x"; branch=main; path="skills/foo"`,
      'https://example.com/'
    );
    const match = extractHandoff(links);
    expect(match?.verb).toBe('handoff');
    expect(match?.branch).toBeUndefined();
    expect(match?.path).toBeUndefined();
  });

  it('drops empty branch and path values', () => {
    const links = parseLinkHeader(
      `<https://github.com/o/r>; rel="${UPSKILL_REL}"; branch=""; path=""`
    );
    const match = extractHandoff(links);
    expect(match?.verb).toBe('upskill');
    expect(match?.branch).toBeUndefined();
    expect(match?.path).toBeUndefined();
  });

  it("decodes RFC 8187 branch*=UTF-8'' ext-value form", () => {
    // `feature/fix` percent-encoded as `feature%2Ffix`. ASCII-only on
    // purpose: the shell-injection allowlist (see `isSafeUpskillBranch`)
    // rejects non-ASCII branches to close the homoglyph-spoofing surface
    // (e.g. a Cyrillic 'а' that renders identical to ASCII 'a' in the
    // approval card). Real git branches in the wild are ASCII; this
    // assertion locks in the policy.
    const links = parseLinkHeader(
      `<https://github.com/o/r>; rel="${UPSKILL_REL}"; branch*=UTF-8''feature%2Ffix`
    );
    expect(extractHandoff(links)?.branch).toBe('feature/fix');
  });

  it('drops a non-ASCII branch (homoglyph-spoofing defense)', () => {
    // `féature` percent-encoded — would render close to `feature` in the
    // approval card. The extractor drops it instead of surfacing it.
    const links = parseLinkHeader(
      `<https://github.com/o/r>; rel="${UPSKILL_REL}"; branch*=UTF-8''f%C3%A9ature`
    );
    const match = extractHandoff(links);
    expect(match?.verb).toBe('upskill');
    expect(match?.branch).toBeUndefined();
  });

  // ─── Shell-injection defense (see `isSafeUpskillBranch` /
  // `isSafeUpskillPath` in `packages/webapp/src/net/handoff-link.ts`).
  //
  // The `Link` header is attacker-controlled. The cone follows the
  // handoff SKILL instruction to render `upskill --branch <b> --path
  // <p> <target>` as a `bash` tool call. If the cone splices `b`/`p`
  // unquoted, shell metachars in the value can smuggle a second
  // command past the approval card. Drop unsafe values at extraction
  // time so the cone never sees them in the lick body.
  describe('shell-injection defense — branch param', () => {
    it('drops a branch containing a semicolon', () => {
      const links = parseLinkHeader(
        `<https://github.com/o/r>; rel="${UPSKILL_REL}"; branch="main;rm -rf /"`
      );
      const match = extractHandoff(links);
      expect(match?.verb).toBe('upskill');
      expect(match?.branch).toBeUndefined();
    });

    it('drops a branch containing a backtick', () => {
      const links = parseLinkHeader(
        `<https://github.com/o/r>; rel="${UPSKILL_REL}"; branch="main\`whoami\`"`
      );
      expect(extractHandoff(links)?.branch).toBeUndefined();
    });

    it('drops a branch containing $(...) command substitution', () => {
      const links = parseLinkHeader(
        `<https://github.com/o/r>; rel="${UPSKILL_REL}"; branch="main$(whoami)"`
      );
      expect(extractHandoff(links)?.branch).toBeUndefined();
    });

    it('drops a branch with a trailing newline', () => {
      const links = parseLinkHeader(
        `<https://github.com/o/r>; rel="${UPSKILL_REL}"; branch*=UTF-8''main%0Aecho%20PWNED`
      );
      expect(extractHandoff(links)?.branch).toBeUndefined();
    });

    it('drops a branch starting with a dash (would be misparsed as a flag)', () => {
      const links = parseLinkHeader(`<https://github.com/o/r>; rel="${UPSKILL_REL}"; branch="-rf"`);
      expect(extractHandoff(links)?.branch).toBeUndefined();
    });

    it('keeps a normal branch with slashes, dots, dashes, underscores', () => {
      const links = parseLinkHeader(
        `<https://github.com/o/r>; rel="${UPSKILL_REL}"; branch="release/v1.2_hotfix-3"`
      );
      expect(extractHandoff(links)?.branch).toBe('release/v1.2_hotfix-3');
    });
  });

  describe('shell-injection defense — path param', () => {
    it('drops a path containing a semicolon', () => {
      const links = parseLinkHeader(
        `<https://github.com/o/r>; rel="${UPSKILL_REL}"; path="skills/foo;rm -rf /"`
      );
      const match = extractHandoff(links);
      expect(match?.verb).toBe('upskill');
      expect(match?.path).toBeUndefined();
    });

    it('drops a path containing a backtick', () => {
      const links = parseLinkHeader(
        `<https://github.com/o/r>; rel="${UPSKILL_REL}"; path="skills/\`id\`"`
      );
      expect(extractHandoff(links)?.path).toBeUndefined();
    });

    it('drops a path containing $(...) command substitution', () => {
      const links = parseLinkHeader(
        `<https://github.com/o/r>; rel="${UPSKILL_REL}"; path="skills/$(id)"`
      );
      expect(extractHandoff(links)?.path).toBeUndefined();
    });

    it('drops a path with a trailing newline', () => {
      const links = parseLinkHeader(
        `<https://github.com/o/r>; rel="${UPSKILL_REL}"; path*=UTF-8''skills%2Ffoo%0Aecho%20PWNED`
      );
      expect(extractHandoff(links)?.path).toBeUndefined();
    });

    it('drops a path containing .. traversal', () => {
      const links = parseLinkHeader(
        `<https://github.com/o/r>; rel="${UPSKILL_REL}"; path="../etc/passwd"`
      );
      expect(extractHandoff(links)?.path).toBeUndefined();
    });

    it('drops an absolute path', () => {
      const links = parseLinkHeader(
        `<https://github.com/o/r>; rel="${UPSKILL_REL}"; path="/etc/passwd"`
      );
      expect(extractHandoff(links)?.path).toBeUndefined();
    });

    it('drops a path starting with a dash (would be misparsed as a flag)', () => {
      const links = parseLinkHeader(`<https://github.com/o/r>; rel="${UPSKILL_REL}"; path="-rf"`);
      expect(extractHandoff(links)?.path).toBeUndefined();
    });

    it('keeps a normal sub-path with slashes, dots, dashes, underscores', () => {
      const links = parseLinkHeader(
        `<https://github.com/o/r>; rel="${UPSKILL_REL}"; path="skills/foo_bar/v1.2-beta"`
      );
      expect(extractHandoff(links)?.path).toBe('skills/foo_bar/v1.2-beta');
    });

    it('still surfaces the upskill verb when only the path is dropped', () => {
      const links = parseLinkHeader(
        `<https://github.com/o/r>; rel="${UPSKILL_REL}"; branch=main; path=";rm -rf /;"`
      );
      const match = extractHandoff(links);
      expect(match).toEqual({
        verb: 'upskill',
        target: 'https://github.com/o/r',
        branch: 'main',
      });
    });
  });
});

describe('extractHandoffFrom* adapters', () => {
  it('extractHandoffFromCdpHeaders parses CDP-style header bag', () => {
    const result = extractHandoffFromCdpHeaders(
      {
        'content-type': 'text/html',
        link: `<https://github.com/o/r>; rel="${UPSKILL_REL}"`,
      },
      'https://www.sliccy.ai/handoff'
    );
    expect(result.match).toEqual({
      verb: 'upskill',
      target: 'https://github.com/o/r',
    });
    expect(result.links).toHaveLength(1);
  });

  it('extractHandoffFromCdpHeaders returns nulls when no Link header', () => {
    const result = extractHandoffFromCdpHeaders({ 'content-type': 'text/html' });
    expect(result.match).toBeNull();
    expect(result.links).toEqual([]);
  });

  it('extractHandoffFromWebRequest parses webRequest array', () => {
    const result = extractHandoffFromWebRequest(
      [
        { name: 'Content-Type', value: 'text/html' },
        { name: 'Link', value: `<>; rel="${HANDOFF_REL}"; title="do it"` },
      ],
      'https://example.com/'
    );
    expect(result.match?.verb).toBe('handoff');
    expect(result.match?.instruction).toBe('do it');
  });

  it('extractHandoffFromFetchHeaders parses Headers object', () => {
    const headers = new Headers();
    headers.set('Link', `<https://github.com/o/r>; rel="${UPSKILL_REL}"`);
    const result = extractHandoffFromFetchHeaders(headers);
    expect(result.match?.verb).toBe('upskill');
    expect(result.match?.target).toBe('https://github.com/o/r');
  });
});

describe('handoffFingerprint', () => {
  it('is stable across different page URLs for the same upskill payload', () => {
    // Same site-wide upskill rel, advertised on two different page URLs.
    const a = handoffFingerprint({ verb: 'upskill', target: 'https://github.com/o/r' });
    const b = handoffFingerprint({ verb: 'upskill', target: 'https://github.com/o/r' });
    expect(a).toBe(b);
  });

  it('distinguishes branch and path', () => {
    const base = handoffFingerprint({ verb: 'upskill', target: 'https://github.com/o/r' });
    const branched = handoffFingerprint({
      verb: 'upskill',
      target: 'https://github.com/o/r',
      branch: 'next',
    });
    const subpath = handoffFingerprint({
      verb: 'upskill',
      target: 'https://github.com/o/r',
      path: 'skills/foo',
    });
    expect(new Set([base, branched, subpath]).size).toBe(3);
  });

  it('distinguishes verb and instruction', () => {
    const handoffA = handoffFingerprint({
      verb: 'handoff',
      target: 'https://example.com/p',
      instruction: 'do A',
    });
    const handoffB = handoffFingerprint({
      verb: 'handoff',
      target: 'https://example.com/p',
      instruction: 'do B',
    });
    expect(handoffA).not.toBe(handoffB);
  });

  it('treats omitted and empty optional fields identically', () => {
    expect(handoffFingerprint({ verb: 'upskill', target: 't' })).toBe(
      handoffFingerprint({ verb: 'upskill', target: 't', branch: '', path: '', instruction: '' })
    );
  });
});
