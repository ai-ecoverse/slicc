import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractHandoff } from '../../src/net/handoff-link.js';
import { parseLinkHeader } from '../../src/net/link-header.js';
import {
  buildLinkHeaderCorpusDocument,
  LINK_HEADER_CORPUS,
} from '../../src/net/link-header-corpus.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(
  here,
  '../../../ios-app/SliccFollower/Tests/SliccFollowerTests/Fixtures/link-header-corpus.json'
);

/**
 * The corpus is only worth anything if it describes what the TS parser
 * actually does. Assert every case against the real implementation here, so a
 * hand-written expectation cannot quietly encode a fiction that the Swift
 * mirror is then held to.
 */
describe('link header corpus', () => {
  it.each(LINK_HEADER_CORPUS.map((c) => [c.name, c] as const))(
    'parses %s as the corpus claims',
    (_name, testCase) => {
      const links = parseLinkHeader(testCase.header, testCase.baseUrl);
      expect(links.map((l) => ({ href: l.href, rel: l.rel, params: l.params }))).toEqual(
        testCase.links
      );
    }
  );

  it.each(LINK_HEADER_CORPUS.map((c) => [c.name, c] as const))(
    'extracts the claimed handoff from %s',
    (_name, testCase) => {
      const links = parseLinkHeader(testCase.header, testCase.baseUrl);
      const match = extractHandoff(links);
      expect(match ?? null).toEqual(testCase.handoff);
    }
  );

  it('has a case for every rejection the allowlists perform', () => {
    // Each of these is a distinct reason `applyUpskillParams` drops a value.
    // A new rejection rule without a case here is an untested divergence.
    const branchRejections = LINK_HEADER_CORPUS.filter(
      (c) => c.handoff?.verb === 'upskill' && c.links[0]?.params.branch && !c.handoff.branch
    );
    const pathRejections = LINK_HEADER_CORPUS.filter(
      (c) => c.handoff?.verb === 'upskill' && c.links[0]?.params.path && !c.handoff.path
    );
    expect(branchRejections.length).toBeGreaterThanOrEqual(6);
    expect(pathRejections.length).toBeGreaterThanOrEqual(2);
  });

  it('matches the checked-in JSON the Swift suite reads', () => {
    const onDisk = JSON.parse(readFileSync(fixture, 'utf8'));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(buildLinkHeaderCorpusDocument())));
  });
});
