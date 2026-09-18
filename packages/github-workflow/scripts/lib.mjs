export const MAX_DURATION_MS = 350 * 60 * 1000;

export const DEFAULT_FOLLOW_RUNNER = ['bash', '-c'];

export const DEFAULT_PORT = 5710;

export const JOIN_FILE_PATH = '/tmp/slicc-join.json';

export const CONE_CONFIG_PATH = '/slicc/cone-config.json';

export const DEFAULT_INJECT_MAX_BYTES = 64 * 1024 * 1024;

const DURATION_UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

export function parseDuration(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('duration is required (e.g. "30m", "2h", "1h30m")');
  if (/^\d+$/.test(raw)) return checkDuration(Number(raw) * DURATION_UNIT_MS.m, raw);
  const re = /(\d+)\s*(ms|s|m|h)/gy;
  let total = 0;
  let consumed = 0;
  let match = re.exec(raw);
  while (match) {
    total += Number(match[1]) * DURATION_UNIT_MS[match[2]];
    consumed = re.lastIndex;
    match = re.exec(raw);
  }
  if (consumed !== raw.length) throw new Error(`invalid duration "${raw}"`);
  return checkDuration(total, raw);
}

function checkDuration(ms, raw) {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`duration must be positive: "${raw}"`);
  if (ms > MAX_DURATION_MS) {
    throw new Error(
      `duration "${raw}" exceeds the ${MAX_DURATION_MS / 60_000}-minute ceiling of a GitHub job`
    );
  }
  return ms;
}

export function parsePort(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`port must be an integer between 1024 and 65535, got "${raw}"`);
  }
  return port;
}

function hasDotOrEmptySegments(path) {
  return path
    .split('/')
    .slice(1)
    .some((segment) => segment === '' || segment === '.' || segment === '..');
}

export function parseMountLines(text, homeDir = '') {
  const mounts = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const mapping = parseMountMapping(trimmed, homeDir);
    if (!mapping) {
      throw new Error(`mounts line ${index + 1}: expected "<os-path>:<slicc-path>", got "${line}"`);
    }
    if (mounts.some((m) => m.path === mapping.path)) {
      throw new Error(`mounts line ${index + 1}: duplicate SLICC target ${mapping.path}`);
    }
    mounts.push(mapping);
  }
  return mounts;
}

export function parseMountMapping(value, homeDir = '') {
  const trimmed = value.trim();
  const sep = trimmed.lastIndexOf(':');
  if (sep <= 0) return null;
  let hostRaw = trimmed.slice(0, sep).trim();
  const targetRaw = trimmed.slice(sep + 1).trim();
  if (hostRaw === '~' || hostRaw.startsWith('~/')) {
    if (!homeDir) return null;
    hostRaw = homeDir + hostRaw.slice(1);
  }
  const hostPath = normalizeAbsolutePath(hostRaw);
  const path = normalizeAbsolutePath(targetRaw);
  if (!hostPath || !path || path === '/') return null;
  return { hostPath, path };
}

function normalizeAbsolutePath(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) return null;
  const stripped = trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
  if (!stripped || (stripped.length > 1 && hasDotOrEmptySegments(stripped))) return null;
  return stripped;
}

export function buildLeaderArgs(options = {}) {
  const args = ['--hosted'];
  for (const m of options.mounts ?? []) args.push(`--mount=${m.hostPath}:${m.path}`);
  return args;
}

export function buildLeaderEnv(options) {
  const env = {};
  for (const [key, value] of Object.entries(options.base ?? {})) {
    if (value === undefined) continue;
    if (key.startsWith('INPUT_')) continue;
    if (key === 'SLICC_CONE_CONFIG_B64' || key === 'SLICC_SECRETS_ENV_B64') continue;
    env[key] = value;
  }
  env.PORT = String(options.port);
  env.SLICC_SECRETS_FILE = options.secretsFile;
  env.CHROME_USER_DATA_DIR = options.profileDir;
  env.SLICC_CDP_LAUNCH_TIMEOUT_MS = String(options.cdpLaunchTimeoutMs ?? 60_000);
  if (options.uiOrigin) env.WORKER_BASE_URL = options.uiOrigin.replace(/\/+$/, '');
  else delete env.WORKER_BASE_URL;
  if (options.trayWorkerBaseUrl) {
    env.SLICC_TRAY_WORKER_BASE_URL = options.trayWorkerBaseUrl.replace(/\/+$/, '');
  } else {
    delete env.SLICC_TRAY_WORKER_BASE_URL;
  }
  return env;
}

