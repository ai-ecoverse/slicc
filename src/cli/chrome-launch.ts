import { existsSync, readdirSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { ChildProcess } from 'child_process';

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

export function resolveDefaultChromeUserDataDir(tmpDir = process.env['TMPDIR'] ?? '/tmp'): string {
  return join(tmpDir, DEFAULT_USER_DATA_DIR_NAME);
}

export function resolveChromeLaunchProfile(options: {
  projectRoot: string;
  tmpDir?: string | null;
  profile?: string | null;
}): ChromeLaunchProfile {
  const profile = normalizeProfileName(options.profile);
  if (!profile) {
    return {
      id: null,
      displayName: 'Chrome',
      userDataDir: resolveDefaultChromeUserDataDir(options.tmpDir ?? undefined),
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
}): string[] {
  const args = [
    `--remote-debugging-port=${options.cdpPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${options.profile.userDataDir}`,
  ];

  if (options.profile.extensionPath) {
    args.push(`--disable-extensions-except=${options.profile.extensionPath}`);
    args.push(`--load-extension=${options.profile.extensionPath}`);
  }

  args.push(options.launchUrl);
  return args;
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
 */
export function waitForCdpPortFromStderr(child: ChildProcess, timeoutMs = 15000): Promise<number> {
  return new Promise((resolve, reject) => {
    if (!child.stderr) {
      reject(new Error('Chrome process has no stderr stream'));
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Timed out waiting for Chrome CDP port (${timeoutMs}ms)`));
      }
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      if (settled) return;
      const text = chunk.toString('utf-8');
      // stderr may deliver multiple lines in one chunk
      for (const line of text.split('\n')) {
        const port = parseCdpPortFromStderr(line);
        if (port !== null) {
          settled = true;
          clearTimeout(timer);
          child.stderr!.off('data', onData);
          resolve(port);
          return;
        }
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
