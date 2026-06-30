import type { ChildProcess } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { cp, mkdir, readFile, readlink, rm, unlink, writeFile } from 'fs/promises';
import { request as httpRequest } from 'http';
import { homedir, platform as osPlatform, tmpdir } from 'os';
import { dirname, join } from 'path';

/**
 * Default startup timeout for Chrome's CDP listener. Overridable via the
 * `SLICC_CDP_LAUNCH_TIMEOUT_MS` environment variable so cold/contended CI
 * runners can give Chrome a longer cold-start window without code changes.
 */
export const DEFAULT_CDP_LAUNCH_TIMEOUT_MS = 15000;

export function getDefaultCdpLaunchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SLICC_CDP_LAUNCH_TIMEOUT_MS;
  if (!raw) return DEFAULT_CDP_LAUNCH_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CDP_LAUNCH_TIMEOUT_MS;
  return parsed;
}

export const CLI_PROFILE_NAMES = ['leader', 'follower', 'extension'] as const;
export type CliProfileName = (typeof CLI_PROFILE_NAMES)[number];

const DEFAULT_USER_DATA_DIR_NAME = 'browser-coding-agent-chrome';
const QA_PROFILE_ROOT_SEGMENTS = ['.qa', 'chrome'] as const;

interface CliProfileDefinition {
  displayName: string;
  avatarIndex: number;
  avatarIcon: string;
  profileColorSeed: number;
  profileHighlightColor: number;
  loadsExtension: boolean;
}

export interface ChromeLaunchProfile {
  id: CliProfileName | null;
  displayName: string;
  userDataDir: string;
  extensionPath: string | null;
}

interface FindChromeExecutableOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  existsSyncImpl?: typeof existsSync;
  readdirSyncImpl?: typeof readdirSync;
  executablePreference?: 'chrome-for-testing' | 'installed';
}

type ChromeExecutablePreference = NonNullable<FindChromeExecutableOptions['executablePreference']>;

type JsonObject = Record<string, unknown>;

function argbToSignedInt(argbHex: number): number {
  return argbHex | 0;
}

const CLI_PROFILE_DEFINITIONS: Record<CliProfileName, CliProfileDefinition> = {
  leader: {
    displayName: 'SLICC QA Leader',
    avatarIndex: 0,
    avatarIcon: 'chrome://theme/IDR_PROFILE_AVATAR_0',
    profileColorSeed: argbToSignedInt(0xff4285f4),
    profileHighlightColor: argbToSignedInt(0xff4285f4),
    loadsExtension: false,
  },
  follower: {
    displayName: 'SLICC QA Follower',
    avatarIndex: 7,
    avatarIcon: 'chrome://theme/IDR_PROFILE_AVATAR_7',
    profileColorSeed: argbToSignedInt(0xff34a853),
    profileHighlightColor: argbToSignedInt(0xff34a853),
    loadsExtension: false,
  },
  extension: {
    displayName: 'SLICC QA Extension',
    avatarIndex: 19,
    avatarIcon: 'chrome://theme/IDR_PROFILE_AVATAR_19',
    profileColorSeed: argbToSignedInt(0xffa142f4),
    profileHighlightColor: argbToSignedInt(0xffa142f4),
    loadsExtension: true,
  },
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureObject(parent: JsonObject, key: string): JsonObject {
  const existing = parent[key];
  if (isJsonObject(existing)) return existing;
  const next: JsonObject = {};
  parent[key] = next;
  return next;
}

function normalizeProfileName(profile: string | null | undefined): string | null {
  const trimmed = profile?.trim();
  return trimmed ? trimmed : null;
}

export function isCliProfileName(value: string | null | undefined): value is CliProfileName {
  return (CLI_PROFILE_NAMES as readonly string[]).includes(value ?? '');
}

export function resolveQaProfilesRoot(projectRoot: string): string {
  return join(projectRoot, ...QA_PROFILE_ROOT_SEGMENTS);
}

export function resolveProfilesDir(
  platform: NodeJS.Platform = osPlatform(),
  homeDir: string = homedir(),
  env: NodeJS.ProcessEnv = process.env
): string {
  if (platform === 'darwin') {
    return join(homeDir, 'Library', 'Application Support', 'Slicc', 'profiles');
  }
  if (platform === 'linux') {
    const xdgState = env['XDG_STATE_HOME'] ?? join(homeDir, '.local', 'state');
    return join(xdgState, 'slicc', 'profiles');
  }
  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'] ?? join(homeDir, 'AppData', 'Local');
    return join(localAppData, 'Slicc', 'profiles');
  }
  return tmpdir();
}

export function resolveDefaultChromeUserDataDir(
  profilesDir = resolveProfilesDir(),
  servePort?: number,
  env: NodeJS.ProcessEnv = process.env
): string {
  // Explicit override — e.g. SLICC_USER_DATA_DIR=$(mktemp -d) for a
  // guaranteed-fresh profile without touching production data.
  const explicit = env.SLICC_USER_DATA_DIR?.trim();
  if (explicit) return explicit;
  const suffix = servePort && servePort !== 5710 ? `-${servePort}` : '';
  return join(profilesDir, `${DEFAULT_USER_DATA_DIR_NAME}${suffix}`);
}