const VALID_EFFORT_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function isStr(v) {
  return typeof v === 'string';
}

function hasNewline(v) {
  return /[\r\n]/.test(v);
}

function optionalStr(obj, key) {
  return isStr(obj[key]) ? { [key]: obj[key] } : {};
}

function validateOAuthAccount(a, where) {
  if (!isStr(a.accessToken) || !a.accessToken) {
    throw new Error(`${where}: oauth account requires accessToken`);
  }
  return {
    providerId: a.providerId,
    kind: 'oauth',
    accessToken: a.accessToken,
    ...optionalStr(a, 'refreshToken'),
    ...(typeof a.tokenExpiresAt === 'number' ? { tokenExpiresAt: a.tokenExpiresAt } : {}),
    ...optionalStr(a, 'userName'),
    ...optionalStr(a, 'baseUrl'),
  };
}

function validateApiKeyAccount(a, where) {
  if (!isStr(a.apiKey) || !a.apiKey) throw new Error(`${where}: apikey account requires apiKey`);
  return {
    providerId: a.providerId,
    kind: 'apikey',
    apiKey: a.apiKey,
    ...optionalStr(a, 'baseUrl'),
    ...optionalStr(a, 'deployment'),
    ...optionalStr(a, 'apiVersion'),
  };
}

function validateAccount(a, index) {
  const where = `cone-config: accounts[${index}]`;
  if (a === null || typeof a !== 'object') throw new Error(`${where} is not an object`);
  if (!isStr(a.providerId) || !a.providerId) throw new Error(`${where}.providerId required`);
  if (a.kind === 'oauth') return validateOAuthAccount(a, where);
  if (a.kind === 'apikey') return validateApiKeyAccount(a, where);
  throw new Error(`${where}.kind must be 'oauth' | 'apikey'`);
}

export function validateSecretEntry(s, where = 'secret') {
  if (s === null || typeof s !== 'object') throw new Error(`${where} is not an object`);
  if (!isStr(s.name) || !SECRET_NAME_RE.test(s.name)) {
    throw new Error(`${where}: name must match ${SECRET_NAME_RE}`);
  }
  if (s.name.startsWith('oauth.')) {
    throw new Error(`${where}: the oauth.* namespace is reserved for OAuth replicas`);
  }
  if (!isStr(s.value) || hasNewline(s.value)) {
    throw new Error(`${where} ${s.name}: value must be a single-line string`);
  }
  if (!Array.isArray(s.domains) || s.domains.length === 0 || !s.domains.every(isStr)) {
    throw new Error(`${where} ${s.name}: domains must be a non-empty string[]`);
  }
  const domains = s.domains.map((d) => d.trim());
  if (domains.some((d) => !d || hasNewline(d) || d.includes(','))) {
    throw new Error(`${where} ${s.name}: domains must be single-line and comma-free`);
  }
  return { name: s.name, value: s.value, domains };
}

export function parseSecretsEnv(text) {
  const values = new Map();
  const order = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) throw new Error(`secrets-env line ${index + 1}: expected NAME=value`);
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (!values.has(name)) order.push(name);
    values.set(name, value);
  }
  const entries = [];
  for (const name of order) {
    if (name.endsWith('_DOMAINS')) continue;
    const domainsRaw = values.get(`${name}_DOMAINS`);
    if (domainsRaw === undefined) {
      throw new Error(
        `secrets-env: ${name} has no ${name}_DOMAINS line (every secret is domain-scoped)`
      );
    }
    const domains = domainsRaw
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    entries.push(validateSecretEntry({ name, value: values.get(name), domains }, 'secrets-env'));
  }
  for (const name of order) {
    if (name.endsWith('_DOMAINS') && !values.has(name.slice(0, -'_DOMAINS'.length))) {
      throw new Error(`secrets-env: ${name} has no matching secret line`);
    }
  }
  return entries;
}

