// build/publish-chrome.js
import { readFileSync } from 'fs';

const CWS_API_BASE = 'https://chromewebstore.googleapis.com/v2';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

function parseArgs(argv) {
  const args = argv.slice(2);
  const force = args.includes('--force');
  const zipPath = args.find((a) => !a.startsWith('--'));
  if (!zipPath) {
    console.error('Usage: node build/publish-chrome.js <zip-path> [--force]');
    process.exit(1);
  }
  return { zipPath, force };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

async function authenticate(clientId, clientSecret, refreshToken) {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth authentication failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function getItemStatus(extensionId, token) {
  const response = await fetch(
    `${CWS_API_BASE}/publishers/default/items/${extensionId}?projection=DRAFT`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get item status (${response.status}): ${text}`);
  }

  return response.json();
}

async function cancelSubmission(extensionId, token) {
  const response = await fetch(
    `${CWS_API_BASE}/publishers/default/items/${extensionId}:cancelSubmission`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to cancel submission (${response.status}): ${text}`);
  }

  console.log('Cancelled pending review.');
}

async function upload(extensionId, zipPath, token) {
  const zipData = readFileSync(zipPath);

  const response = await fetch(
    `${CWS_API_BASE}/publishers/default/items/${extensionId}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/zip',
        'x-goog-api-version': '2',
      },
      body: zipData,
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  if (data.uploadState !== 'SUCCESS') {
    const errors = (data.itemError || []).map((e) => e.detail || e.error_code).join(', ');
    throw new Error(`Upload rejected: state=${data.uploadState}, errors: ${errors}`);
  }

  console.log('Upload successful.');
  return data;
}

async function publish(extensionId, token) {
  const response = await fetch(
    `${CWS_API_BASE}/publishers/default/items/${extensionId}:publish`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Publish failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const status = data.status || [];
  if (!status.includes('OK')) {
    const detail = (data.statusDetail || []).join(', ');
    throw new Error(`Publish rejected: status=${status.join(',')}, detail: ${detail}`);
  }

  console.log('Publish successful — submitted for review.');
  return data;
}

const { zipPath, force } = parseArgs(process.argv);
const clientId = requireEnv('CWS_CLIENT_ID');
const clientSecret = requireEnv('CWS_CLIENT_SECRET');
const refreshToken = requireEnv('CWS_REFRESH_TOKEN');
const extensionId = process.env.CWS_EXTENSION_ID || 'akggccfpkleihhemkkikggopnifgelbk';

async function main() {
  console.log(`Publishing ${zipPath} to extension ${extensionId}...`);

  const token = await authenticate(clientId, clientSecret, refreshToken);
  console.log('Authenticated.');

  const status = await getItemStatus(extensionId, token);
  if (status.publicationState === 'ITEM_PENDING_REVIEW') {
    if (!force) {
      console.error(
        'Version pending review. Re-run with force_replace_pending_review enabled to cancel and re-submit.'
      );
      process.exit(1);
    }
    await cancelSubmission(extensionId, token);
  }

  await upload(extensionId, zipPath, token);
  await publish(extensionId, token);

  console.log('Done. Check status at https://chrome.google.com/webstore/devconsole');
}

main().catch((error) => {
  console.error(`[publish-chrome] ${error.message}`);
  process.exit(1);
});
