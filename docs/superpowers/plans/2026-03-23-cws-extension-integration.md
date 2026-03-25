# Chrome Web Store Extension Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align local extension builds with the CWS-published extension ID, update Adobe IMS OAuth redirect URI, and simplify Sliccstart to install from Chrome Web Store.

**Architecture:** Three independent changes — manifest key swap, config redirect URI update, and Sliccstart Swift UI simplification. No new files created; all changes modify existing files.

**Tech Stack:** Chrome Manifest V3, TypeScript (providers), Swift/SwiftUI (Sliccstart)

**Spec:** `docs/superpowers/specs/2026-03-23-cws-extension-integration-design.md`

---

### Task 1: Update manifest.json key for CWS extension ID

**Files:**

- Modify: `manifest.json:5` (the `"key"` field)

- [ ] **Step 1: Replace the manifest key**

In `manifest.json`, replace the current `"key"` value with the CWS public key (raw base64, no PEM headers):

```json
"key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnEuuMuC5INo0Harfu36DPaBV+NtIMF7CUyhfEtzWNyjBQ2EWOCZNuEl0RYuoLA6IsF17OeMCRrEYDu8oDIRW+EkksmbXl9A7TxN4HKgsOp8BUATgl80HsPNgveef7u1pRJhd9I/qIA1AkbtZ0LelUmLgMO8Kc2nLMinfVcAScPMaKvP2gUXrw3njgTAdhlBhUpoPG85puFm3dY7b1b58tpJFeoJ90Labnae4oynAIlF9ipJbOLBaMrA/trs3jX3niaa5RArNNsXmfm59JJh51d6532IKBgLVWikVVSa8SOMK1wG9ZxqWuSU/vay0UlvK6qOsTRL7xxUHkvXZIeZlIwIDAQAB",
```

The old key was:

```
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs9C5LGAbvS34z/jAkmkd0E77Pw7+1vSjvieWsRvegpwrkHw6Kv4jbn+r6mImbCASgErQ7i+uaGfGlFXmm3w5ZsrU949Kht1PZxu2/z1os8X2xZ2D3h0DQq6FFpo6HAJKi+lcWjP7pd1OPt6uMLnhe72a5ZDBS+lkjhR4biKEKo/WuVHj55Y58yn644MtB7P7BzQUJtNvE5cG+u1gPbQ2YHLAEK4ou9INOOWUm30fKneL+jRfS7RtUzCNFElAPVB7vN8EvEgIJcIzG6ncaIIy6+O/7B0MMQN8O33bEeFxZ4epoffJ+k4suAWoPxAsXmOWvv6ROHhGhZuSV2q4WycELQIDAQAB
```

- [ ] **Step 2: Verify the key produces the correct ID**

Run:

```bash
node -e "
const crypto = require('crypto');
const key = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnEuuMuC5INo0Harfu36DPaBV+NtIMF7CUyhfEtzWNyjBQ2EWOCZNuEl0RYuoLA6IsF17OeMCRrEYDu8oDIRW+EkksmbXl9A7TxN4HKgsOp8BUATgl80HsPNgveef7u1pRJhd9I/qIA1AkbtZ0LelUmLgMO8Kc2nLMinfVcAScPMaKvP2gUXrw3njgTAdhlBhUpoPG85puFm3dY7b1b58tpJFeoJ90Labnae4oynAIlF9ipJbOLBaMrA/trs3jX3niaa5RArNNsXmfm59JJh51d6532IKBgLVWikVVSa8SOMK1wG9ZxqWuSU/vay0UlvK6qOsTRL7xxUHkvXZIeZlIwIDAQAB';
const hash = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest();
const id = Array.from(hash.slice(0, 16)).flatMap(b => [String.fromCharCode(97 + (b >> 4)), String.fromCharCode(97 + (b & 0xf))]).join('');
console.log('Extension ID:', id);
console.log('Match:', id === 'akggccfpkleihhemkkikggopnifgelbk');
"
```

Expected: `Extension ID: akggccfpkleihhemkkikggopnifgelbk` and `Match: true`

- [ ] **Step 3: Commit**

```bash
git add manifest.json
git commit -m "feat: update manifest key to match CWS extension ID

Local unpacked builds now produce the same extension ID
(akggccfpkleihhemkkikggopnifgelbk) as the Chrome Web Store version."
```

---

### Task 2: Update Adobe IMS redirect URI

**Files:**

- Modify: `packages/webapp/providers/adobe-config.json:4` (the `extensionRedirectUri` field)

- [ ] **Step 1: Update the redirect URI**

In `packages/webapp/providers/adobe-config.json`, change line 4:

Old:

```json
"extensionRedirectUri": "https://dcebfdclgcnjkpnmhfgoelnkgedglhpo.chromiumapp.org/adobe"
```

New:

```json
"extensionRedirectUri": "https://akggccfpkleihhemkkikggopnifgelbk.chromiumapp.org/adobe"
```

- [ ] **Step 2: Verify the fallback in adobe.ts is consistent**

Read `packages/webapp/providers/adobe.ts:231-233`. The fallback constructs the redirect URI dynamically:

```typescript
const redirectUri = isExtension
  ? (adobeConfig.extensionRedirectUri ?? `https://${(chrome as any).runtime.id}.chromiumapp.org/`)
  : (adobeConfig.redirectUri ?? `${window.location.origin}/auth/callback`);