export function serializeSecretsEnv(secrets) {
  const lines = [];
  for (const s of secrets) {
    lines.push(`${s.name}=${s.value}`);
    lines.push(`${s.name}_DOMAINS=${s.domains.join(',')}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function parseBundle(coneConfigJson) {
  const raw = (coneConfigJson ?? '').trim();
  if (!raw) return {};
  let bundle;
  try {
    bundle = JSON.parse(raw);
  } catch (err) {
    throw new Error(`cone-config: not valid JSON (${err instanceof Error ? err.message : err})`);
  }
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('cone-config: must be a JSON object');
  }
  return bundle;
}

function collectSecrets(bundle, secretsEnvText) {
  const secretsRaw = bundle.secrets ?? [];
  if (!Array.isArray(secretsRaw)) throw new Error('cone-config: secrets must be an array');
  const secrets = new Map();
  secretsRaw.forEach((s, i) => {
    const entry = validateSecretEntry(s, `cone-config: secrets[${i}]`);
    secrets.set(entry.name, entry);
  });
  for (const entry of parseSecretsEnv(secretsEnvText ?? '')) secrets.set(entry.name, entry);
  return [...secrets.values()];
}

function mergeApiKeyAccount(accounts, shortcut) {
  const providerId = (shortcut?.providerId ?? '').trim();
  const apiKey = (shortcut?.apiKey ?? '').trim();
  const baseUrl = (shortcut?.baseUrl ?? '').trim();
  if (!providerId && !apiKey) {
    if (baseUrl) throw new Error('provider-base-url needs provider and provider-api-key');
    return accounts;
  }
  if (!providerId || !apiKey) {
    throw new Error('provider and provider-api-key must be given together');
  }
  const account = validateAccount(
    { providerId, kind: 'apikey', apiKey, ...(baseUrl ? { baseUrl } : {}) },
    'provider'
  );
  return [...accounts.filter((a) => a.providerId !== providerId), account];
}

function resolveEffortLevel(explicit, bundle) {
  const effort = (explicit ?? '').trim() || bundle.effortLevel || null;
  if (effort !== null && !VALID_EFFORT_LEVELS.has(effort)) {
    throw new Error(`effort-level must be one of ${[...VALID_EFFORT_LEVELS].join('|')}`);
  }
  return effort;
}

export function buildConeConfigFiles(input = {}) {
  const bundle = parseBundle(input.coneConfigJson);
  const accountsRaw = bundle.accounts ?? [];
  if (!Array.isArray(accountsRaw)) throw new Error('cone-config: accounts must be an array');
  const accounts = mergeApiKeyAccount(
    accountsRaw.map((a, i) => validateAccount(a, i)),
    input.apiKeyAccount
  );
  const secrets = collectSecrets(bundle, input.secretsEnvText);
  const model = (input.model ?? '').trim() || (isStr(bundle.model) ? bundle.model : '') || null;
  const effortLevel = resolveEffortLevel(input.effortLevel, bundle);

  const coneConfigJson =
    model || effortLevel || accounts.length
      ? JSON.stringify({
          ...(model ? { model } : {}),
          ...(effortLevel ? { effortLevel } : {}),
          accounts,
        })
      : null;

  return {
    coneConfigJson,
    secretsEnv: serializeSecretsEnv(secrets),
    summary: {
      model,
      effortLevel,
      accountProviderIds: accounts.map((a) => a.providerId),
      secretNames: secrets.map((s) => s.name),
    },
  };
}

export function parseJoinFile(text, minUpdatedAtMs = 0) {
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  if (!isStr(parsed.joinUrl) || !parsed.joinUrl) return null;
  const updatedAt = Date.parse(parsed.updatedAt ?? '');
  if (!Number.isFinite(updatedAt) || updatedAt < minUpdatedAtMs) return null;
  return {
    joinUrl: parsed.joinUrl,
    trayId: isStr(parsed.trayId) ? parsed.trayId : null,
    updatedAt,
    sliccVersion: isStr(parsed.sliccVersion) ? parsed.sliccVersion : null,
  };
}

const GO_OS = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
const GO_ARCH = { x64: 'amd64', arm64: 'arm64' };

export function cliAssetName(platform, arch) {
  const os = GO_OS[platform];
  const goArch = GO_ARCH[arch];
  if (!os || !goArch) return null;
  return `slicc-${os}-${goArch}${os === 'windows' ? '.exe' : ''}`;
}

export function pickCliRelease(releases, assetName) {
  for (const release of releases ?? []) {
    if (!release || release.draft || release.prerelease) continue;
    const asset = (release.assets ?? []).find((a) => a?.name === assetName);
    if (asset?.browser_download_url && release.tag_name) {
      return { version: release.tag_name, downloadUrl: asset.browser_download_url };
    }
  }
  return null;
}

export function formatGithubOutput(name, value) {
  const text = String(value ?? '');
  if (!/[\r\n]/.test(text)) return `${name}=${text}\n`;
  let delimiter = 'ghadelim_slicc';
  let n = 0;
  while (text.includes(delimiter)) delimiter = `ghadelim_slicc_${++n}`;
  return `${name}<<${delimiter}\n${text}\n${delimiter}\n`;
}

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function requireVfsPath(path, what = 'path') {
  const trimmed = String(path ?? '').trim();
  if (!trimmed.startsWith('/'))
    throw new Error(`${what} must be an absolute VFS path, got "${path}"`);
  if (hasNewline(trimmed)) throw new Error(`${what} must be a single line`);
  if (trimmed.split('/').includes('..')) throw new Error(`${what} must not contain ".." segments`);
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
}

export function posixDirname(path) {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

export function buildReadCommand(vfsPath) {
  return `base64 ${shellQuote(requireVfsPath(vfsPath))}`;
}

export function buildWriteCommand(vfsPath) {
  const path = requireVfsPath(vfsPath);
  return `mkdir -p ${shellQuote(posixDirname(path))} && base64 -d > ${shellQuote(path)}`;
}

export function buildInjectCommand(targetDir, tmpArchive = '/tmp/slicc-inject.tgz') {
  const target = requireVfsPath(targetDir, 'inject-target');
  const tmp = requireVfsPath(tmpArchive, 'tmp-archive');
  return [
    `mkdir -p ${shellQuote(target)}`,
    `base64 -d > ${shellQuote(tmp)}`,
    `tar -xzf ${shellQuote(tmp)} -C ${shellQuote(target)}`,
    `rm -f ${shellQuote(tmp)}`,
  ].join(' && ');
}

export function buildExportSessionCommand(outputPath, sessionId = '') {
  const idArg = sessionId.trim() ? ` --id ${shellQuote(sessionId.trim())}` : '';
  return `session export${idArg} --output ${shellQuote(requireVfsPath(outputPath, 'output'))}`;
}

export function buildFollowArgs(options) {
  const runner = (options.runner ?? '').trim();
  const runnerArgv = runner ? runner.split(/\s+/) : [...DEFAULT_FOLLOW_RUNNER];
  const args = [options.joinUrl, 'follow', '--plain', '--no-banner'];
  if (options.evalMode) {
    args.push('--eval');
    if (options.evalQuiet?.trim()) args.push('--eval-quiet', options.evalQuiet.trim());
  }
  return [...args, ...runnerArgv];
}

export function truncateForOutput(text, maxBytes = 256 * 1024) {
  const value = String(text ?? '');
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
  const buf = Buffer.from(value, 'utf8').subarray(0, maxBytes);
  return { text: `${buf.toString('utf8')}\n…[truncated; see output file]`, truncated: true };
}

export function tailLines(text, n = 60) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).join('\n');
}

export function parseBoolean(text, fallback = false) {
  const raw = String(text ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return fallback;
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  throw new Error(`expected a boolean, got "${text}"`);
}

export function checkWatchedProcesses(state, isAlive, watch = 'all') {
  const dead = [];
  const watchLeader = watch === 'leader' || watch === 'all';
  const watchFollowers = watch === 'followers' || watch === 'all';
  if (watchLeader && typeof state.leader === 'number' && !isAlive(state.leader)) {
    dead.push({ role: 'leader', pid: state.leader });
  }
  if (watchFollowers) {
    for (const pid of state.followers ?? []) {
      if (!isAlive(pid)) dead.push({ role: 'follower', pid });
    }
  }
  return { ok: dead.length === 0, dead };
}
