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