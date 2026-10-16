// @ts-expect-error — .mjs with no .d.ts
import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { isProtectedTarget, isProtectedUrl, PROTECTED_REFUSAL } from '../src/protected-origins.js';

const vectorsPath = resolve(
  __dirname,
  '../../../node_modules/@ai-ecoverse/slicc-browsers/protected.json'
);
interface UrlVector {
  url: string;
  protected: boolean;
}
interface TargetVector {
  url: string;
  previous?: boolean;
  opener?: 'protected' | 'unprotected' | 'unknown';
  protected: boolean;
}
interface Vectors {
  origins: string[];
  urls: UrlVector[];
  targets: TargetVector[];
}
const vectors: Vectors = JSON.parse(readFileSync(vectorsPath, 'utf-8'));

const EXTRA_ORIGIN_URLS = new Set([
  'http://127.0.0.1:5710/',
  'http://127.0.0.1:5710',
  'http://2130706433:5710/',
  'http://0x7f.1:5710/',
  'blob:http://127.0.0.1:5710/0b9e0f6c',
  'https://seven.example.test/',
  'https://SEVEN.example.test:443/x',
  'https://seven.example.test./',
  'http://127.0.0.1:5710/index.html',
]);

describe('isProtectedUrl — protected.json URL vectors (no extra origins)', () => {
  const coreVectors = vectors.urls.filter((v) => !EXTRA_ORIGIN_URLS.has(v.url));
  for (const v of coreVectors) {
    const label = v.protected ? 'protected' : 'unprotected';
    it(`${label}: ${JSON.stringify(v.url)}`, () => {
      expect(isProtectedUrl(v.url)).toBe(v.protected);
    });
  }

  it('returns false for undefined', () => {
    expect(isProtectedUrl(undefined)).toBe(false);
  });
});

describe('isProtectedTarget — protected.json target vectors (no extra origins)', () => {
  const coreTargets = vectors.targets.filter((v) => !EXTRA_ORIGIN_URLS.has(v.url));
  for (const v of coreTargets) {
    const label = v.protected ? 'protected' : 'unprotected';
    const desc = [
      JSON.stringify(v.url),
      v.previous !== undefined ? `previous=${v.previous}` : null,
      v.opener !== undefined ? `opener=${v.opener}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    it(`${label}: ${desc}`, () => {
      expect(isProtectedTarget(v.url, v.previous, v.opener)).toBe(v.protected);
    });
  }
});

const RULES = {
  domains: ['sliccy.ai'],
  hosts: ['vault.sliccy.ai'],
  schemes: ['https', 'http'],
  innerSchemes: ['blob', 'filesystem', 'view-source'],
  anySchemes: ['devtools'],
  inheriting: ['about:blank', 'about:srcdoc'],
  refusal: "slicc: refused: target is on seven's origin",
};

const fullGuard = protectedOrigins(RULES, vectors.origins) as {
  url: (text: string) => boolean;
  target: (opts: { url: string; previous?: boolean; opener?: string }) => boolean;
};

describe('protectedOrigins (with extra origins) — full protected.json corpus', () => {
  for (const v of vectors.urls) {
    const label = v.protected ? 'protected' : 'unprotected';
    it(`url ${label}: ${JSON.stringify(v.url)}`, () => {
      expect(fullGuard.url(v.url)).toBe(v.protected);
    });
  }
  for (const v of vectors.targets) {
    const label = v.protected ? 'protected' : 'unprotected';
    const desc = [
      JSON.stringify(v.url),
      v.previous !== undefined ? `previous=${v.previous}` : null,
      v.opener !== undefined ? `opener=${v.opener}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    it(`target ${label}: ${desc}`, () => {
      expect(fullGuard.target({ url: v.url, previous: v.previous, opener: v.opener })).toBe(
        v.protected
      );
    });
  }
});

describe('PROTECTED_REFUSAL', () => {
  it('is the canonical refusal string', () => {
    expect(PROTECTED_REFUSAL).toBe("slicc: refused: target is on seven's origin");
  });
});
