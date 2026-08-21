// @vitest-environment jsdom
/**
 * Tests for linkifying file mentions in a rendered message.
 *
 * The contract under test is "confirm, then linkify": a name only becomes a link
 * once the VFS has confirmed it, and everything the resolver rejects must survive
 * as untouched text.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FileMentionResolver, ResolvedMention } from '../../src/core/file-mention-resolver.js';
import {
  FILE_MENTION_CLASS,
  FILE_MENTION_OPEN_EVENT,
  type FileMentionOpenDetail,
  linkifyFileMentions,
} from '../../src/ui/file-mention-linker.js';

/** A resolver that records the hints it was handed, and confirms nothing. */
function recordingResolver(seen: string[][]): FileMentionResolver {
  return {
    resolve: (query: string) => Promise.resolve({ query, matches: [] }),
    resolveAll: (queries: string[], hints: readonly string[] = []) => {
      seen.push([...hints]);
      return Promise.resolve(queries.map((query) => ({ query, matches: [] })));
    },
    invalidate: () => {},
  } as unknown as FileMentionResolver;
}

/** A resolver that confirms exactly the paths it is given, keyed by basename. */
function fakeResolver(known: Record<string, string[]>): FileMentionResolver {
  const resolve = (query: string): Promise<ResolvedMention> =>
    Promise.resolve({ query, matches: known[query] ?? [] });
  return {
    resolve,
    resolveAll: (queries: string[]) => Promise.all(queries.map(resolve)),
    invalidate: () => {},
  } as unknown as FileMentionResolver;
}

