// x_search — proxy xAI's server-side `x_search` tool via the Responses API.
//
// Resolves the bearer token through `oauth-token xai-grok` so any model can
// pull X (Twitter) results regardless of which provider is steering the cone.
//
// Usage:
//   x_search "<query>"
//   x_search --from <h1,h2> --since 2025-01-01 --until 2025-03-31 "query"
//
// Env:
//   PI_XAI_X_SEARCH_MODEL  Default: grok-4.3
//   XAI_API_BASE_URL       Default: https://api.x.ai/v1

const { exec } = require('sliccy:exec');

const BASE_URL = (process.env.XAI_API_BASE_URL || 'https://api.x.ai/v1').replace(/\/+$/, '');
const SEARCH_MODEL = process.env.PI_XAI_X_SEARCH_MODEL || 'grok-4.3';

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const argv = process.argv.slice(2);
let allowedHandles = [];
let excludedHandles = [];
let fromDate;
let toDate;
const positional = [];

while (argv.length) {
  const a = argv.shift();
  switch (a) {
    case '--from':
    case '--handles':
      allowedHandles = parseList(argv.shift());
      break;
    case '--exclude':
      excludedHandles = parseList(argv.shift());
      break;
    case '--since':
      fromDate = argv.shift();
      break;
    case '--until':
      toDate = argv.shift();
      break;
    case '-h':
    case '--help':
      console.log(
        'Usage: x_search [--from h1,h2] [--exclude h1,h2] [--since YYYY-MM-DD] [--until YYYY-MM-DD] "query"'
      );
      process.exit(0);
      return;
    default:
      positional.push(a);
  }
}

const query = positional.join(' ').trim();
if (!query) {
  console.error('x_search: missing query (use --help for usage)');
  process.exit(2);
  return;
}

const tokenResult = await exec('oauth-token xai-grok');
const token = (tokenResult.stdout || '').trim();
if (tokenResult.exitCode !== 0 || !token) {
  console.error('x_search: could not obtain an xAI bearer token. Run `/login xai-grok` first.');
  if (tokenResult.stderr) console.error(tokenResult.stderr.trim());
  process.exit(1);
  return;
}

const xSearchTool = { type: 'x_search' };
if (allowedHandles.length) xSearchTool.allowed_x_handles = allowedHandles;
if (excludedHandles.length) xSearchTool.excluded_x_handles = excludedHandles;
if (fromDate) xSearchTool.from_date = fromDate;
if (toDate) xSearchTool.to_date = toDate;

const payload = {
  model: SEARCH_MODEL,
  input: [{ role: 'user', content: query }],
  tools: [xSearchTool],
  store: false,
};

const response = await fetch(`${BASE_URL}/responses`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify(payload),
});

if (!response.ok) {
  const body = await response.text().catch(() => '');
  console.error(`x_search: xAI returned ${response.status}: ${body.slice(0, 800)}`);
  process.exit(1);
  return;
}

const data = await response.json();
const items = Array.isArray(data.output) ? data.output : [];
const textParts = [];
for (const item of items) {
  if (item && item.type === 'message' && Array.isArray(item.content)) {
    for (const part of item.content) {
      if (part && part.type === 'output_text' && typeof part.text === 'string') {
        textParts.push(part.text);
      }
    }
  }
}

const answer = textParts.join('\n').trim() || '(no results)';
console.log(answer);

const citations = Array.isArray(data.citations) ? data.citations : [];
if (citations.length) {
  console.log('\nSources:');
  for (const c of citations) {
    if (!c || !c.url) continue;
    const title = c.title ? `${c.title} ` : '';
    console.log(`- ${title}${c.url}`);
  }
}