/**
 * Builds the ordered list of legacy candidate paths to check during migration.
 * Checks $TMPDIR first (the macOS per-user temp dir used by terminal sessions),
 * then /tmp (the fallback used by GUI apps that don't inherit TMPDIR).
 * Also includes the previous ~/.slicc/profiles location so existing installs
 * are migrated to the platform-appropriate directory on first run.
 */
export function legacyChromeCandidates(
  profileDirName: string,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const bases = new Set<string>();
  if (env['TMPDIR']) bases.add(env['TMPDIR']);
  bases.add('/tmp');
  return [...bases].map((b) => join(b, profileDirName));
}

/** Sentinel written into the profiles directory once legacy migration has run. */
const PROFILE_MIGRATION_MARKER = '.profile-migration-complete';

/**
 * One-time migration: if `newDir` doesn't exist yet, copies the first matching
 * candidate (legacy profile from $TMPDIR or /tmp) to the stable new location.
 * Non-destructive — the old profile is left in place.
 *
 * Runs at most once ever, gated by a marker file in the profiles directory
 * (the parent of `newDir`). Because the marker lives beside the profile rather
 * than inside it, deleting the profile for a clean state does NOT re-trigger
 * migration — only deleting the whole profiles directory re-arms it.
 */
export async function migrateLegacyDefaultChromeProfile(
  newDir: string,
  candidates: string[]
): Promise<void> {
  const profilesDir = dirname(newDir);
  const marker = join(profilesDir, PROFILE_MIGRATION_MARKER);
  if (existsSync(marker)) return;

  if (!existsSync(newDir)) {
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        try {
          await cp(candidate, newDir, { recursive: true });
          console.log(`Migrated Chrome profile: ${candidate} → ${newDir}`);
        } catch (err) {
          await rm(newDir, { recursive: true, force: true }).catch(() => {});
          console.warn(
            `Chrome profile migration failed (${candidate} → ${newDir}); continuing with a fresh profile.`,
            err
          );
        }
        break;
      }
    }
  }

  // Record that migration has been evaluated so it never resurrects a profile
  // the user deliberately deleted. Best-effort: a failure here just means the
  // (idempotent) check runs again next boot.
  await mkdir(profilesDir, { recursive: true }).catch(() => {});
  await writeFile(marker, '').catch(() => {});
}

export function resolveChromeLaunchProfile(options: {
  projectRoot: string;
  tmpDir?: string | null;
  profile?: string | null;
  servePort?: number;
}): ChromeLaunchProfile {
  const profile = normalizeProfileName(options.profile);
  if (!profile) {
    return {
      id: null,
      displayName: 'Chrome',
      userDataDir: resolveDefaultChromeUserDataDir(options.tmpDir ?? undefined, options.servePort),
      extensionPath: null,
    };
  }

  if (!isCliProfileName(profile)) {
    throw new Error(
      `Unknown Chrome profile "${profile}". Supported values: ${CLI_PROFILE_NAMES.join(', ')}.`
    );
  }

  const definition = CLI_PROFILE_DEFINITIONS[profile];
  return {
    id: profile,
    displayName: definition.displayName,
    userDataDir: join(resolveQaProfilesRoot(options.projectRoot), profile),
    extensionPath: definition.loadsExtension
      ? join(options.projectRoot, 'dist', 'extension')
      : null,
  };
}

