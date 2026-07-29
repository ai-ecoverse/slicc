import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const assemblySource = readFileSync(new URL('./assemble-app.mjs', import.meta.url), 'utf8');
const entitlements = readFileSync(new URL('./Sliccstart.entitlements', import.meta.url), 'utf8');
const signingScript = readFileSync(new URL('./sign-and-package.sh', import.meta.url), 'utf8');

describe('Sliccstart Apple Events packaging', () => {
  it('declares why the assembled app controls terminal applications', () => {
    expect(assemblySource).toContain('<key>NSAppleEventsUsageDescription</key>');
    expect(assemblySource).toContain('open a new Terminal or iTerm2 window');
  });

  it('enables Apple Events automation in the signing entitlements', () => {
    expect(entitlements).toContain('<key>com.apple.security.automation.apple-events</key>');
    expect(entitlements).toMatch(/com\.apple\.security\.automation\.apple-events<\/key>\s*<true\/>/);
  });

  it('applies the entitlements to release and ad-hoc outer-app signatures', () => {
    expect(signingScript.match(/--entitlements "\$ENTITLEMENTS"/g)).toHaveLength(2);
    expect(signingScript).toContain('ENTITLEMENTS="$SCRIPT_DIR/Sliccstart.entitlements"');
  });
});

describe('Sliccstart default-browser packaging', () => {
  it('advertises the http and https handler role', () => {
    // LaunchServices only lists Sliccstart under "Default web browser" — and
    // only accepts a handler change — for schemes the bundle declares here.
    // Keep in step with DefaultBrowserRegistration.handledSchemes.
    expect(assemblySource).toContain('<key>CFBundleURLTypes</key>');
    expect(assemblySource).toMatch(
      /<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>http<\/string>\s*<string>https<\/string>\s*<\/array>/
    );
  });

  it('claims HTML documents as a viewer without outranking real browsers', () => {
    expect(assemblySource).toContain('<string>public.html</string>');
    expect(assemblySource).toContain('<string>public.xhtml</string>');
    expect(assemblySource).toMatch(/<key>LSHandlerRank<\/key>\s*<string>Alternate<\/string>/);
  });
});

describe('Sliccstart iCloud sync packaging', () => {
  it('embeds the provisioning profile only when PROVISION_PROFILE is supplied', () => {
    expect(signingScript).toContain('if [ -n "${PROVISION_PROFILE:-}" ]; then');
    expect(signingScript).toContain('Contents/embedded.provisionprofile');
  });

  it('defaults the kvstore identifier to the team-prefixed bundle id, overridable via KVSTORE_IDENTIFIER', () => {
    expect(signingScript).toContain(
      'KVSTORE_IDENTIFIER="${KVSTORE_IDENTIFIER:-${APPLE_TEAM_ID}.com.slicc.sliccstart}"'
    );
    expect(signingScript).toContain(
      'com.apple.developer.ubiquity-kvstore-identifier string ${KVSTORE_IDENTIFIER}'
    );
  });

  it('fails fast when PROVISION_PROFILE points at a missing file', () => {
    expect(signingScript).toContain('ERROR: PROVISION_PROFILE set but file not found');
  });
});