```

With the Task 1 manifest key change, `chrome.runtime.id` will be `akggccfpkleihhemkkikggopnifgelbk`, so the fallback also produces the correct base URI. The explicit config value adds the `/adobe` path suffix which must match whatever is allowlisted in IMS. No code changes needed in `adobe.ts`.

- [ ] **Step 3: Run build gates**

```bash
npm run typecheck && npm run test && npm run build && npm run build:extension
```

Expected: All four pass.

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/providers/adobe-config.json
git commit -m "fix: update Adobe IMS redirect URI for CWS extension ID

The extension is now published to the Chrome Web Store with ID
akggccfpkleihhemkkikggopnifgelbk. Update the OAuth redirect URI
to match."
```

---

### Task 3: Simplify Sliccstart extension installation to CWS

**Files:**

- Modify: `packages/swift-launcher/Sliccstart/Models/SliccProcess.swift:101-119`
- Modify: `packages/swift-launcher/Sliccstart/Views/AppListView.swift:11,65-87`
- Modify: `packages/swift-launcher/Sliccstart/SliccstartApp.swift:86-100`

- [ ] **Step 1: Replace `guidedInstallExtension` with `openChromeWebStore` in SliccProcess.swift**

Replace lines 101-119 (the `// MARK: - Guided extension install` section) with:

```swift
// MARK: - Chrome Web Store

static let chromeWebStoreURL = "https://chromewebstore.google.com/detail/slicc/akggccfpkleihhemkkikggopnifgelbk"

func openChromeWebStore() {
    if let url = URL(string: Self.chromeWebStoreURL) {
        NSWorkspace.shared.open(url)
    }
}
```

This removes:

- The `chromePath` parameter (no longer needed)
- The `~/.slicc/extension/` copy logic
- The `chrome://extensions` process launch
- The Finder window opening

- [ ] **Step 2: Update AppListView.swift**

Remove the `onGuidedInstall` callback parameter (line 11):

```swift
// DELETE this line:
let onGuidedInstall: (AppTarget) -> Void
```

Update the Extension section (lines 65-87). Replace:

```swift
if let chrome = chromeTarget {
    SectionHeader("Extension")
    Button { onGuidedInstall(chrome) } label: {
        HStack(spacing: 10) {
            Image(systemName: "puzzlepiece.extension")
                .font(.system(size: 15))
                .frame(width: 28, height: 28)
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 1) {
                Text("Install to Chrome")
                    .font(.system(size: 13))
                Text("Guided setup — requires Developer Mode")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
}
```

With:

```swift
SectionHeader("Extension")
Button { sliccProcess.openChromeWebStore() } label: {
    HStack(spacing: 10) {
        Image(systemName: "puzzlepiece.extension")
            .font(.system(size: 15))
            .frame(width: 28, height: 28)
            .foregroundStyle(.orange)
        VStack(alignment: .leading, spacing: 1) {
            Text("Get Extension")
                .font(.system(size: 13))
            Text("Install from Chrome Web Store")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
        }
        Spacer()
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .contentShape(Rectangle())
}
.buttonStyle(.plain)
```

Key changes:

- No longer gated on `if let chrome = chromeTarget` — the CWS link works regardless
- Calls `sliccProcess.openChromeWebStore()` directly instead of the callback
- Label: "Get Extension" / "Install from Chrome Web Store"

- [ ] **Step 3: Update SliccstartApp.swift**

Remove the `onGuidedInstall` callback (lines 86-100) from the `AppListView(...)` constructor call. Delete:

```swift
onGuidedInstall: { target in
    do {
        try sliccProcess.guidedInstallExtension(chromePath: target.executablePath)
        showError(
            "Chrome and Finder are open.\n\n" +
            "In chrome://extensions:\n" +
            "1. Enable 'Developer mode' (top-right toggle)\n" +
            "2. Click 'Load unpacked'\n" +
            "3. Select the ~/.slicc/extension folder shown in Finder\n\n" +
            "Keep Developer Mode enabled — the extension needs it."
        )
    } catch {
        showError("Failed: \(error.localizedDescription)")
    }
},
```

The `AppListView` call no longer takes `onGuidedInstall`.

- [ ] **Step 4: Remove `build:extension` from SliccBootstrapper.swift**

In `bootstrap()` method, delete lines 117-118:

```swift
progressMessage = "Building extension..."
try runSync(npmPath, ["run", "build:extension"], cwd: sliccDir)
```

In `update()` method, delete lines 145-146:

```swift
progressMessage = "Building extension..."
try runSync(npmPath, ["run", "build:extension"], cwd: sliccDir)
```

CWS is now the distribution path — local extension builds are only needed for development.

- [ ] **Step 5: Verify Swift builds**

```bash
cd packages/swift-launcher && swift build 2>&1 | tail -5
```

Expected: Build succeeds with no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/swift-launcher/
git commit -m "feat(sliccstart): replace Load Unpacked flow with Chrome Web Store link

The extension is now on the Chrome Web Store. Replace the manual
Developer Mode / Load Unpacked installation flow with a direct
link to the CWS listing page.

Also removes build:extension from bootstrap/update since CWS
handles distribution."
```

---

### Task 4: Final verification

- [ ] **Step 1: Run all build gates**

```bash
npm run typecheck && npm run test && npm run build && npm run build:extension
```

Expected: All four pass.

- [ ] **Step 2: Verify extension build has correct ID**

```bash
node -e "
const manifest = require('./dist/extension/manifest.json');
const crypto = require('crypto');
const key = manifest.key;
const hash = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest();
const id = Array.from(hash.slice(0, 16)).flatMap(b => [String.fromCharCode(97 + (b >> 4)), String.fromCharCode(97 + (b & 0xf))]).join('');
console.log('Built extension ID:', id);
console.log('Match:', id === 'akggccfpkleihhemkkikggopnifgelbk');
"
```

Expected: `Match: true`
