// Shared accept/reject table for the cone-config bundle rules (#4129). Run
// against cloud-core's validators (tests/cone-config/bundle-cases.test.ts) and
// github-workflow's buildConeConfigFiles (scripts/cone-config-rules.test.mjs),
// so the two floats can never disagree on what a valid bundle is again.
//
// `changed` names the copy whose verdict this case flipped in #4129; a case
// without it pins behaviour both copies already shared.

const ok = { name: 'TOKEN', value: 'v', domains: ['api.example.com'] };

/**
 * @typedef {{
 *   id: string;
 *   secret: unknown;
 *   reject?: string;
 *   domains?: string[];
 *   changed?: Array<'cloud-core' | 'github-workflow'>;
 * }} SecretCase
 */

/** @type {SecretCase[]} */
export const SECRET_CASES = [
  { id: 'plain identifier', secret: ok, domains: ['api.example.com'] },
  {
    id: 'dotted mount secret name',
    secret: { ...ok, name: 's3.r2.access_key_id', domains: ['*.r2.cloudflarestorage.com'] },
    domains: ['*.r2.cloudflarestorage.com'],
    changed: ['cloud-core'],
  },
  {
    id: 'hyphenated name',
    secret: { ...ok, name: 'db.prod-eu.password' },
    domains: ['api.example.com'],
    changed: ['cloud-core'],
  },
  {
    id: 'reserved oauth.* namespace',
    secret: { ...ok, name: 'oauth.github.token' },
    reject: 'oauth\\.\\* namespace is reserved',
    changed: ['cloud-core'],
  },
  {
    id: 'name shadowing another secret’s _DOMAINS line',
    secret: { ...ok, name: 'ADOBE_IMS_TOKEN_DOMAINS', value: 'evil.example' },
    reject: '_DOMAINS are reserved',
    changed: ['cloud-core', 'github-workflow'],
  },
  {
    id: 'empty domains list',
    secret: { ...ok, domains: [] },
    reject: 'non-empty',
    changed: ['cloud-core'],
  },
  {
    id: 'untrimmed domains are trimmed',
    secret: { ...ok, domains: [' api.example.com ', '\t*.example.com'] },
    domains: ['api.example.com', '*.example.com'],
    changed: ['cloud-core'],
  },
  {
    id: 'blank domain entry',
    secret: { ...ok, domains: ['api.example.com', '  '] },
    reject: 'non-blank',
    changed: ['cloud-core'],
  },
  { id: 'name starting with a digit', secret: { ...ok, name: '9LIVES' }, reject: 'name must' },
  { id: 'name with =', secret: { ...ok, name: 'A=B' }, reject: 'name must' },
  { id: 'name with a space', secret: { ...ok, name: 'A B' }, reject: 'name must' },
  { id: 'name with a newline', secret: { ...ok, name: 'A\nB' }, reject: 'name must' },
  { id: 'missing name', secret: { value: 'v', domains: ['d'] }, reject: 'name must' },
  { id: 'multiline value', secret: { ...ok, value: 'a\nb' }, reject: 'single-line' },
  { id: 'CR in value', secret: { ...ok, value: 'a\rb' }, reject: 'single-line' },
  { id: 'missing value', secret: { name: 'A', domains: ['d'] }, reject: 'single-line' },
  { id: 'domains not an array', secret: { ...ok, domains: 'a,b' }, reject: 'string\\[\\]' },
  { id: 'non-string domain', secret: { ...ok, domains: [1] }, reject: 'string\\[\\]' },
  { id: 'comma in a domain', secret: { ...ok, domains: ['a,b'] }, reject: 'comma-free' },
  { id: 'newline in a domain', secret: { ...ok, domains: ['a\nb'] }, reject: 'single-line' },
  { id: 'secret not an object', secret: null, reject: 'not an object' },
];

/**
 * @typedef {{
 *   id: string;
 *   account: unknown;
 *   reject?: string;
 *   changed?: Array<'cloud-core' | 'github-workflow'>;
 * }} AccountCase
 */

/** @type {AccountCase[]} */
export const ACCOUNT_CASES = [
  {
    id: 'oauth account keeps only known fields',
    account: {
      providerId: 'github',
      kind: 'oauth',
      accessToken: 'gho',
      refreshToken: 'ghr',
      tokenExpiresAt: 1,
      userName: 'octocat',
      baseUrl: 'https://x',
      extra: 'dropped',
    },
  },
  {
    id: 'oauth account with only the required fields',
    account: { providerId: 'adobe', kind: 'oauth', accessToken: 'ims', tokenExpiresAt: '1' },
  },
  {
    id: 'apikey account keeps only known fields',
    account: {
      providerId: 'azure',
      kind: 'apikey',
      apiKey: 'k',
      baseUrl: 'https://x',
      deployment: 'd',
      apiVersion: 'v',
      accessToken: 'dropped',
    },
  },
  {
    id: 'empty providerId',
    account: { providerId: '', kind: 'apikey', apiKey: 'k' },
    reject: 'providerId required',
    changed: ['cloud-core'],
  },
  {
    id: 'empty accessToken',
    account: { providerId: 'x', kind: 'oauth', accessToken: '' },
    reject: 'requires accessToken',
    changed: ['cloud-core'],
  },
  {
    id: 'empty apiKey',
    account: { providerId: 'x', kind: 'apikey', apiKey: '' },
    reject: 'requires apiKey',
    changed: ['cloud-core'],
  },
  { id: 'unknown kind', account: { providerId: 'x', kind: 'saml' }, reject: 'kind must be' },
  { id: 'missing kind', account: { providerId: 'x' }, reject: 'kind' },
  { id: 'account not an object', account: 'x', reject: 'not an object' },
];

export const VALID_EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
export const INVALID_EFFORT_LEVELS = ['max', 'HIGH', 'ultra'];
