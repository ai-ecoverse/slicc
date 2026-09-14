import { SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';
import type { ChildProcess } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { cp, mkdir, readFile, readlink, rm, unlink, writeFile } from 'fs/promises';
import { request as httpRequest } from 'http';
import { homedir, platform as osPlatform, tmpdir } from 'os';
import { dirname, join } from 'path';

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

type JsonObject = { [key: string]: unknown };

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
  const explicit = env.SLICC_USER_DATA_DIR?.trim();
  if (explicit) return explicit;
  const suffix = servePort && servePort !== 5710 ? `-${servePort}` : '';
  return join(profilesDir, `${DEFAULT_USER_DATA_DIR_NAME}${suffix}`);
}

export function legacyChromeCandidates(
  profileDirName: string,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const bases = new Set<string>();
  if (env['TMPDIR']) bases.add(env['TMPDIR']);
  bases.add('/tmp');
  return [...bases].map((b) => join(b, profileDirName));
}

const PROFILE_MIGRATION_MARKER = '.profile-migration-complete';

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

    '--disable-blink-features=AutomationControlled',

    '--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets,IntensiveWakeUpThrottling,HighEfficiencyModeAvailable,InfiniteTabsFreezing,InfiniteTabsFreezingOnMemoryPressure,CPUMeasurementInFreezingPolicy,MemoryMeasurementInFreezingPolicy,AllowDevtoolsConnectedDiscard',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
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
      '--font-render-hinting=none'
    );
  }

  args.push(options.launchUrl);
  return args;
}

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

  usesLaunchServices: boolean;
}

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

function resolveMacAppBundle(
  appPath: string,
  platform: NodeJS.Platform,
  existsSyncImpl: typeof existsSync
): string | null {
  if (platform !== 'darwin' || !appPath.endsWith('.app')) return null;

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

export function parseCdpPortFromStderr(line: string): number | null {
  const match = line.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
  if (!match) return null;
  const port = Number.parseInt(match[1]!, 10);
  return Number.isFinite(port) && port > 0 ? port : null;
}

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

export async function clearStaleDevToolsActivePort(userDataDir: string): Promise<void> {
  try {
    await unlink(join(userDataDir, 'DevToolsActivePort'));
  } catch {}
}

export async function clearChromeRestoreState(userDataDir: string): Promise<void> {
  const prefsPath = join(userDataDir, 'Default', 'Preferences');
  let raw: string;
  try {
    raw = await readFile(prefsPath, 'utf8');
  } catch {
    return;
  }
  let prefs: JsonObject;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isJsonObject(parsed)) return;
    prefs = parsed;
  } catch {
    return;
  }
  const profile = ensureObject(prefs, 'profile');
  if (profile['exit_type'] === 'Normal' && profile['exited_cleanly'] === true) {
    return;
  }
  profile['exit_type'] = 'Normal';
  profile['exited_cleanly'] = true;
  try {
    await writeJsonFile(prefsPath, prefs);
  } catch {}
}

const hostedLeaderHost = new URL(SLICC_HOSTED_ORIGIN).hostname;

export const TAB_LIFECYCLE_EXEMPT_SITES = [
  hostedLeaderHost,
  hostedLeaderHost.replace(/^www\./, ''),
  'localhost',
];

export async function seedChromeProfilePreferences(userDataDir: string): Promise<void> {
  const prefsPath = join(userDataDir, 'Default', 'Preferences');
  try {
    const prefs = await readJsonFile(prefsPath);
    prefs['tab_freezing_enabled'] = false;
    const performanceTuning = ensureObject(prefs, 'performance_tuning');
    const highEfficiencyMode = ensureObject(performanceTuning, 'high_efficiency_mode');
    highEfficiencyMode['state'] = 0;
    const tabDiscarding = ensureObject(performanceTuning, 'tab_discarding');
    const existing = tabDiscarding['exceptions'];
    const exceptions = Array.isArray(existing) ? existing.filter((e) => typeof e === 'string') : [];
    for (const site of TAB_LIFECYCLE_EXEMPT_SITES) {
      if (!exceptions.includes(site)) exceptions.push(site);
    }
    tabDiscarding['exceptions'] = exceptions;
    await writeJsonFile(prefsPath, prefs);
  } catch {}
}

export async function clearChromeSessionRestore(userDataDir: string): Promise<void> {
  const defaultDir = join(userDataDir, 'Default');
  try {
    await rm(join(defaultDir, 'Sessions'), { recursive: true, force: true });
  } catch {}
  for (const name of ['Last Session', 'Last Tabs']) {
    try {
      await unlink(join(defaultDir, name));
    } catch {}
  }
}

export interface ProfileChromeTerminationDeps {
  readlinkImpl?: (path: string) => Promise<string>;
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

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
    pid = null;
  }

  if (pid !== null && isAlive(pid)) {
    try {
      kill(pid, 'SIGTERM');
    } catch {}
    for (let i = 0; i < 30 && isAlive(pid); i++) {
      await sleep(100);
    }
    if (isAlive(pid)) {
      try {
        kill(pid, 'SIGKILL');
      } catch {}
    }
  }

  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      await unlink(join(userDataDir, name));
    } catch {}
  }
}

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
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ProbeCdpAliveOptions {
  timeoutMs?: number;

  expectedWebSocketPath?: string | null;
}

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

function parseDevToolsActivePort(contents: string): { port: number; wsPath: string | null } | null {
  const lines = contents.split('\n');
  const firstLine = lines[0]?.trim();
  if (!firstLine) return null;
  const port = Number.parseInt(firstLine, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  const secondLine = lines[1]?.trim();
  return { port, wsPath: secondLine?.startsWith('/') ? secondLine : null };
}

async function readDevToolsActivePort(
  path: string
): Promise<{ port: number; wsPath: string | null } | null> {
  try {
    return parseDevToolsActivePort(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

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

        const alive = await verifyCandidatePort(verifyPort, candidate.port, candidate.wsPath);
        if (settled) return;
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

export function waitForCdpPort(
  child: ChildProcess,
  options: {
    userDataDir?: string;
    timeoutMs?: number;

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

  stderrPromise.catch(() => {});
  filePromise.catch(() => {});
  return Promise.any([stderrPromise, filePromise]).catch((agg: AggregateError) => {
    const first = agg.errors[0];
    throw first instanceof Error ? first : new Error(String(first));
  });
}
