# Manual CWS Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual GitHub Actions workflow that publishes the Chrome extension to the Chrome Web Store from a GitHub Release artifact.

**Architecture:** A `workflow_dispatch` workflow downloads the extension zip from a GitHub Release and passes it to `build/publish-chrome.js`, a zero-dependency Node script that authenticates via OAuth, checks for pending reviews, and uploads + publishes to the CWS V2 API.

**Tech Stack:** GitHub Actions, Node.js 22 (native fetch), Chrome Web Store V2 API, Google OAuth2

**Spec:** `docs/superpowers/specs/2026-03-25-cws-manual-publish-design.md`

---

### Task 1: Create the publish script

**Files:**
- Create: `build/publish-chrome.js`

- [ ] **Step 1: Create `build/` directory if needed and scaffold the script with argument parsing and env var validation**

```js
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

const { zipPath, force } = parseArgs(process.argv);
const clientId = requireEnv('CWS_CLIENT_ID');
const clientSecret = requireEnv('CWS_CLIENT_SECRET');
const refreshToken = requireEnv('CWS_REFRESH_TOKEN');
const extensionId = process.env.CWS_EXTENSION_ID || 'akggccfpkleihhemkkikggopnifgelbk';
```

- [ ] **Step 2: Add the OAuth authentication function**

```js
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
```

- [ ] **Step 3: Add the status check and cancel submission functions**

```js
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
```

- [ ] **Step 4: Add the upload and publish functions**

```js
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
```

- [ ] **Step 5: Add the main orchestration logic**

```js
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
```

- [ ] **Step 6: Verify the script parses correctly**

Run: `node --check build/publish-chrome.js`
Expected: no output (clean parse)

- [ ] **Step 7: Commit**

```bash
git add build/publish-chrome.js
git commit -m "feat: add CWS publish script (build/publish-chrome.js)"
```

---

### Task 2: Create the workflow

**Files:**
- Create: `.github/workflows/publish-chrome.yml`

- [ ] **Step 1: Write the workflow file**

```yaml
name: Publish Chrome Extension

on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Release tag (e.g. v0.3.2). Leave empty for latest release.'
        required: false
        default: ''
        type: string
      force_replace_pending_review:
        description: 'Cancel any pending CWS review before uploading'
        required: false
        default: false
        type: boolean

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Resolve release tag
        id: release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          if [ -n "${{ inputs.version }}" ]; then
            TAG="${{ inputs.version }}"
          else
            TAG=$(gh release view --json tagName -q '.tagName')
          fi
          echo "tag=$TAG" >> "$GITHUB_OUTPUT"
          echo "Resolved release: $TAG"

      - name: Download extension zip
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          mkdir -p /tmp/cws
          gh release download "${{ steps.release.outputs.tag }}" \
            --pattern '*-extension-*.zip' \
            --dir /tmp/cws
          ZIP_FILE=$(ls /tmp/cws/*.zip)
          echo "Downloaded: $ZIP_FILE"

      - name: Publish to Chrome Web Store
        env:
          CWS_CLIENT_ID: ${{ secrets.CWS_CLIENT_ID }}
          CWS_CLIENT_SECRET: ${{ secrets.CWS_CLIENT_SECRET }}
          CWS_REFRESH_TOKEN: ${{ secrets.CWS_REFRESH_TOKEN }}
        run: |
          node build/publish-chrome.js /tmp/cws/*.zip \
            ${{ inputs.force_replace_pending_review == true && '--force' || '' }}

      - name: Summary
        if: success()
        run: |
          echo "## Chrome Extension Published" >> "$GITHUB_STEP_SUMMARY"
          echo "" >> "$GITHUB_STEP_SUMMARY"
          echo "**Version:** ${{ steps.release.outputs.tag }}" >> "$GITHUB_STEP_SUMMARY"
          echo "**Dashboard:** https://chrome.google.com/webstore/devconsole" >> "$GITHUB_STEP_SUMMARY"
```

- [ ] **Step 2: Validate the workflow YAML**

Run: `node -e "const yaml = require('yaml'); yaml.parse(require('fs').readFileSync('.github/workflows/publish-chrome.yml', 'utf8')); console.log('Valid YAML')"`

If `yaml` is not available, use: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/publish-chrome.yml')); print('Valid YAML')"`

Expected: "Valid YAML"

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/publish-chrome.yml
git commit -m "ci: add manual Chrome Web Store publish workflow"
```

---

### Task 3: Format and verify

- [ ] **Step 1: Run Prettier on new files**

```bash
npx prettier --write build/publish-chrome.js .github/workflows/publish-chrome.yml
```

- [ ] **Step 2: Verify the full build still passes**

```bash
npm run typecheck && npm run test && npm run build && npm run build:extension
```

Expected: all four gates pass (new files are standalone, no integration with existing code).

- [ ] **Step 3: Commit any formatting changes**

```bash
git add -A
git diff --cached --quiet || git commit -m "style: format new CWS publish files"
```
