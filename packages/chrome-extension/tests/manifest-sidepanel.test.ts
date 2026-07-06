import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import manifest from '../manifest.json';

describe('manifest side panel', () => {
  it('declares the sidePanel permission', () => {
    expect(manifest.permissions).toContain('sidePanel');
  });
  it('registers the default side panel path', () => {
    expect((manifest as { side_panel?: { default_path?: string } }).side_panel?.default_path).toBe(
      'sidepanel.html'
    );
  });
  it('sets a minimum_chrome_version >= 116 (sidePanel.open availability)', () => {
    const v = Number((manifest as { minimum_chrome_version?: string }).minimum_chrome_version);
    expect(v).toBeGreaterThanOrEqual(116);
  });
  it('does not declare declarative_net_request (mechanism a confirmed)', () => {
    expect(
      (manifest as { declarative_net_request?: unknown }).declarative_net_request
    ).toBeUndefined();
  });
  it('does not declare activeTab (dropped with injection removal)', () => {
    expect(manifest.permissions).not.toContain('activeTab');
  });
});

/**
 * Derive the Chrome extension ID from a manifest `key` exactly as Chromium does:
 * SHA-256 of the DER-encoded public key, then map each of the first 16 bytes'
 * two hex nibbles into the `a`–`p` alphabet.
 */
function extensionIdFromKey(base64Key: string): string {
  const der = Buffer.from(base64Key, 'base64');
  const hash = createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0x0f));
  }
  return id;
}

/**
 * The side-panel follower (`?cherry=1`) only frames inside the panel iframe if
 * the worker's `frame-ancestors` CSP names this extension's origin — a bare `*`
 * does NOT authorize a `chrome-extension://` ancestor. If the manifest `key`
 * changes without updating `ALLOWED_CHERRY_HOST_ORIGINS`, panel framing breaks
 * silently in production. This guard couples the two so that can't happen.
 */
describe('cherry side-panel framing contract (manifest key ↔ worker CSP allowlist)', () => {
  const extId = extensionIdFromKey((manifest as { key: string }).key);
  const wranglerPath = fileURLToPath(
    new URL('../../cloudflare-worker/wrangler.jsonc', import.meta.url)
  );
  const wrangler = readFileSync(wranglerPath, 'utf-8');
  const allowlists = [...wrangler.matchAll(/"ALLOWED_CHERRY_HOST_ORIGINS":\s*"([^"]*)"/g)].map(
    (m) => m[1]
  );

  it('derives a valid 32-char a–p extension ID from the manifest key', () => {
    expect(extId).toMatch(/^[a-p]{32}$/);
  });

  it('finds the ALLOWED_CHERRY_HOST_ORIGINS var in every wrangler env (top-level + staging)', () => {
    expect(allowlists.length).toBeGreaterThanOrEqual(2);
  });

  it('allowlists this extension origin in every wrangler env', () => {
    const origin = `chrome-extension://${extId}`;
    for (const list of allowlists) {
      expect(list.split(/\s+/)).toContain(origin);
    }
  });
});
