// @ts-check
// Zero-dependency rules for the untrusted cone-config bundle: provider
// accounts, domain-scoped secrets, the effort-level set, and the `secrets.env`
// serializer. Plain JS with no imports, so both floats that write a cone's
// credential files run the exact same checks.
//
// CANONICAL COPY: packages/cloud-core/src/cone-config/cone-config-rules.mjs
// (wrapped with types by cone-config/index.ts). packages/github-workflow/
// scripts/cone-config-rules.mjs is a byte-identical vendored copy, because the
// workflow scripts run from a sparse checkout of packages/github-workflow and
// cannot import another package. Edit the canonical file, then copy it over;
// github-workflow's cone-config-rules.test.mjs fails while the two differ.

/** @typedef {'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'} EffortLevel */

/**
 * @typedef {{
 *   providerId: string;
 *   kind: 'oauth';
 *   accessToken: string;
 *   refreshToken?: string;
 *   tokenExpiresAt?: number;
 *   userName?: string;
 *   baseUrl?: string;
 * }} OAuthAccount
 */

/**
 * @typedef {{
 *   providerId: string;
 *   kind: 'apikey';
 *   apiKey: string;
 *   baseUrl?: string;
 *   deployment?: string;
 *   apiVersion?: string;
 * }} ApiKeyAccount
 */

/** @typedef {{ name: string; value: string; domains: string[] }} SecretEntry */

/** @type {readonly EffortLevel[]} */
export const EFFORT_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

/**
 * @param {unknown} value
 * @returns {value is EffortLevel}
 */
export function isEffortLevel(value) {
  return (
    typeof value === 'string' && /** @type {readonly string[]} */ (EFFORT_LEVELS).includes(value)
  );
}

/**
 * Secret names: identifier-shaped, plus `.` and `-` for namespaced subsystem
 * secrets (`s3.<profile>.access_key_id`). The `secrets.env` key is everything
 * before the first `=`, so none of these characters can split a line; only
 * POSIX-identifier names ever reach the agent shell as `$NAME`.
 */
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Owned by node-server's in-memory OAuth replica store; a bundle may not write it. */
const RESERVED_PREFIX = 'oauth.';

/** `secrets.env` reads any `<NAME>_DOMAINS` key as NAME's domain list. */
const DOMAINS_SUFFIX = '_DOMAINS';

/**
 * @param {unknown} v
 * @returns {v is string}
 */
function isStr(v) {
  return typeof v === 'string';
}

/**
 * @param {string} v
 * @returns {boolean}
 */
function hasNewline(v) {
  return /[\r\n]/.test(v);
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @returns {Record<string, string>}
 */
function optionalStr(obj, key) {
  const v = obj[key];
  return isStr(v) ? { [key]: v } : {};
}

/**
 * Validate one untrusted provider account. Only the known fields of the
 * chosen kind survive; the credential and `providerId` must be non-empty.
 * @param {unknown} input
 * @param {string} where error-message prefix, e.g. `cone-config: accounts[0]`
 * @returns {OAuthAccount | ApiKeyAccount}
 */
export function validateAccount(input, where) {
  if (input === null || typeof input !== 'object') throw new Error(`${where} is not an object`);
  const a = /** @type {Record<string, unknown>} */ (input);
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

/**
 * Validate one untrusted secret against the line-oriented `secrets.env`
 * schema (no escaping): a {@link SECRET_NAME_RE} name outside the reserved
 * `oauth.*` namespace and not ending in `_DOMAINS`, a single-line value, and
 * at least one domain, each trimmed, non-blank, single-line and comma-free.
 * node-server drops a secret with no domains, so `[]` is rejected here
 * rather than shipped as a secret that silently never loads.
 * @param {unknown} input
 * @param {string} where error-message prefix, e.g. `cone-config: secrets[0]`
 * @returns {SecretEntry}
 */
export function validateSecret(input, where) {
  if (input === null || typeof input !== 'object') throw new Error(`${where} is not an object`);
  const s = /** @type {Record<string, unknown>} */ (input);
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

/**
 * Serialize validated secrets to the `NAME=value` / `NAME_DOMAINS=a,b` lines
 * node-server's EnvSecretStore reads. Values are written verbatim, so callers
 * pass entries that went through {@link validateSecret}.
 * @param {readonly SecretEntry[]} secrets
 * @returns {string}
 */
export function serializeSecretsEnv(secrets) {
  const lines = [];
  for (const s of secrets) {
    lines.push(`${s.name}=${s.value}`);
    lines.push(`${s.name}${DOMAINS_SUFFIX}=${s.domains.join(',')}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
