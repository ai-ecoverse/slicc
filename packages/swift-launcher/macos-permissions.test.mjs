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

describe('Sliccstart WebRTC.framework packaging', () => {
  // slicc-server links @rpath/WebRTC.framework/WebRTC (via SliccTrayFollower's
  // WebRTC tray transport). Its only bundle-local rpath is @loader_path
  // (Contents/Resources), so the framework must sit next to the binary or dyld
  // fails at launch and every spawned server dies as "start failed".
  it('copies WebRTC.framework next to slicc-server in the bundle', () => {
    expect(assemblySource).toContain(".build/release/WebRTC.framework");
    expect(assemblySource).toContain("resolve(resources, 'WebRTC.framework')");
  });

  it('fails assembly fast when the framework was not built', () => {
    expect(assemblySource).toContain('WebRTC.framework not found');
  });

  it('re-signs the embedded framework in both the Developer ID and ad-hoc paths', () => {
    expect(
      signingScript.match(/"\$APP_DIR\/Contents\/Resources\/WebRTC\.framework"/g)
    ).toHaveLength(2);
  });

  it('signs the framework innermost-first, before slicc-server', () => {
    // Nested code must be signed before the code that contains it.
    const framework = signingScript.indexOf('Resources/WebRTC.framework"');
    const server = signingScript.indexOf('Resources/slicc-server"');
    expect(framework).toBeGreaterThanOrEqual(0);
    expect(framework).toBeLessThan(server);
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

describe('Sliccstart File Provider packaging', () => {
  it('declares the team-prefixed app group for credential sharing', () => {
    expect(entitlements).toContain('S8LB56P782.com.slicc.sliccstart.fileprovider');
  });

  it('builds and embeds the File Provider appex when project.yml is present', () => {
    expect(assemblySource).toContain('SliccFileProvider.appex');
    expect(assemblySource).toContain('Contents/PlugIns/');
  });

  it('signs the embedded appex with sandbox entitlements in both signing paths', () => {
    expect(signingScript).toContain('SliccFileProvider.entitlements');
    expect(signingScript.match(/SliccFileProvider\.entitlements/g)).toHaveLength(2);
    expect(signingScript.match(/PlugIns\/SliccFileProvider\.appex/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('signs the appex innermost-first, before the outer app', () => {
    const appex = signingScript.indexOf('PlugIns/SliccFileProvider.appex');
    const outer = signingScript.lastIndexOf('--entitlements "$ENTITLEMENTS"');
    expect(appex).toBeGreaterThanOrEqual(0);
    expect(appex).toBeLessThan(outer);
  });
});