import { describe, expect, it } from 'vitest';
import { matchHashedAssetPath, mimeForAssetPath } from '../src/asset-archive.mjs';

describe('matchHashedAssetPath', () => {
  it('accepts hashed chunk names', () => {
    expect(matchHashedAssetPath('/assets/anthropic-messages-DP3-Xd3J.js')).toBe(true);
    expect(matchHashedAssetPath('/assets/index-a1b2c3d4.css')).toBe(true);
    expect(matchHashedAssetPath('/assets/entry-abcd1234.js.map')).toBe(true);
    expect(matchHashedAssetPath('/assets/logo-DEADBEEF.svg')).toBe(true);
  });
  it('rejects non-asset / un-hashed / traversal / encoded paths', () => {
    expect(matchHashedAssetPath('/index.html')).toBe(false);
    expect(matchHashedAssetPath('/assets/index.html')).toBe(false); // wrong ext
    expect(matchHashedAssetPath('/assets/foo.js')).toBe(false); // no hash
    expect(matchHashedAssetPath('/assets/../secret-abcd1234.js')).toBe(false);
    expect(matchHashedAssetPath('/assets/a%2Fb-abcd1234.js')).toBe(false);
    expect(matchHashedAssetPath('/other/x-abcd1234.js')).toBe(false);
  });
});

describe('mimeForAssetPath', () => {
  it('maps critical types', () => {
    expect(mimeForAssetPath('/assets/x-abcd1234.js')).toBe('text/javascript');
    expect(mimeForAssetPath('/assets/x-abcd1234.mjs')).toBe('text/javascript');
    expect(mimeForAssetPath('/assets/x-abcd1234.css')).toBe('text/css');
    expect(mimeForAssetPath('/assets/x-abcd1234.wasm')).toBe('application/wasm');
    expect(mimeForAssetPath('/assets/x-abcd1234.js.map')).toBe('application/json');
    expect(mimeForAssetPath('/assets/x-abcd1234.woff2')).toBe('font/woff2');
  });
  it('falls back to octet-stream', () => {
    expect(mimeForAssetPath('/assets/x-abcd1234.zzz')).toBe('application/octet-stream');
  });
});
