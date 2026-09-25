import { describe, expect, it } from 'vitest';
import {
  findGithubMentions,
  githubCardFor,
  githubCardImage,
  githubRefCard,
  githubRefLabel,
  githubRefUrl,
  githubRepoHints,
  parseGithubUrl,
  resolveGithubMention,
} from '../../src/core/github-mentions.js';

describe('parseGithubUrl', () => {
  it('parses issue and pull URLs', () => {
    expect(parseGithubUrl('https://github.com/ai-ecoverse/slicc/pull/3428')).toEqual({
      owner: 'ai-ecoverse',
      repo: 'slicc',
      number: 3428,
      kind: 'pull',
    });
    expect(parseGithubUrl('https://github.com/o/r/issues/7#issuecomment-1')).toEqual({
      owner: 'o',
      repo: 'r',
      number: 7,
      kind: 'issue',
    });
    expect(parseGithubUrl('https://github.com/o/r/pull/7/files')?.number).toBe(7);
  });

  it('rejects other hosts, other pages and reserved owners', () => {
    expect(parseGithubUrl('https://gitlab.com/o/r/issues/1')).toBeNull();
    expect(parseGithubUrl('https://github.com/o/r/tree/main')).toBeNull();
    expect(parseGithubUrl('https://github.com/settings/tokens/issues/1')).toBeNull();
    expect(parseGithubUrl('not a url')).toBeNull();
  });
});

describe('ref helpers', () => {
  const pull = { owner: 'o', repo: 'r', number: 12, kind: 'pull' as const };
  const unknown = { owner: 'o', repo: 'r', number: 12, kind: 'unknown' as const };

  it('builds urls, card images and labels', () => {
    expect(githubRefUrl(pull)).toBe('https://github.com/o/r/pull/12');

    expect(githubRefUrl(unknown)).toBe('https://github.com/o/r/issues/12');
    expect(githubCardImage(pull)).toBe('https://opengraph.githubassets.com/slicc/o/r/pull/12');
    expect(githubRefLabel(pull)).toBe('PR #12');
    expect(githubRefLabel({ kind: 'issue', number: 3 })).toBe('Issue #3');
    expect(githubRefLabel(unknown)).toBe('#12');
  });

  it('cards a reference with its rendered image and label', () => {
    expect(githubRefCard(pull)).toEqual({
      kind: 'pull',
      title: 'o/r#12',
      image: 'https://opengraph.githubassets.com/slicc/o/r/pull/12',
      badge: 'PR #12',
    });

    expect(githubRefCard(unknown)).toMatchObject({ kind: 'issue', badge: '#12' });
  });
});

describe('githubCardFor', () => {
  const card = (url: string) => githubCardFor(`https://github.com${url}`);
  const image = (path: string) => `https://opengraph.githubassets.com/slicc/${path}`;

  it('cards issues and pull requests', () => {
    expect(card('/o/r/pull/12/files')).toEqual({
      kind: 'pull',
      title: 'o/r#12',
      image: image('o/r/pull/12'),
      badge: 'PR #12',
    });
    expect(card('/o/r/issues/7#issuecomment-1')).toMatchObject({
      kind: 'issue',
      badge: 'Issue #7',
    });
  });

  it('cards a repository, and every page under it from the repository card', () => {
    const repo = {
      kind: 'repo',
      title: 'facebook/react',
      image: image('facebook/react'),
      badge: 'Repository',
    };
    expect(card('/facebook/react')).toEqual(repo);
    expect(card('/facebook/react/')).toEqual(repo);
    expect(card('/facebook/react.git')).toEqual(repo);
    expect(card('/facebook/react/blob/main/README.md')).toEqual(repo);

    expect(card('/facebook/react/blob/main/logo.png')).toEqual(repo);
    expect(card('/facebook/react/tree/main/packages')).toEqual(repo);
    expect(card('/facebook/react/actions')).toEqual(repo);

    expect(card('/facebook/react/issues')).toEqual(repo);
    expect(card('/facebook/react/issues/new')).toEqual(repo);
  });

  it('declines resource-serving routes so image previews can claim them', () => {
    expect(card('/o/r/raw/main/image.png')).toBeNull();
    expect(card('/o/r/raw/refs/heads/main/docs/shot.webp')).toBeNull();
    expect(card('/o/r/releases/download/v1.0.0/image.png')).toBeNull();
    expect(card('/o/r/releases/download/v1/asset.bin')).toBeNull();

    expect(card('/o/r/releases/tag/v1.0.0')).toMatchObject({ kind: 'release' });
  });

  it('cards discussions, commits and releases', () => {
    expect(card('/o/r/discussions/9')).toEqual({
      kind: 'discussion',
      title: 'o/r#9',
      image: image('o/r/discussions/9'),
      badge: 'Discussion #9',
    });
    const sha = 'd083ec1da1e5252abd3ddfdde6dfbc09701a2c51';
    expect(card(`/o/r/commit/${sha}`)).toEqual({
      kind: 'commit',
      title: 'o/r@d083ec1',
      image: image(`o/r/commit/${sha}`),
      badge: 'Commit',
    });
    expect(card('/o/r/releases/tag/v18.2.0')).toEqual({
      kind: 'release',
      title: 'o/r@v18.2.0',
      image: image('o/r/releases/tag/v18.2.0'),
      badge: 'Release',
    });

    expect(card('/o/r/releases/tag/release%2F1.0')).toMatchObject({
      title: 'o/r@release/1.0',
      image: image('o/r/releases/tag/release%2F1.0'),
    });
  });

  it('cards account-owned project boards and org discussions', () => {
    expect(card('/orgs/github/projects/4247')).toEqual({
      kind: 'project',
      title: 'github#4247',
      image: image('orgs/github/projects/4247'),
      badge: 'Project #4247',
    });
    expect(card('/users/ada/projects/1')).toMatchObject({
      kind: 'project',
      title: 'ada#1',
      image: image('users/ada/projects/1'),
    });
    expect(card('/orgs/community/discussions/1')).toEqual({
      kind: 'discussion',
      title: 'community#1',
      image: image('orgs/community/discussions/1'),
      badge: 'Discussion #1',
    });
  });

  it('declines site pages, other hosts and accounts', () => {
    expect(card('/settings/tokens')).toBeNull();
    expect(card('/notifications')).toBeNull();
    expect(card('/facebook')).toBeNull();

    expect(card('/users/ada/discussions/1')).toBeNull();
    expect(githubCardFor('https://gitlab.com/o/r')).toBeNull();
    expect(githubCardFor('https://opengraph.githubassets.com/x/o/r')).toBeNull();
    expect(githubCardFor('not a url')).toBeNull();
  });

  it('accepts the www host', () => {
    expect(githubCardFor('https://www.github.com/o/r')?.title).toBe('o/r');
  });
});

