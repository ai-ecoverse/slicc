// Pure logic for the iOS PR screenshots job — validation, simulator
// selection, and manifest building — kept free of child_process / fs so
// ios-screenshots.test.mjs can pin the behavior without a simulator.
// The manifest deliberately matches the Storybook screenshots shape
// ({shots: [{file, contentHash, storyId, theme}]}) so the R2 dedup upload
// and sticky-comment steps in the workflow stay interchangeable.

/**
 * Validate the screen registry (packages/ios-app/screenshot-screens.json).
 * Returns the screens array; throws with a message naming every problem so
 * a bad edit fails the job legibly rather than mid-capture.
 */
export function validateScreens(registry) {
  const problems = [];
  const screens = registry?.screens;
  if (!Array.isArray(screens) || screens.length === 0) {
    throw new Error('screenshot-screens.json: "screens" must be a non-empty array');
  }
  const seen = new Set();
  for (const [i, screen] of screens.entries()) {
    const where = `screens[${i}]`;
    if (typeof screen.name !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(screen.name)) {
      problems.push(`${where}: name must be kebab-case (got ${JSON.stringify(screen.name)})`);
    } else if (seen.has(screen.name)) {
      problems.push(`${where}: duplicate name "${screen.name}"`);
    } else {
      seen.add(screen.name);
    }
    if (
      !Array.isArray(screen.args) ||
      screen.args.length === 0 ||
      screen.args.some((a) => typeof a !== 'string')
    ) {
      problems.push(`${where}: args must be a non-empty array of strings`);
    }
    if (
      screen.settleSeconds !== undefined &&
      (typeof screen.settleSeconds !== 'number' || screen.settleSeconds <= 0)
    ) {
      problems.push(`${where}: settleSeconds must be a positive number when present`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`screenshot-screens.json invalid:\n  ${problems.join('\n  ')}`);
  }
  return screens;
}

/**
 * Pick an iPhone from the newest installed iOS runtime out of
 * `simctl list devices available --json` output. Dict order in that JSON is
 * unspecified, so runtimes are version-sorted — an older runtime can fail
 * at app launch (same rationale as docs/ios-simulator-qa.md).
 */
export function pickNewestIPhone(simctlJson) {
  const devices = simctlJson?.devices ?? {};
  const candidates = [];
  for (const [runtime, list] of Object.entries(devices)) {
    const match = runtime.match(/SimRuntime\.iOS-([0-9-]+)$/);
    if (!match) continue;
    const version = match[1].split('-').map(Number);
    const iphones = (list ?? []).filter((d) => d.isAvailable && /iPhone/.test(d.name));
    if (iphones.length > 0) candidates.push({ version, udid: iphones[0].udid });
  }
  candidates.sort((a, b) => {
    for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
      const diff = (a.version[i] ?? 0) - (b.version[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  return candidates.at(-1)?.udid ?? null;
}

/** Screenshot filename for a screen. */
export function screenshotFile(screenName) {
  return `ios-${screenName}.png`;
}

/**
 * Build the manifest consumed by the workflow's upload + comment steps.
 * `hashes` maps screen name → sha256 hex of the captured PNG. `theme` is
 * the field the sticky comment groups by; the app is dark-only today.
 */
export function buildManifest(screens, hashes, { device }) {
  const shots = screens.map((screen) => {
    const contentHash = hashes[screen.name];
    if (!contentHash) throw new Error(`no capture hash for screen "${screen.name}"`);
    return {
      file: screenshotFile(screen.name),
      contentHash,
      storyId: screen.name,
      theme: 'ios',
    };
  });
  return { device, shots };
}
