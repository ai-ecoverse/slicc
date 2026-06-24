/**
 * Tests for the static DNR ruleset that relaxes `frame-ancestors` on
 * sub_frame requests to sliccy.ai so the launcher iframe can embed the
 * cherry SPA. Asserts the rule's shape — operation is `set` (override),
 * scope is `sub_frame` + the `||sliccy.ai/?cherry=1` cherry-follower
 * surface, header value reproduces the SPA's CSP minus the framing block
 * — so a future edit that accidentally uses `remove`, broadens to
 * top-level navigations, re-broadens to all sliccy.ai subframes, or
 * strips non-framing directives trips the test.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface DnrStaticRule {
  id: number;
  priority: number;
  condition: { urlFilter: string; resourceTypes: string[] };
  action: {
    type: string;
    responseHeaders: Array<{ header: string; operation: string; value?: string }>;
  };
}

interface ExtensionManifest {
  declarative_net_request?: {
    rule_resources: Array<{ id: string; enabled: boolean; path: string }>;
  };
  content_security_policy?: unknown;
}

const PKG_ROOT = resolve(__dirname, '..');

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(resolve(PKG_ROOT, rel), 'utf-8')) as T;
}

describe('dnr-frame-ancestors.json', () => {
  const rules = readJson<DnrStaticRule[]>('dnr-frame-ancestors.json');

  it('contains exactly one rule', () => {
    expect(rules).toHaveLength(1);
  });

  it('scopes the override to the sliccy.ai cherry-follower sub_frame only', () => {
    const [rule] = rules;
    // Narrowed from the blanket `||sliccy.ai` to the `?cherry=1`
    // cherry-follower surface so the override no longer makes arbitrary
    // sliccy.ai subframes (e.g. the `?slicc=leader` UI) frameable by
    // third-party pages — it only relaxes framing on the embedded
    // launcher/cherry iframe the content script injects.
    expect(rule.condition.urlFilter).toBe('||sliccy.ai/?cherry=1');
    expect(rule.condition.resourceTypes).toEqual(['sub_frame']);
  });

  it('overrides (set) the content-security-policy header — never removes it', () => {
    const [rule] = rules;
    expect(rule.action.type).toBe('modifyHeaders');
    expect(rule.action.responseHeaders).toHaveLength(1);
    const header = rule.action.responseHeaders[0];
    expect(header.header).toBe('content-security-policy');
    expect(header.operation).toBe('set');
    expect(header.value).toBe('frame-ancestors *');
  });
});

describe('manifest.json — DNR ruleset wiring', () => {
  const manifest = readJson<ExtensionManifest>('manifest.json');

  it('references the frame-ancestors ruleset', () => {
    const rs = manifest.declarative_net_request?.rule_resources ?? [];
    const entry = rs.find((r) => r.path === 'dnr-frame-ancestors.json');
    expect(entry).toBeDefined();
    expect(entry?.enabled).toBe(true);
  });
});

describe('content-script.ts — launcher app URL', () => {
  // Source-file inspection: the content script runs `define('slicc-launcher')`
  // at top-level import, which crashes Node test runs (no customElements).
  // Read the file as text instead and assert the URL literal. `PROD_…` is
  // the hosted-build branch of the `__SLICC_EXT_DEV__` resolver — the dev
  // branch points at `http://localhost:8787` and is exercised through the
  // unit-test of `getSliccAppUrl` in `content-script.test.ts`.
  const src = readFileSync(resolve(PKG_ROOT, 'src/content-script.ts'), 'utf-8');

  it('points the launcher iframe at the cherry-follower URL', () => {
    expect(src).toContain("const PROD_SLICC_APP_URL = 'https://www.sliccy.ai/?cherry=1';");
  });

  it('uses the www. host (skip apex→www 301) and a non-empty search (skip marketing redirect)', () => {
    const m = src.match(/const PROD_SLICC_APP_URL = '([^']+)';/);
    expect(m).not.toBeNull();
    const url = new URL(m?.[1] ?? '');
    expect(url.hostname).toBe('www.sliccy.ai');
    expect(url.searchParams.get('cherry')).toBe('1');
  });
});