export function buildChromeLaunchArgs(options: {
  cdpPort: number;
  launchUrl: string;
  profile: ChromeLaunchProfile;
  hosted?: boolean;
}): string[] {
  const args = [
    `--remote-debugging-port=${options.cdpPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    '--disable-background-tracing',
    // Suppress the `navigator.webdriver` flag that Chrome sets whenever
    // `--remote-debugging-port` is on. Slicc isn't a test harness — the
    // user is sitting in front of the browser — but Cloudflare Turnstile,
    // accounts.x.ai, hCaptcha, and a long tail of bot-detection scripts
    // treat `navigator.webdriver === true` as an instant block signal.
    // See https://crbug.com/1052084 (Chromium's tracking issue for this
    // misuse). Setting it via `--disable-blink-features=AutomationControlled`
    // is the canonical mitigation.
    '--disable-blink-features=AutomationControlled',
    `--user-data-dir=${options.profile.userDataDir}`,
  ];

  if (options.profile.extensionPath) {
    args.push(`--disable-extensions-except=${options.profile.extensionPath}`);
    args.push(`--load-extension=${options.profile.extensionPath}`);
  }

  if (options.hosted) {
    args.push(
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none',
      // Chromium 149+ blocks mixed-content fetch from the HTTPS hosted origin
      // (sliccy.ai) to http://localhost:5710 (the local node-server). The page
      // needs this to POST /api/cloud-status which signals boot readiness.
      '--allow-running-insecure-content'
    );
  }

  args.push(options.launchUrl);
  return args;
}

/**
 * Walk up from a Chrome executable path
 * (`…/Foo.app/Contents/MacOS/Foo`) to its enclosing `.app` bundle so we
 * can hand it to `/usr/bin/open -a`. Returns `null` on non-darwin
 * platforms or bare-binary paths so the caller falls back to a direct
 * exec (Linux/Windows have no LaunchServices equivalent).
 */
export function resolveChromeAppBundle(
  executablePath: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (platform !== 'darwin') return null;
  const parts = executablePath.split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]?.toLowerCase().endsWith('.app')) {
      return parts.slice(0, i + 1).join('/');
    }
  }
  return null;
}

export interface ChromeSpawnPlan {
  command: string;
  args: string[];
  /**
   * `true` when the spawn is routed through `/usr/bin/open` so
   * LaunchServices owns the new Chrome process. The caller should rely
   * on `DevToolsActivePort` for CDP port discovery in this mode because
   * `open`'s stderr never carries Chrome's `DevTools listening on …`
   * banner.
   */
  usesLaunchServices: boolean;
}

/**
 * Decide how to spawn Chrome so macOS TCC attributes camera/microphone
 * requests to Chrome itself rather than to whatever terminal launched
 * `node`. On darwin, when we can resolve an enclosing `.app` bundle for
 * the Chrome executable, route the spawn through
 * `/usr/bin/open -n -a <bundle> -W --args …` so LaunchServices becomes
 * Chrome's parent and TCC responsible process. Without this hop,
 * `getUserMedia()` calls in Google Meet, Zoom, etc. hang forever on
 * machines where the terminal app has never been granted camera/mic
 * access (or has no `NS{Camera,Microphone}UsageDescription`).
 *
 * On Linux / Windows, fall back to a direct exec — neither platform has
 * a LaunchServices equivalent, and they don't suffer the same TCC
 * inheritance problem.
 */
export function planChromeSpawn(options: {
  executablePath: string;
  chromeArgs: string[];
  platform?: NodeJS.Platform;
}): ChromeSpawnPlan {
  const platform = options.platform ?? process.platform;
  const bundle = resolveChromeAppBundle(options.executablePath, platform);
  if (bundle) {
    return {
      command: '/usr/bin/open',
      args: ['-n', '-a', bundle, '-W', '--args', ...options.chromeArgs],
      usesLaunchServices: true,
    };
  }
  return {
    command: options.executablePath,
    args: options.chromeArgs,
    usesLaunchServices: false,
  };
}

function findPuppeteerChromeForTesting(
  options: Required<
    Pick<FindChromeExecutableOptions, 'platform' | 'homeDir' | 'existsSyncImpl' | 'readdirSyncImpl'>
  >
): string | null {
  const cacheRoot = join(options.homeDir, '.cache', 'puppeteer', 'chrome');

  let entries: string[];
  try {
    entries = options.readdirSyncImpl(cacheRoot);
  } catch {
    return null;
  }

  const prefix =
    options.platform === 'darwin'
      ? /^mac/i
      : options.platform === 'linux'
        ? /^linux/i
        : options.platform === 'win32'
          ? /^win/i
          : null;
  if (!prefix) return null;

  const executableSuffixes =
    options.platform === 'darwin'
      ? [
          join(
            'chrome-mac-arm64',
            'Google Chrome for Testing.app',
            'Contents',
            'MacOS',
            'Google Chrome for Testing'
          ),
          join(
            'chrome-mac-x64',
            'Google Chrome for Testing.app',
            'Contents',
            'MacOS',
            'Google Chrome for Testing'
          ),
        ]
      : options.platform === 'linux'
        ? [join('chrome-linux64', 'chrome'), join('chrome-linux', 'chrome')]
        : [join('chrome-win64', 'chrome.exe'), join('chrome-win32', 'chrome.exe')];

  const sortedEntries = entries
    .filter((entry) => prefix.test(entry))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));

  for (const entry of sortedEntries) {
    for (const suffix of executableSuffixes) {
      const candidate = join(cacheRoot, entry, suffix);
      if (options.existsSyncImpl(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

/**
 * On macOS, if a path points to a `.app` bundle, resolve it to the inner
 * `Contents/MacOS/<name>` executable. Returns `null` if the path is not a
 * `.app` bundle or the inner executable does not exist.
 */
function resolveMacAppBundle(
  appPath: string,
  platform: NodeJS.Platform,
  existsSyncImpl: typeof existsSync
): string | null {
  if (platform !== 'darwin' || !appPath.endsWith('.app')) return null;
  // Derive the binary name from the bundle name:
  // "Google Chrome.app" → "Google Chrome"
  const bundleName = appPath
    .split('/')
    .pop()!
    .replace(/\.app$/, '');
  const candidate = join(appPath, 'Contents', 'MacOS', bundleName);
  return existsSyncImpl(candidate) ? candidate : null;
}

function findInstalledChrome(
  options: Required<Pick<FindChromeExecutableOptions, 'env' | 'platform' | 'existsSyncImpl'>>
): string | null {
  const candidates: Record<string, string[]> = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ],
    win32: [
      `${options.env['LOCALAPPDATA']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${options.env['PROGRAMFILES']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${options.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
  };

  for (const candidate of candidates[options.platform] ?? []) {
    if (candidate && options.existsSyncImpl(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function findChromeExecutable(options: FindChromeExecutableOptions = {}): string | null {
  const env = options.env ?? process.env;
  const existsSyncImpl = options.existsSyncImpl ?? existsSync;
  const readdirSyncImpl = options.readdirSyncImpl ?? readdirSync;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const executablePreference: ChromeExecutablePreference =
    options.executablePreference ?? 'chrome-for-testing';

  const envPath = env['CHROME_PATH'];
  if (envPath && existsSyncImpl(envPath)) {
    const resolved = resolveMacAppBundle(envPath, platform, existsSyncImpl);
    return resolved ?? envPath;
  }

  const installedChrome = findInstalledChrome({
    env,
    platform,
    existsSyncImpl,
  });

  const chromeForTesting = findPuppeteerChromeForTesting({
    platform,
    homeDir,
    existsSyncImpl,
    readdirSyncImpl,
  });

  return executablePreference === 'installed'
    ? (installedChrome ?? chromeForTesting)
    : (chromeForTesting ?? installedChrome);
}

async function readJsonFile(filePath: string): Promise<JsonObject> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeJsonFile(filePath: string, value: JsonObject): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seedLocalState(localState: JsonObject, definition: CliProfileDefinition): JsonObject {
  const browser = ensureObject(localState, 'browser');
  browser['check_default_browser'] = false;
  browser['has_seen_welcome_page'] = true;

  const profile = ensureObject(localState, 'profile');
  profile['last_used'] = 'Default';
  profile['picker_shown'] = true;
  profile['profiles_order'] = ['Default'];
  profile['last_active_profiles'] = ['Default'];

  const infoCache = ensureObject(profile, 'info_cache');
  const defaultProfile = ensureObject(infoCache, 'Default');
  defaultProfile['name'] = definition.displayName;
  defaultProfile['avatar_icon'] = definition.avatarIcon;
  defaultProfile['is_using_default_name'] = false;
  defaultProfile['is_using_default_avatar'] = true;
  defaultProfile['profile_color_seed'] = definition.profileColorSeed;
  defaultProfile['profile_highlight_color'] = definition.profileHighlightColor;

  return localState;
}

function seedPreferences(preferences: JsonObject, definition: CliProfileDefinition): JsonObject {
  const profile = ensureObject(preferences, 'profile');
  profile['name'] = definition.displayName;
  profile['avatar_index'] = definition.avatarIndex;
  profile['using_default_name'] = false;
  profile['using_default_avatar'] = true;

  const browser = ensureObject(preferences, 'browser');
  browser['has_seen_welcome_page'] = true;

  const bookmarkBar = ensureObject(preferences, 'bookmark_bar');
  bookmarkBar['show_on_all_tabs'] = false;

  const signin = ensureObject(preferences, 'signin');
  signin['allowed'] = false;

  return preferences;
}

export async function ensureQaProfileScaffold(projectRoot: string): Promise<ChromeLaunchProfile[]> {
  const profiles = CLI_PROFILE_NAMES.map((profileName) =>
    resolveChromeLaunchProfile({ projectRoot, profile: profileName })
  );

  for (const profile of profiles) {
    const definition = CLI_PROFILE_DEFINITIONS[profile.id!];
    await mkdir(join(profile.userDataDir, 'Default'), { recursive: true });
    await writeFile(join(profile.userDataDir, 'First Run'), '', 'utf8');

    const localStatePath = join(profile.userDataDir, 'Local State');
    const preferencesPath = join(profile.userDataDir, 'Default', 'Preferences');
    const localState = seedLocalState(await readJsonFile(localStatePath), definition);
    const preferences = seedPreferences(await readJsonFile(preferencesPath), definition);

    await writeJsonFile(localStatePath, localState);
    await writeJsonFile(preferencesPath, preferences);
  }

  return profiles;
}

// ---------------------------------------------------------------------------
// CDP port parsing — extract actual port from Chrome's stderr output
// ---------------------------------------------------------------------------

/**
 * Parse the CDP port from a Chrome stderr line.
 * Chrome prints `DevTools listening on ws://HOST:PORT/devtools/browser/ID`
 * to stderr when it starts. Returns the port number, or null if the line
 * doesn't match.
 */
export function parseCdpPortFromStderr(line: string): number | null {
  const match = line.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
  if (!match) return null;
  const port = Number.parseInt(match[1]!, 10);
  return Number.isFinite(port) && port > 0 ? port : null;
}

/**
 * Watch a Chrome child process's stderr for the `DevTools listening on` line
 * and resolve with the actual CDP port. Rejects after `timeoutMs` if the line
 * never appears (e.g. Chrome failed to start).
 *
 * Buffers across chunk boundaries: stderr data events split on arbitrary
 * byte boundaries (not on newlines), so the original "split each chunk by
 * \n and regex each line" approach silently dropped the DevTools line
 * whenever it spanned two chunks. We accumulate a rolling buffer and only
 * parse complete lines (everything before the last `\n`); the trailing
 * partial line is carried forward to the next chunk.
 */
export function waitForCdpPortFromStderr(
  child: ChildProcess,
  timeoutMs: number = getDefaultCdpLaunchTimeoutMs()
): Promise<number> {
  return new Promise((resolve, reject) => {
    if (!child.stderr) {
      reject(new Error('Chrome process has no stderr stream'));
      return;
    }

    let settled = false;
    let buffer = '';
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Timed out waiting for Chrome CDP port (${timeoutMs}ms)`));
      }
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString('utf-8');
      // Parse all complete lines; keep the trailing partial in the buffer.
      let nlIdx = buffer.indexOf('\n');
      while (nlIdx !== -1) {
        const line = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        const port = parseCdpPortFromStderr(line);
        if (port !== null) {
          settled = true;
          clearTimeout(timer);
          child.stderr!.off('data', onData);
          resolve(port);
          return;
        }
        nlIdx = buffer.indexOf('\n');
      }
      // Also try parsing the trailing partial: Chrome's DevTools line is
      // typically flushed with a newline, but if the process exits before
      // the newline reaches us we still want to recover the port. This is
      // a no-op for normal traffic since `parseCdpPortFromStderr` requires
      // a trailing `/` in the regex, which precedes the newline anyway.
      const tailPort = parseCdpPortFromStderr(buffer);
      if (tailPort !== null) {
        settled = true;
        clearTimeout(timer);
        child.stderr!.off('data', onData);
        resolve(tailPort);
      }
    };

    child.stderr.on('data', onData);

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Chrome exited with code ${code} before reporting CDP port`));
      }
    });
  });
}

/**
 * Delete a stale `<userDataDir>/DevToolsActivePort` left behind by a
 * previous Chrome run before we spawn a new one. Otherwise
 * `waitForCdpPortFromActivePortFile` can win the race instantly with the
 * old port from a crashed / SIGKILL'd previous launch — Chrome only
 * writes the file when its listener comes up, and never proactively
 * clears it on shutdown. The file lives inside a profile directory that
 * is reused across runs (both the dev `/tmp/browser-coding-agent-chrome`
 * profile and the persistent `.qa/chrome/<profile>` QA profiles), so the
 * stale-port window is real.
 *
 * ENOENT is fine (no previous run); other errors are swallowed too
 * because a failure to unlink shouldn't block a launch — the worst case
 * is the pre-existing stale-port behavior, which is what we want to
 * avoid but is not worth crashing over.
 */
export async function clearStaleDevToolsActivePort(userDataDir: string): Promise<void> {
  try {
    await unlink(join(userDataDir, 'DevToolsActivePort'));
  } catch {
    // Intentionally ignored — see docstring.
  }
}

/**
 * Clear Chrome's "did not exit cleanly" flags so the next launch does NOT
 * restore the previous session's tabs (or pop the crash-restore bubble).
 *
 * `npm run dev` is almost always stopped with Ctrl-C, which terminates the
 * launched Chrome without a graceful shutdown. Chrome then records
 * `profile.exit_type: "Crashed"` in `Default/Preferences` and, on the next
 * launch against the same persistent profile, reopens the prior session's
 * tabs. With the standalone single-client CDP proxy that is actively
 * harmful: a *restored* duplicate webapp tab and the freshly-launched tab
 * both dial `ws://<host>/cdp`, and because the proxy keeps only one client
 * they evict each other in an endless ~5s reconnect war (each evicted page
 * re-dials on the next leader-target refresh).
 *
 * Rewriting `exit_type` to `"Normal"` (and `exited_cleanly` to `true`) — the
 * same trick ChromeDriver uses — before spawn makes Chrome believe the last
 * session ended cleanly, so it starts fresh with a single tab.
 *
 * Best-effort and idempotent: a missing Preferences file (first run) is left
 * absent — there is nothing to restore — and an unparseable one is left as-is
 * for Chrome to regenerate. Never throws; a failure here must not block a
 * launch.
 */
export async function clearChromeRestoreState(userDataDir: string): Promise<void> {
  const prefsPath = join(userDataDir, 'Default', 'Preferences');
  let raw: string;
  try {
    raw = await readFile(prefsPath, 'utf8');
  } catch {
    return; // no Preferences yet (first run) — nothing to restore
  }
  let prefs: JsonObject;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isJsonObject(parsed)) return;
    prefs = parsed;
  } catch {
    return; // corrupt file — leave it for Chrome to regenerate
  }
  const profile = ensureObject(prefs, 'profile');
  if (profile['exit_type'] === 'Normal' && profile['exited_cleanly'] === true) {
    return; // already clean — avoid a needless rewrite
  }
  profile['exit_type'] = 'Normal';
  profile['exited_cleanly'] = true;
  try {
    await writeJsonFile(prefsPath, prefs);
  } catch {
    // Best-effort — a write failure just leaves the prior restore behavior.
  }
}

