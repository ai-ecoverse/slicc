import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const UPSTREAM = {
  repo: 'browser-use/benchmark',
  tag: 'v2.1.1',
  commit: 'af6c7f7f6772b6985b7644f660cac87fd4b03583',
};

export const UPSTREAM_SETS = ['BU_Bench_V1', 'BU_Bench_V2', 'Stealth_Bench_V1'];

export function rawUrl(path, { repo, commit } = UPSTREAM) {
  return `https://raw.githubusercontent.com/${repo}/${commit}/${path}`;
}

export function fernetKey(name) {
  return createHash('sha256').update(name, 'utf8').digest();
}

function fromBase64Url(text) {
  return Buffer.from(String(text).trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function toBase64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

export function fernetDecrypt(token, key) {
  const data = fromBase64Url(token);
  if (data.length < 1 + 8 + 16 + 16 + 32 || data[0] !== 0x80) throw new Error('not a Fernet token');
  const signed = data.subarray(0, data.length - 32);
  const mac = data.subarray(data.length - 32);
  const expected = createHmac('sha256', key.subarray(0, 16)).update(signed).digest();
  if (!timingSafeEqual(mac, expected))
    throw new Error('Fernet signature does not match: wrong key or damaged file');
  const iv = data.subarray(9, 25);
  const decipher = createDecipheriv('aes-128-cbc', key.subarray(16, 32), iv);
  return Buffer.concat([decipher.update(data.subarray(25, data.length - 32)), decipher.final()]);
}

export function fernetEncrypt(plaintext, key, { now = Date.now(), iv = randomBytes(16) } = {}) {
  const cipher = createCipheriv('aes-128-cbc', key.subarray(16, 32), iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const header = Buffer.alloc(9);
  header[0] = 0x80;
  header.writeBigUInt64BE(BigInt(Math.floor(now / 1000)), 1);
  const signed = Buffer.concat([header, iv, body]);
  const mac = createHmac('sha256', key.subarray(0, 16)).update(signed).digest();
  return toBase64Url(Buffer.concat([signed, mac]));
}

export function decryptSetFile(fileText, name) {
  const token = Buffer.from(String(fileText).trim(), 'base64').toString('utf8');
  return JSON.parse(fernetDecrypt(token, fernetKey(name)).toString('utf8'));
}

export function encryptJson(value, name, options) {
  const token = fernetEncrypt(Buffer.from(JSON.stringify(value), 'utf8'), fernetKey(name), options);
  return Buffer.from(token, 'utf8').toString('base64');
}

export const UPSTREAM_TIMEOUT_MS = 60_000;

async function fetchText(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.text();
}

export async function loadUpstreamSet(
  name,
  { fetchImpl = fetch, source = UPSTREAM, withProvenance = false } = {}
) {
  if (!UPSTREAM_SETS.includes(name))
    throw new Error(`unknown upstream set ${name}; have ${UPSTREAM_SETS.join(', ')}`);
  const text = await fetchText(rawUrl(`${name}.enc`, source), fetchImpl);
  const data = decryptSetFile(text, name);
  if (!withProvenance) return data;
  return { data, provenance: provenance(name, text, source) };
}

export function provenance(name, fileText, source = UPSTREAM) {
  return {
    repo: source.repo,
    tag: source.tag ?? null,
    commit: source.commit,
    file: `${name}.enc`,
    sha256: createHash('sha256').update(String(fileText), 'utf8').digest('hex'),
  };
}

export function extractPythonString(source, name) {
  const re = new RegExp(`^${name}\\s*=\\s*"""([\\s\\S]*?)"""`, 'm');
  const match = re.exec(source);
  if (!match) throw new Error(`${name} not found`);
  return match[1].trim();
}

export function extractOptionalPythonInt(source, name) {
  return new RegExp(`^${name}\\s*=`, 'm').test(source) ? extractPythonInt(source, name) : null;
}

export function extractPythonInt(source, name) {
  const match = new RegExp(`^${name}\\s*=\\s*([0-9_]+)`, 'm').exec(source);
  if (!match) throw new Error(`${name} not found`);
  return Number(match[1].replace(/_/g, ''));
}

export async function loadFindingsSpec({ fetchImpl = fetch, source = UPSTREAM } = {}) {
  const py = await fetchText(rawUrl('findings_judge.py', source), fetchImpl);
  return {
    systemPrompt: extractPythonString(py, 'FINDINGS_SYSTEM_PROMPT'),
    caps: {
      task: extractOptionalPythonInt(py, 'TASK_MAX_CHARS'),
      website: extractPythonInt(py, 'WEBSITE_MAX_CHARS'),
      rubric: extractOptionalPythonInt(py, 'RUBRIC_MAX_CHARS'),
      finalResult: extractPythonInt(py, 'FINAL_RESULT_MAX_CHARS'),
      trajectory: extractPythonInt(py, 'TRAJECTORY_MAX_CHARS'),
      files: extractPythonInt(py, 'FILES_MAX_CHARS'),
    },
    source: `${source.repo}@${source.commit}`,
  };
}
