# Manual Chrome Web Store Publish Workflow

## Problem

The release pipeline builds a Chrome extension zip and attaches it to GitHub Releases, but there is no automation to upload or publish it to the Chrome Web Store. Publishing is currently a manual dashboard operation. With several changes a day landing on main, each producing a new release, we need a controlled way to push a chosen version to the store without publishing every single release automatically.

## Decision

A manual `workflow_dispatch` GitHub Actions workflow that downloads an extension zip from a GitHub Release and uploads + publishes it to the Chrome Web Store via the V2 API. A companion `build/publish-chrome.js` script handles the CWS API calls.

### Why manual, not automatic

- Multiple releases per day would cause review churn (each upload cancels a pending review).
- Uploads are blocked while a version is under review — automatic uploads would fail intermittently.
- Manual triggering gives control over what version reaches users and when.

## Workflow: `publish-chrome.yml`

### Trigger

`workflow_dispatch` with two inputs:

| Input                         | Type    | Default | Description                                                              |
| ----------------------------- | ------- | ------- | ------------------------------------------------------------------------ |
| `version`                     | string  | `""`    | Release tag (e.g. `v0.3.2`). Empty string resolves to the latest release |
| `force_replace_pending_review`| boolean | `false` | Cancel any pending CWS review before uploading                           |

### Secrets

| Secret             | Purpose                        |
| ------------------ | ------------------------------ |
| `CWS_CLIENT_ID`   | Google OAuth client ID         |
| `CWS_CLIENT_SECRET`| Google OAuth client secret    |
| `CWS_REFRESH_TOKEN`| Google OAuth refresh token    |

### Job steps

1. **Checkout** — needed for `build/publish-chrome.js`.
2. **Setup Node 22** — script uses native `fetch`, no `npm install` required.
3. **Resolve release** — if `version` input is empty, query latest release via `gh release view --json tagName`. Otherwise use the provided tag.
4. **Download extension zip** — `gh release download <tag> --pattern '*-extension-*.zip' --dir /tmp/cws`. The release pipeline produces files named `slicc-extension-v{version}.zip` (via `sanitizeArtifactName` in `release-package.ts`).
5. **Publish** — invoke the script with the force flag mapped from the workflow input:
   ```
   node build/publish-chrome.js /tmp/cws/*.zip ${{ inputs.force_replace_pending_review == true && '--force' || '' }}
   ```
   Env vars: `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`.
6. **Summary** — write version published and CWS developer dashboard link to `$GITHUB_STEP_SUMMARY`.

### Runner

`ubuntu-latest` — no macOS needed. The script downloads a pre-built zip and makes HTTP calls.

## Script: `build/publish-chrome.js`

Plain Node.js (ES modules), zero external dependencies. Uses Node 22 native `fetch` and `fs`.

### Interface

```
node build/publish-chrome.js <zip-path> [--force]
```

- `<zip-path>` — path to the extension zip file.
- `--force` — cancel any pending CWS review before uploading.

### Environment variables

| Variable            | Required | Default                            |
| ------------------- | -------- | ---------------------------------- |
| `CWS_CLIENT_ID`    | yes      | —                                  |
| `CWS_CLIENT_SECRET`| yes      | —                                  |
| `CWS_REFRESH_TOKEN`| yes      | —                                  |
| `CWS_EXTENSION_ID` | no       | `akggccfpkleihhemkkikggopnifgelbk` |

### Steps

1. **Authenticate** — POST `https://oauth2.googleapis.com/token` with `grant_type=refresh_token`, client credentials, and refresh token. Extract `access_token`.
2. **Check status** — GET item status from CWS V2 API. If the item is `ITEM_PENDING_REVIEW`:
   - With `--force`: call `cancelSubmission` (V2 endpoint), then proceed.
   - Without `--force`: exit code 1 with message: `"Version pending review. Re-run with force_replace_pending_review enabled to cancel and re-submit."`.
3. **Upload** — PUT the zip to the CWS V2 upload endpoint with the access token. Validate `uploadState === 'SUCCESS'`.
4. **Publish** — POST to the CWS V2 publish endpoint. Validate response status contains `'OK'`.

### Exit codes

- `0` — published successfully.
- `1` — error (descriptive message printed to stderr).

### CWS API version

V2 (`chromewebstore.googleapis.com/v2/`). V1 is deprecated and scheduled for removal October 15, 2026.

## Error handling

| Scenario                               | Behavior                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| No releases exist                      | Workflow fails: `gh release view` exits non-zero, step fails                                     |
| No extension zip in release assets     | Workflow fails: "no extension zip found for release vX.Y.Z"                                      |
| Invalid or expired refresh token       | Script fails with Google OAuth error                                                             |
| Version pending review, no `--force`   | Script fails: "Version pending review. Re-run with force_replace_pending_review enabled..."      |
| Version pending review, with `--force` | Cancel submission, then upload and publish                                                       |
| Upload fails                           | Script fails with CWS `uploadState` and `itemError` detail                                      |
| Publish fails                          | Script fails with CWS `status` and `statusDetail`                                               |

## Out of scope

- Draft-only uploads (no partial publish mode).
- Slack/Discord notifications (can be added later).
- Automatic triggering from the release workflow.
- New npm dependencies.

## Files changed

| File                                  | Change   |
| ------------------------------------- | -------- |
| `.github/workflows/publish-chrome.yml`| new      |
| `build/publish-chrome.js`             | new      |