/**
 * Remove Chrome's session-restore snapshot so a relaunch opens ONLY the
 * command-line tab instead of also reopening the previous window's tabs.
 *
 * The dev launcher passes the UI URL on the command line, but Chrome ALSO
 * restores `Default/Sessions/` from the prior run — so every `npm run dev` was
 * adding a tab. `exit_type` only governs the *crash* bubble, not this; the fix
 * is to drop the snapshot. Run before every spawn (like
 * {@link clearStaleDevToolsActivePort}). Cookies / localStorage / IndexedDB
 * live elsewhere and are untouched. Best-effort.
 *
 * Modern Chrome keeps the whole snapshot under `Default/Sessions/`; `Last
 * Session` / `Last Tabs` are belt-and-suspenders for older Chromium builds that
 * still wrote those two as top-level files under `Default/`.
 */
export async function clearChromeSessionRestore(userDataDir: string): Promise<void> {
  const defaultDir = join(userDataDir, 'Default');
  try {
    await rm(join(defaultDir, 'Sessions'), { recursive: true, force: true });
  } catch {
    // ignore
  }
  for (const name of ['Last Session', 'Last Tabs']) {
    try {
      await unlink(join(defaultDir, name));
    } catch {
      // ignore (missing)
    }
  }
}

/** Injectable seams for {@link terminateExistingProfileChrome} (tests). */
export interface ProfileChromeTerminationDeps {
  readlinkImpl?: (path: string) => Promise<string>;
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Terminate a Chrome instance still holding this `user-data-dir`, then clear
 * the stale Singleton lock files, so a fresh launch isn't refused.
 *
 * Chrome is single-instance per profile: a second `open -n` against a locked
 * profile either exits non-zero ("Chrome exited … before reporting CDP port")
 * or silently adds a tab to the running instance. On macOS the launcher starts
 * Chrome via LaunchServices, so it isn't our child and Ctrl-C never reaps it —
 * a leftover Chrome lingers across `npm run dev` runs. Chrome records the
 * owning PID in the `SingletonLock` symlink (`<host>-<pid>`); if that process
 * is alive we stop it (SIGTERM, then SIGKILL), then unlink the Singleton lock
 * files. Best-effort and idempotent; a missing lock is a no-op.
 */
export async function terminateExistingProfileChrome(
  userDataDir: string,
  deps: ProfileChromeTerminationDeps = {}
): Promise<void> {
  const readlinkImpl = deps.readlinkImpl ?? readlink;
  const isAlive = deps.isAlive ?? defaultPidIsAlive;
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let pid: number | null = null;
  try {
    pid = parseSingletonLockPid(await readlinkImpl(join(userDataDir, 'SingletonLock')));
  } catch {
    pid = null; // no SingletonLock — nothing holding the profile
  }

  if (pid !== null && isAlive(pid)) {
    try {
      kill(pid, 'SIGTERM');
    } catch {
      // already gone between the alive-check and the signal
    }
    for (let i = 0; i < 30 && isAlive(pid); i++) {
      await sleep(100);
    }
    if (isAlive(pid)) {
      try {
        kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  }

  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      await unlink(join(userDataDir, name));
    } catch {
      // ignore (missing)
    }
  }
}

/**
 * `SingletonLock` is a symlink to `<hostname>-<pid>`. The hostname can contain
 * dashes, so the PID is the segment after the LAST dash.
 */
function parseSingletonLockPid(target: string): number | null {
  const dash = target.lastIndexOf('-');
  if (dash < 0) return null;
  const pid = Number.parseInt(target.slice(dash + 1), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function defaultPidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not signalable by us.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ProbeCdpAliveOptions {
  /** Per-probe HTTP timeout in milliseconds. Default 500 ms. */
  timeoutMs?: number;
  /**
   * When set, additionally require the returned
   * `webSocketDebuggerUrl`'s pathname to equal this value. Used by the
   * `DevToolsActivePort` poller to bind the probe to the *specific* CDP
   * endpoint Chrome wrote into the file (line 2 of the file) so a port
   * later reused by an unrelated Chrome/CDP instance can't be mistaken
   * for ours.
   */
  expectedWebSocketPath?: string | null;
}

/**
 * Single-shot HTTP probe of Chrome's `/json/version` endpoint. Resolves
 * `true` only when the port answers with a 2xx response whose body is
 * valid JSON with a non-empty `webSocketDebuggerUrl` (the CDP fingerprint
 * — won't false-positive on some other HTTP service squatting on the
 * port). When `expectedWebSocketPath` is supplied, the probe additionally
 * requires the URL's pathname to match, so the launcher can't attach to
 * an unrelated live CDP server that just happens to be on the same port
 * a stale `DevToolsActivePort` file pointed at.
 *
 * Contract: **every** failure mode collapses to `Promise<false>`. Out-
 * of-range ports, synchronous `httpRequest` throws (`ERR_SOCKET_BAD_PORT`,
 * `ERR_INVALID_ARG_TYPE`), connection refused, timeouts, oversized
 * bodies, malformed JSON, missing `webSocketDebuggerUrl`, mismatched
 * websocket paths, errors on the response stream — all return `false`.
 * Callers can retry without exception plumbing.
 *
 * Kept small and stdlib-only (`node:http`) to avoid pulling another
 * fetch implementation into the launcher hot path.
 */
export function probeCdpAlive(port: number, options: ProbeCdpAliveOptions = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 500;
  const expectedWebSocketPath = options.expectedWebSocketPath ?? null;
  return new Promise((resolve) => {
    let resolved = false;
    const settle = (alive: boolean) => {
      if (resolved) return;
      resolved = true;
      resolve(alive);
    };

    // Range-check before handing the port to `httpRequest`, which throws
    // synchronously (`ERR_SOCKET_BAD_PORT`) for anything outside 0–65535.
    // A stale or corrupt `DevToolsActivePort` can easily contain
    // out-of-range values, and the contract above promises we never
    // reject in that case.
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      settle(false);
      return;
    }

    let req;
    try {
      req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/json/version',
          method: 'GET',
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            res.resume();
            settle(false);
            return;
          }
          let body = '';
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => {
            body += chunk;
            // Cap the body size — the real /json/version payload is well
            // under 1 KiB, so anything larger is junk from another service.
            if (body.length > 16_384) {
              res.destroy();
              settle(false);
            }
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body) as { webSocketDebuggerUrl?: unknown };
              if (
                typeof parsed.webSocketDebuggerUrl !== 'string' ||
                parsed.webSocketDebuggerUrl.length === 0
              ) {
                settle(false);
                return;
              }
              if (expectedWebSocketPath) {
                // Parse the URL to extract its pathname so we compare
                // apples to apples regardless of host/port differences.
                // Any parse failure collapses to false per contract.
                let actualPath: string;
                try {
                  actualPath = new URL(parsed.webSocketDebuggerUrl).pathname;
                } catch {
                  settle(false);
                  return;
                }
                if (actualPath !== expectedWebSocketPath) {
                  settle(false);
                  return;
                }
              }
              settle(true);
            } catch {
              settle(false);
            }
          });
          res.on('error', () => settle(false));
        }
      );
    } catch {
      // `httpRequest` itself can throw synchronously for invalid option
      // shapes (most commonly out-of-range port). Honor the contract.
      settle(false);
      return;
    }
    req.on('error', () => settle(false));
    req.on('timeout', () => {
      req.destroy();
      settle(false);
    });
    req.end();
  });
}