describe('findGithubMentions', () => {
  it('finds qualified, worded and bare references', () => {
    const text = 'See ai-ecoverse/slicc#12, PR 34, issue #5 and #6.';
    expect(findGithubMentions(text).map((m) => [m.raw, m.kind, m.owner ?? null])).toEqual([
      ['ai-ecoverse/slicc#12', 'unknown', 'ai-ecoverse'],
      ['PR 34', 'pull', null],
      ['issue #5', 'issue', null],
      ['#6', 'unknown', null],
    ]);
  });

  it('reports exact offsets', () => {
    const text = 'x #42 y';
    const [m] = findGithubMentions(text);
    expect(text.slice(m?.start, m?.end)).toBe('#42');
  });

  it('does not double-count the number inside a worded reference', () => {
    expect(findGithubMentions('pull request #9').map((m) => m.raw)).toEqual(['pull request #9']);
  });

  it('ignores entities, anchors, headings and word-attached hashes', () => {
    expect(findGithubMentions('&#39; page/#12 ##3 abc#4')).toEqual([]);
  });

  it('ignores numbers too long to be an issue', () => {
    expect(findGithubMentions('#12345678')).toEqual([]);
  });
});

describe('githubRepoHints', () => {
  it('reads https and ssh remotes, -R/--repo flags and gh repo commands', () => {
    const text = [
      'git clone https://github.com/a/one.git',
      'origin  git@github.com:b/two.git (fetch)',
      'gh pr view 3 -R c/three',
      'gh issue list --repo=d/four',
      'gh repo clone e/five',
      'fixed in f/six#12',
    ].join('\n');
    expect(githubRepoHints(text)).toEqual([
      'a/one',
      'b/two',
      'c/three',
      'd/four',
      'e/five',
      'f/six',
    ]);
  });

  it('dedupes case-insensitively and skips site pages', () => {
    expect(
      githubRepoHints(
        'https://github.com/A/B https://github.com/a/b https://github.com/settings/keys'
      )
    ).toEqual(['A/B']);
  });
});

describe('resolveGithubMention', () => {
  const bare = { start: 0, end: 3, raw: '#12', number: 12, kind: 'unknown' as const };

  it('uses the most recent hint for a bare reference', () => {
    expect(resolveGithubMention(bare, ['old/repo', 'new/repo'])).toEqual({
      owner: 'new',
      repo: 'repo',
      number: 12,
      kind: 'unknown',
    });
  });

  it('prefers the reference’s own repository', () => {
    expect(resolveGithubMention({ ...bare, owner: 'x', repo: 'y' }, ['new/repo'])).toMatchObject({
      owner: 'x',
      repo: 'y',
    });
  });

  it('cannot resolve without any repository', () => {
    expect(resolveGithubMention(bare, [])).toBeNull();
    expect(resolveGithubMention(bare, ['malformed'])).toBeNull();
  });
});
