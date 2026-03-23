# Chrome Web Store Extension Integration

**Date:** 2026-03-23
**Branch:** `feature/chrome-extension`
**Status:** Approved

## Problem

SLICC's Chrome extension has been accepted into the Chrome Web Store (CWS) with ID `akggccfpkleihhemkkikggopnifgelbk`. Three things need updating to work with this new home:

1. The manifest key still produces the old dev extension ID, so local builds have a different ID than the CWS version
2. The Adobe IMS OAuth redirect URI points to the old extension ID
3. Sliccstart still guides users through manual "Load Unpacked" developer mode installation

## Changes

### 1. Manifest Key Alignment

**File:** `manifest.json`

Replace the `"key"` field with the CWS public key (raw base64, no PEM headers):

```
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnEuuMuC5INo0Harfu36DPaBV+NtIMF7CUyhfEtzWNyjBQ2EWOCZNuEl0RYuoLA6IsF17OeMCRrEYDu8oDIRW+EkksmbXl9A7TxN4HKgsOp8BUATgl80HsPNgveef7u1pRJhd9I/qIA1AkbtZ0LelUmLgMO8Kc2nLMinfVcAScPMaKvP2gUXrw3njgTAdhlBhUpoPG85puFm3dY7b1b58tpJFeoJ90Labnae4oynAIlF9ipJbOLBaMrA/trs3jX3niaa5RArNNsXmfm59JJh51d6532IKBgLVWikVVSa8SOMK1wG9ZxqWuSU/vay0UlvK6qOsTRL7xxUHkvXZIeZlIwIDAQAB
```

**Result:** Local unpacked builds produce ID `akggccfpkleihhemkkikggopnifgelbk`, matching CWS. Verified via SHA-256 hash computation.

### 2. Adobe IMS Redirect URI

**File:** `providers/adobe-config.json`

Update `extensionRedirectUri`:
```json
"extensionRedirectUri": "https://akggccfpkleihhemkkikggopnifgelbk.chromiumapp.org/adobe"
```

The code in `providers/adobe.ts` line 232 has a dynamic fallback (`chrome.runtime.id`), which will now also produce the correct URI thanks to the key fix. The explicit config value is kept for clarity and to preserve the `/adobe` path suffix.

**Manual step (not code):** Allowlist `https://akggccfpkleihhemkkikggopnifgelbk.chromiumapp.org/adobe` as a redirect URI in the Adobe IMS console.

### 3. Sliccstart: CWS-Only Installation

Replace the manual "Load Unpacked" developer mode flow with a direct link to the CWS listing.

**File:** `sliccstart/Sliccstart/Models/SliccProcess.swift`
- Replace `guidedInstallExtension(chromePath:)` with a new method (e.g., `openChromeWebStore()`) that opens the CWS listing URL: `https://chromewebstore.google.com/detail/slicc/akggccfpkleihhemkkikggopnifgelbk` in the default browser via `NSWorkspace.shared.open()`
- Remove the `~/.slicc/extension/` copy logic (lines 105-117: stablePath, sourcePath, copyItem)
- Remove the Finder window opening (`NSWorkspace.shared.selectFile`)
- The `chromePath` parameter is no longer needed since we open the CWS URL in the default browser

**File:** `sliccstart/Sliccstart/Views/AppListView.swift`
- Update button label from "Install to Chrome" to "Get Extension" (or similar)
- Simplify the button action: call the new `openChromeWebStore()` method directly instead of showing the guided install dialog
- Remove Developer Mode instruction text

**File:** `sliccstart/Sliccstart/Models/SliccBootstrapper.swift`
- Remove `npm run build:extension` from both `bootstrap()` (line ~118) and `update()` (line ~146) methods — CWS is now the distribution path, local extension builds are only for development

**File:** `sliccstart/Sliccstart/SliccstartApp.swift`
- Remove or simplify the `onGuidedInstall` callback handler (lines ~86-96) that displays the old Developer Mode instructions — replace with a simple CWS URL open, or remove entirely if the button in AppListView now handles it directly

## Testing

- Run all four build gates: `npm run typecheck && npm run test && npm run build && npm run build:extension`
- Verify local unpacked build produces correct extension ID via `chrome://extensions` — load the built extension from `dist/extension/` and confirm ID is `akggccfpkleihhemkkikggopnifgelbk`
- Verify Adobe OAuth login works with the new redirect URI — test against a local unpacked build (which now has the CWS ID). Requires IMS allowlist update for the new redirect URI first (manual step).
- Verify Sliccstart "Get Extension" button opens the CWS listing URL correctly

## Out of Scope

- IMS console configuration (manual step, not code)
- CWS listing page content/screenshots
- Extension auto-update mechanism (handled by CWS natively)