/**
 * Parse a `DevToolsActivePort` file body into a candidate port + websocket
 * path. Chrome writes the port on line 1 and the WS path on line 2, atomically
 * once the listener is up. A read mid-write yields an empty file, the port-only
 * first line, or a corrupt body — every parse failure returns `null` so the
 * caller falls through to the next poll tick. The port range mirrors
 * `probeCdpAlive`'s guard so we never hand it a value it'd reject anyway.
 */
function parseDevToolsActivePort(contents: string): { port: number; wsPath: string | null } | null {
  const lines = contents.split('\n');
  const firstLine = lines[0]?.trim();
  if (!firstLine) return null;
  const port = Number.parseInt(firstLine, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  const secondLine = lines[1]?.trim();
  return { port, wsPath: secondLine?.startsWith('/') ? secondLine : null };
}

/**
 * Read + parse the `DevToolsActivePort` file. ENOENT before Chrome writes the
 * file (and any other read error) is swallowed to `null` — we'd rather keep
 * polling and let the stderr-scraper path race alongside than reject early.
 */
async function readDevToolsActivePort(
  path: string
): Promise<{ port: number; wsPath: string | null } | null> {
  try {
    return parseDevToolsActivePort(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Run the CDP liveness verifier, treating any rejection — including a rogue
 * custom verifier in tests — as "not alive" rather than aborting the poll loop
 * and hanging discovery indefinitely.
 */
async function verifyCandidatePort(
  verifyPort: (port: number, expectedWebSocketPath: string | null) => Promise<boolean>,
  port: number,
  wsPath: string | null
): Promise<boolean> {
  try {
    return await verifyPort(port, wsPath);
  } catch {
    return false;
  }
}

/**
 * Poll `<userDataDir>/DevToolsActivePort` for the CDP port. Chrome writes
 * this file as soon as the DevTools listener is up — its first line is
 * the port, the second is the websocket path. This is the canonical way
 * Chromium itself recommends discovering the chosen port and is far more
 * reliable than scraping stderr.
 *
 * Validation: before resolving, probe `/json/version` on the discovered
 * port and require the response's `webSocketDebuggerUrl` pathname to
 * match the path Chrome wrote into the file's second line. The file is
 * written by Chrome but reused across runs in the same profile
 * directory, and `clearStaleDevToolsActivePort` is a best-effort unlink
 * that races our spawn. If the probe fails (port refused, wrong CDP
 * instance, anything) we treat the file content as stale and keep
 * polling for either an updated file (the freshly-spawned Chrome about
 * to overwrite it) or the eventual timeout. The pathname comparison
 * specifically guards against the port-reuse case where a stale file
 * points at a port that's now serving an *unrelated* Chrome/CDP
 * instance (different `browser/<uuid>` path).
 *
 * Resolves with the parsed port once both the file content and the
 * live CDP probe succeed. Rejects on timeout or process exit, with
 * the timeout message distinguishing "file never appeared" from "file
 * appeared but its port never answered CDP".
 *
 * @param userDataDir absolute path Chrome was launched with via `--user-data-dir=`
 * @param child       the Chrome child process (used to bail out on early exit)
 * @param timeoutMs   total budget before giving up
 * @param pollMs      polling cadence (default 50ms)
 * @param options     test seam — inject a custom `verifyPort` to avoid
 *                    real network probes in unit tests. The verifier
 *                    receives both the parsed port and the websocket
 *                    path Chrome wrote on line 2 (or `null` if absent).
 */
export function waitForCdpPortFromActivePortFile(
  userDataDir: string,
  child: ChildProcess,
  timeoutMs: number = getDefaultCdpLaunchTimeoutMs(),
  pollMs = 50,
  options: {
    verifyPort?: (port: number, expectedWebSocketPath: string | null) => Promise<boolean>;
  } = {}
): Promise<number> {
  const verifyPort =
    options.verifyPort ??
    ((port: number, expectedWebSocketPath: string | null) =>
      probeCdpAlive(port, { expectedWebSocketPath }));

  return new Promise((resolve, reject) => {
    let settled = false;
    const path = join(userDataDir, 'DevToolsActivePort');
    const startedAt = Date.now();
    // Track whether we ever observed a parseable candidate port so the
    // timeout error can distinguish "file never showed up" from "file
    // was there but its port never answered CDP".
    let sawCandidate = false;
    let lastCandidatePort: number | null = null;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };

    const tick = async (): Promise<void> => {
      if (settled) return;

      const candidate = await readDevToolsActivePort(path);
      if (candidate) {
        sawCandidate = true;
        lastCandidatePort = candidate.port;
        // Verify the file's port actually answers CDP and reports the same
        // websocket path the file claims. A stale file (e.g. from a previous
        // run that crashed before `clearStaleDevToolsActivePort` landed) or a
        // port reused by an unrelated Chrome fails this probe and falls
        // through to the next tick.
        const alive = await verifyCandidatePort(verifyPort, candidate.port, candidate.wsPath);
        if (settled) return; // child exited mid-probe — `child.on('exit')` already rejected.
        if (alive) {
          finish(() => resolve(candidate.port));
          return;
        }
      }

      if (Date.now() - startedAt >= timeoutMs) {
        const message = sawCandidate
          ? `Port ${lastCandidatePort} from DevToolsActivePort at ${path} never answered CDP (${timeoutMs}ms)`
          : `Timed out waiting for DevToolsActivePort at ${path} (${timeoutMs}ms)`;
        finish(() => reject(new Error(message)));
        return;
      }
      setTimeout(() => {
        void tick();
      }, pollMs);
    };

    child.on('exit', (code) => {
      finish(() =>
        reject(new Error(`Chrome exited with code ${code} before writing DevToolsActivePort`))
      );
    });

    void tick();
  });
}

/**
 * Race the stderr scraper and the `DevToolsActivePort` poller. Whichever
 * resolves first wins; the loser is silently ignored. This is the
 * recommended entry point for callers who already have a `--user-data-dir`
 * on hand (which is the usual case in tests and CLI launches).
 */
export function waitForCdpPort(
  child: ChildProcess,
  options: {
    userDataDir?: string;
    timeoutMs?: number;
    /**
     * Test seam — forwarded to `waitForCdpPortFromActivePortFile` so unit
     * tests can simulate the "file says port X, but X isn't actually
     * answering CDP" stale-port race without binding a real socket. The
     * verifier receives both the parsed port and the websocket path
     * Chrome wrote on the file's second line (or `null` when the file
     * was read mid-write and only the port is available).
     */
    verifyPort?: (port: number, expectedWebSocketPath: string | null) => Promise<boolean>;
  } = {}
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? getDefaultCdpLaunchTimeoutMs();
  const stderrPromise = waitForCdpPortFromStderr(child, timeoutMs);
  if (!options.userDataDir) return stderrPromise;
  const filePromise = waitForCdpPortFromActivePortFile(
    options.userDataDir,
    child,
    timeoutMs,
    undefined,
    { verifyPort: options.verifyPort }
  );
  // Suppress unhandled-rejection warnings on the loser.
  stderrPromise.catch(() => {});
  filePromise.catch(() => {});
  return Promise.any([stderrPromise, filePromise]).catch((agg: AggregateError) => {
    // If both legs failed, surface the first error so callers see a
    // meaningful message (timeout / exit) rather than an opaque AggregateError.
    const first = agg.errors[0];
    throw first instanceof Error ? first : new Error(String(first));
  });
}