function render(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

describe('linkifyFileMentions', () => {
  it('links a confirmed mention and leaves the surrounding prose intact', async () => {
    const root = render('<p>I updated bb.jsh for you</p>');
    await linkifyFileMentions(root, fakeResolver({ 'bb.jsh': ['/workspace/bb.jsh'] }));

    const link = root.querySelector(`a.${FILE_MENTION_CLASS}`);
    expect(link?.textContent).toBe('bb.jsh');
    expect(link?.getAttribute('data-path')).toBe('/workspace/bb.jsh');
    expect(root.textContent).toBe('I updated bb.jsh for you');
  });

  it('leaves an unconfirmed mention as plain text', async () => {
    const root = render('<p>I updated ghost.jsh for you</p>');
    await linkifyFileMentions(root, fakeResolver({}));

    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toBe('I updated ghost.jsh for you');
  });

  it('links several mentions in one message', async () => {
    const root = render('<p>Wrote check.sh, then check.js</p>');
    await linkifyFileMentions(
      root,
      fakeResolver({ 'check.sh': ['/w/check.sh'], 'check.js': ['/w/check.js'] })
    );

    expect([...root.querySelectorAll(`a.${FILE_MENTION_CLASS}`)].map((a) => a.textContent)).toEqual(
      ['check.sh', 'check.js']
    );
  });

  it('links only the confirmed half of a mixed message', async () => {
    const root = render('<p>Compare real.ts against ghost.ts</p>');
    await linkifyFileMentions(root, fakeResolver({ 'real.ts': ['/w/real.ts'] }));

    const links = root.querySelectorAll(`a.${FILE_MENTION_CLASS}`);
    expect(links.length).toBe(1);
    expect(links[0]?.textContent).toBe('real.ts');
    expect(root.textContent).toBe('Compare real.ts against ghost.ts');
  });

  it('links inside inline code, the commonest way an agent names a file', async () => {
    const root = render('<p>run <code>bb.jsh</code> now</p>');
    await linkifyFileMentions(root, fakeResolver({ 'bb.jsh': ['/workspace/bb.jsh'] }));

    expect(root.querySelector(`code a.${FILE_MENTION_CLASS}`)).not.toBeNull();
  });

  it('never links inside a fenced code block', async () => {
    const root = render('<pre><code>cat bb.jsh</code></pre>');
    await linkifyFileMentions(root, fakeResolver({ 'bb.jsh': ['/workspace/bb.jsh'] }));

    expect(root.querySelector('a')).toBeNull();
  });

  it('never rewrites the text of an existing link', async () => {
    const root = render('<p><a href="https://example.com">see main.ts</a></p>');
    await linkifyFileMentions(root, fakeResolver({ 'main.ts': ['/w/main.ts'] }));

    expect(root.querySelectorAll('a').length).toBe(1);
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  });

  it('carries a line number from a path:42 mention', async () => {
    const root = render('<p>fails at src/main.ts:42 today</p>');
    await linkifyFileMentions(root, fakeResolver({ 'src/main.ts': ['/w/src/main.ts'] }));

    expect(root.querySelector('a')?.getAttribute('data-line')).toBe('42');
  });

  it('emits an open event carrying the resolved path when clicked', async () => {
    const root = render('<p>open bb.jsh here</p>');
    await linkifyFileMentions(root, fakeResolver({ 'bb.jsh': ['/workspace/bb.jsh'] }));

    const seen: FileMentionOpenDetail[] = [];
    root.addEventListener(FILE_MENTION_OPEN_EVENT, (e) => {
      seen.push((e as CustomEvent<FileMentionOpenDetail>).detail);
    });
    root.querySelector<HTMLAnchorElement>(`a.${FILE_MENTION_CLASS}`)?.click();

    expect(seen[0]?.path).toBe('/workspace/bb.jsh');
  });

  it('suppresses default navigation so the preview opens in-app', async () => {
    const root = render('<p>open bb.jsh here</p>');
    await linkifyFileMentions(root, fakeResolver({ 'bb.jsh': ['/workspace/bb.jsh'] }));

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    root.querySelector(`a.${FILE_MENTION_CLASS}`)?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('surfaces the alternatives when a mention is ambiguous', async () => {
    const root = render('<p>edit main.ts now</p>');
    await linkifyFileMentions(root, fakeResolver({ 'main.ts': ['/a/main.ts', '/b/main.ts'] }));

    const link = root.querySelector<HTMLAnchorElement>(`a.${FILE_MENTION_CLASS}`);
    expect(link?.title).toContain('/a/main.ts');
    expect(link?.title).toContain('+1 other match');
  });

  it('is idempotent — a second pass neither re-resolves nor double-links', async () => {
    const root = render('<p>open bb.jsh here</p>');
    const resolver = fakeResolver({ 'bb.jsh': ['/workspace/bb.jsh'] });
    const spy = vi.spyOn(resolver, 'resolveAll');

    await linkifyFileMentions(root, resolver);
    await linkifyFileMentions(root, resolver);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(root.querySelectorAll(`a.${FILE_MENTION_CLASS}`).length).toBe(1);
  });

  it('re-links when the same element is given new content', async () => {
    // `slicc-agent-message.setBodyHtml()` reuses the `.body` element and swaps
    // its children, so a sticky "already done" flag would leave the replacement
    // text permanently unlinked.
    const root = render('<p>nothing here yet</p>');
    const resolver = fakeResolver({ 'bb.jsh': ['/workspace/bb.jsh'] });

    await linkifyFileMentions(root, resolver);
    expect(root.querySelector('a')).toBeNull();

    root.innerHTML = '<p>now it mentions bb.jsh</p>';
    await linkifyFileMentions(root, resolver);

    expect(root.querySelector(`a.${FILE_MENTION_CLASS}`)?.textContent).toBe('bb.jsh');
  });

  it('does no resolver work for a message with no candidates', async () => {
    const root = render('<p>All checks are green and mergeable</p>');
    const resolver = fakeResolver({});
    const spy = vi.spyOn(resolver, 'resolveAll');

    await linkifyFileMentions(root, resolver);
    expect(spy).not.toHaveBeenCalled();
  });

  it("passes the turn's tool-call paths through to the resolver", async () => {
    const seen: string[][] = [];
    const root = render('<p>wrote foo.md</p>');
    await linkifyFileMentions(root, recordingResolver(seen), ['/home/lars/foo.md']);

    expect(seen).toEqual([['/home/lars/foo.md']]);
  });

  it('links a mention written with a relative prefix', async () => {
    // The resolver reports the NORMALIZED query it looked up, so a linker that
    // keyed its answers off that string would never find `./check.sh` again.
    const root = render('<p>run ./check.sh now</p>');
    await linkifyFileMentions(root, fakeResolver({ './check.sh': ['/w/check.sh'] }));

    expect(root.querySelector(`a.${FILE_MENTION_CLASS}`)?.textContent).toBe('./check.sh');
  });
});
