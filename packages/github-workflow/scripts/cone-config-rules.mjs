// @ts-check

export const EFFORT_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export function isEffortLevel(value) {
  return typeof value === 'string' && EFFORT_LEVELS.includes(value);
}

export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

const RESERVED_PREFIX = 'oauth.';

const DOMAINS_SUFFIX = '_DOMAINS';

function isStr(v) {
  return typeof v === 'string';
}

function hasNewline(v) {
  return /[\r\n]/.test(v);
}

function optionalStr(obj, key) {
  const v = obj[key];
  return isStr(v) ? { [key]: v } : {};
}

export function validateAccount(input, where) {
  if (input === null || typeof input !== 'object') throw new Error(`${where} is not an object`);
  const a = input;
  if (!isStr(a.providerId) || !a.providerId) throw new Error(`${where}.providerId required`);
  if (a.kind === 'oauth') {
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
  if (a.kind === 'apikey') {
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
  throw new Error(`${where}.kind must be 'oauth' | 'apikey'`);
}

export function validateSecret(input, where) {
  if (input === null || typeof input !== 'object') throw new Error(`${where} is not an object`);
  const s = input;
  if (!isStr(s.name) || !SECRET_NAME_RE.test(s.name)) {
    throw new Error(`${where}: name must be an identifier matching ${SECRET_NAME_RE}`);
  }
  if (s.name.startsWith(RESERVED_PREFIX)) {
    throw new Error(`${where} ${s.name}: the oauth.* namespace is reserved for OAuth replicas`);
  }
  if (s.name.endsWith(DOMAINS_SUFFIX)) {
    throw new Error(`${where} ${s.name}: names ending in _DOMAINS are reserved for domain lines`);
  }
  if (!isStr(s.value) || hasNewline(s.value)) {
    throw new Error(`${where} ${s.name}: value must be a single-line string`);
  }
  if (!Array.isArray(s.domains) || s.domains.length === 0 || !s.domains.every(isStr)) {
    throw new Error(`${where} ${s.name}: domains must be a non-empty string[]`);
  }
  const domains = s.domains.map((d) => d.trim());
  if (domains.some((d) => !d || hasNewline(d) || d.includes(','))) {
    throw new Error(`${where} ${s.name}: domains must be non-blank, single-line and comma-free`);
  }
  return { name: s.name, value: s.value, domains };
}

export function serializeSecretsEnv(secrets) {
  const lines = [];
  for (const s of secrets) {
    lines.push(`${s.name}=${s.value}`);
    lines.push(`${s.name}${DOMAINS_SUFFIX}=${s.domains.join(',')}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
