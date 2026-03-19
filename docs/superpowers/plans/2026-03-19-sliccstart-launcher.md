# Sliccstart — Native macOS Launcher

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native macOS app that detects installed Chromium browsers and Electron apps, lets the user launch them with SLICC attached, and optionally installs the SLICC extension persistently into Chrome.

**Architecture:** SwiftUI launcher that scans `/Applications` for eligible targets and spawns Node.js processes. All SLICC intelligence stays in TypeScript — the Swift app is a thin GUI that runs three commands: `node dist/cli/index.js` (browser), `node dist/cli/index.js --electron <app>` (Electron), and `node dist/cli/install-extension.js` (extension install). On first launch, bootstraps the SLICC repo (clone + build). Extension install strategy is implemented entirely in TypeScript so it can be updated via `git pull` without rebuilding the native app.

**Tech Stack:**
- Launcher: Swift 5.9+, SwiftUI, macOS 14+
- Extension installer: TypeScript/Node.js, CDP pipe via `posix_spawn` (child_process)
- CLI server: existing `src/cli/index.ts`

---

## File Structure

### Swift app (new `sliccstart/` directory at repo root)

```
sliccstart/
  Package.swift                  # Swift Package Manager manifest
  Sliccstart/
    SliccstartApp.swift          # App entry point, window config, cleanup on quit
    Models/
      AppTarget.swift            # Data model: detected app (name, path, icon, type)
      AppScanner.swift           # Scans /Applications for Chromium browsers + Electron apps
      SliccProcess.swift         # Spawns Node.js CLI server, monitors lifecycle
      SliccBootstrapper.swift    # First-run: check Node, clone repo, npm install, build
    Views/
      AppListView.swift          # Main list UI (app icons + launch/install buttons)
      SetupProgressView.swift    # First-run progress (clone, install, build)
  SliccstartTests/
    AppScannerTests.swift        # Unit tests for app detection
    SliccBootstrapperTests.swift # Tests for prerequisite checking
```

### TypeScript extension installer (new file in existing `src/cli/`)

```
src/cli/
  install-extension.ts           # Entry point: CDP pipe client + Extensions.loadUnpacked
  install-extension.test.ts      # Tests for CDP message encoding/parsing
```

Build target: `tsconfig.cli.json` already compiles `src/cli/` → `dist/cli/`.

---

## Prerequisites & Context

### What Sliccstart spawns

Sliccstart is a dumb launcher. It runs three Node.js commands:

**1. Browser launch** (like `dev:full`):
```bash
CHROME_PATH=/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  node ~/.slicc/slicc/dist/cli/index.js --cdp-port=9222
```

**2. Electron app launch** (like `dev:electron`):
```bash
node ~/.slicc/slicc/dist/cli/index.js --electron /Applications/Slack.app --kill --cdp-port=9223
```

**3. Extension install** (new):
```bash
node ~/.slicc/slicc/dist/cli/install-extension.js \
  --chrome-path=/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --extension-path=~/.slicc/slicc/dist/extension
```

### SLICC location

Default: `~/.slicc/slicc/` (cloned from GitHub on first run).
The Swift app resolves this once and passes it to all Node.js commands.

### Node.js detection

Check in order: `which node` → `/usr/local/bin/node` → `/opt/homebrew/bin/node` → `~/.nvm/current/bin/node`.
If not found: show error with download link.

### Ports

| Port | Purpose | Used by |
|------|---------|---------|
| 5710 | HTTP UI server | CLI server (browser + electron modes) |
| 9222 | CDP (Chrome) | Browser mode |
| 9223 | CDP (Electron) | Electron mode |

---

## Task 1: TypeScript Extension Installer

> This is the most complex and novel piece. Build it first in TypeScript where it's testable and updatable.

**Files:**
- Create: `src/cli/install-extension.ts`
- Create: `src/cli/install-extension.test.ts`
- Modify: `tsconfig.cli.json` (if needed — should already include `src/cli/`)

### Background

Chrome's `Extensions.loadUnpacked` CDP method requires:
1. `--remote-debugging-pipe` flag (FD 3 read, FD 4 write)
2. `--enable-unsafe-extension-debugging` flag
3. CDP messages are **null-byte delimited** JSON over the pipe

Node.js `child_process.spawn` supports `stdio` array with `'pipe'` entries for arbitrary FDs:
```typescript
spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] })
// index:                    0=stdin  1=stdout 2=stderr 3=read   4=write
```
`child.stdio[3]` is a writable stream (we write, Chrome reads from FD 3).
`child.stdio[4]` is a readable stream (Chrome writes to FD 4, we read).

- [ ] **Step 1: Write failing tests for CDP message encoding/parsing**

Create `src/cli/install-extension.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { encodeCDPMessage, parseCDPResponse } from './install-extension.js';

describe('CDP pipe message encoding', () => {
  it('encodes a method call with params as null-terminated JSON', () => {
    const buf = encodeCDPMessage(1, 'Extensions.loadUnpacked', { path: '/tmp/ext' });
    const str = buf.toString('utf8');
    // Should end with null byte
    expect(str.charCodeAt(str.length - 1)).toBe(0);
    // Should be valid JSON before the null byte
    const json = JSON.parse(str.slice(0, -1));
    expect(json).toEqual({ id: 1, method: 'Extensions.loadUnpacked', params: { path: '/tmp/ext' } });
  });

  it('encodes a method call without params', () => {
    const buf = encodeCDPMessage(2, 'Extensions.getExtensions');
    const json = JSON.parse(buf.toString('utf8').slice(0, -1));
    expect(json).toEqual({ id: 2, method: 'Extensions.getExtensions', params: {} });
  });
});

describe('CDP pipe response parsing', () => {
  it('parses a successful loadUnpacked response', () => {
    const raw = '{"id":1,"result":{"id":"abcdef123456"}}';
    const response = parseCDPResponse(raw);
    expect(response).toEqual({ id: 1, extensionId: 'abcdef123456', error: null });
  });

  it('parses an error response', () => {
    const raw = '{"id":1,"error":{"code":-32000,"message":"Extension not found"}}';
    const response = parseCDPResponse(raw);
    expect(response).toEqual({ id: 1, extensionId: null, error: 'Extension not found' });
  });

  it('returns null for non-JSON input', () => {
    expect(parseCDPResponse('not json')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
npx vitest run src/cli/install-extension.test.ts
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the extension installer**

Create `src/cli/install-extension.ts`:
```typescript
/**
 * Extension Installer — installs the SLICC Chrome extension via CDP pipe.
 *
 * Spawns Chrome with --remote-debugging-pipe + --enable-unsafe-extension-debugging,
 * sends Extensions.loadUnpacked via the CDP pipe, then exits Chrome.
 * The extension persists in Chrome's profile after restart.
 *
 * Usage: node dist/cli/install-extension.js \
 *   --chrome-path=/path/to/chrome \
 *   --extension-path=/path/to/dist/extension
 *
 * This is a standalone entry point (not imported by index.ts) so it can be
 * replaced with a different strategy (e.g., Chrome Web Store link, guided
 * developer mode flow) without touching the rest of the CLI.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

// ── CDP message encoding/decoding ──────────────────────────────────

export function encodeCDPMessage(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): Buffer {
  const json = JSON.stringify({ id, method, params });
  return Buffer.from(json + '\0', 'utf8');
}

export interface CDPResponse {
  id: number;
  extensionId: string | null;
  error: string | null;
}

export function parseCDPResponse(raw: string): CDPResponse | null {
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    const id = typeof msg.id === 'number' ? msg.id : -1;

    if (msg.error && typeof msg.error === 'object') {
      const err = msg.error as Record<string, unknown>;
      return { id, extensionId: null, error: String(err.message ?? 'Unknown error') };
    }

    const result = msg.result as Record<string, unknown> | undefined;
    const extensionId = typeof result?.id === 'string' ? result.id : null;
    return { id, extensionId, error: null };
  } catch {
    return null;
  }
}

// ── Main installer logic ───────────────────────────────────────────

async function installExtension(
  chromePath: string,
  extensionPath: string,
): Promise<void> {
  console.log(`Installing extension from: ${extensionPath}`);
  console.log(`Using Chrome at: ${chromePath}`);

  if (!existsSync(chromePath)) {
    console.error(`Chrome not found at: ${chromePath}`);
    process.exit(1);
  }
  if (!existsSync(extensionPath)) {
    console.error(`Extension not found at: ${extensionPath}`);
    process.exit(1);
  }

  // Spawn Chrome with CDP pipe debugging
  // stdio[3] = pipe (we write → Chrome reads from FD 3)
  // stdio[4] = pipe (Chrome writes to FD 4 → we read)
  const chrome = spawn(chromePath, [
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
  ], {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    detached: false,
  });

  // Forward Chrome stderr for debugging
  chrome.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[chrome] ${line}`);
  });

  // CDP pipe streams
  const cdpWrite = chrome.stdio[3] as import('stream').Writable;
  const cdpRead = chrome.stdio[4] as import('stream').Readable;

  if (!cdpWrite || !cdpRead) {
    console.error('Failed to open CDP pipe streams');
    chrome.kill();
    process.exit(1);
  }

  // Wait for Chrome to initialize
  console.log('Waiting for Chrome to initialize...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Send Extensions.loadUnpacked
  const extensionAbsPath = resolve(extensionPath);
  console.log(`Sending Extensions.loadUnpacked({ path: "${extensionAbsPath}" })...`);
  cdpWrite.write(encodeCDPMessage(1, 'Extensions.loadUnpacked', {
    path: extensionAbsPath,
  }));

  // Read response with timeout
  const response = await new Promise<CDPResponse | null>((resolvePromise) => {
    const timeout = setTimeout(() => {
      cdpRead.removeAllListeners('data');
      resolvePromise(null);
    }, 10000);

    let buffer = '';
    cdpRead.on('data', (data: Buffer) => {
      buffer += data.toString('utf8');
      // CDP pipe messages are null-byte delimited
      const messages = buffer.split('\0');
      buffer = messages.pop() ?? ''; // last segment is incomplete

      for (const msg of messages) {
        if (!msg.trim()) continue;
        const parsed = parseCDPResponse(msg);
        if (parsed && parsed.id === 1) {
          clearTimeout(timeout);
          cdpRead.removeAllListeners('data');
          resolvePromise(parsed);
          return;
        }
      }
    });
  });

  // Handle result
  if (!response) {
    console.error('Timeout waiting for CDP response');
    chrome.kill();
    process.exit(1);
  }

  if (response.error) {
    console.error(`Extension install failed: ${response.error}`);
    chrome.kill();
    process.exit(1);
  }

  console.log(`Extension installed successfully! ID: ${response.extensionId}`);
  console.log('You can now open Chrome normally — the extension will be there.');

  // Terminate Chrome — extension persists in the profile
  chrome.kill();
  process.exit(0);
}

// ── CLI argument parsing ───────────────────────────────────────────

function parseArgs(argv: string[]): { chromePath: string; extensionPath: string } {
  let chromePath = '';
  let extensionPath = '';

  for (const arg of argv) {
    if (arg.startsWith('--chrome-path=')) {
      chromePath = arg.slice('--chrome-path='.length);
    } else if (arg.startsWith('--extension-path=')) {
      extensionPath = arg.slice('--extension-path='.length);
    }
  }

  if (!chromePath || !extensionPath) {
    console.error('Usage: node install-extension.js --chrome-path=<path> --extension-path=<path>');
    process.exit(1);
  }

  return { chromePath, extensionPath };
}

// ── Entry point ────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
installExtension(args.chromePath, args.extensionPath).catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npx vitest run src/cli/install-extension.test.ts
```
Expected: All 5 tests PASS.

- [ ] **Step 5: Verify it compiles**

```bash
npm run build:cli
```
Expected: `dist/cli/install-extension.js` exists.

- [ ] **Step 6: Manual test with real Chrome**

```bash
# Close Chrome first
pkill -f "Google Chrome"
sleep 2

# Run the installer
node dist/cli/install-extension.js \
  --chrome-path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --extension-path="$(pwd)/dist/extension"
```
Expected: Chrome opens briefly, extension installs, Chrome closes. Reopen Chrome → extension visible in chrome://extensions.

- [ ] **Step 7: Commit**

```bash
git add src/cli/install-extension.ts src/cli/install-extension.test.ts
git commit -m "feat: extension installer via CDP pipe (standalone entry point)"
```

---

## Task 2: Xcode Project Scaffold

**Files:**
- Create: `sliccstart/Package.swift`
- Create: `sliccstart/Sliccstart/SliccstartApp.swift`

- [ ] **Step 1: Create directory structure and Package.swift**

```bash
mkdir -p sliccstart/Sliccstart/Models sliccstart/Sliccstart/Views sliccstart/Sliccstart/Utilities sliccstart/SliccstartTests
```

Create `sliccstart/Package.swift`:
```swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Sliccstart",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Sliccstart",
            path: "Sliccstart"
        ),
        .testTarget(
            name: "SliccstartTests",
            dependencies: ["Sliccstart"],
            path: "SliccstartTests"
        ),
    ]
)
```

- [ ] **Step 2: Create the app entry point**

Create `sliccstart/Sliccstart/SliccstartApp.swift`:
```swift
import SwiftUI

@main
struct SliccstartApp: App {
    var body: some Scene {
        WindowGroup {
            Text("Sliccstart")
                .font(.title)
                .padding()
        }
        .windowStyle(.titleBar)
        .windowResizability(.contentSize)
        .defaultSize(width: 420, height: 600)
    }
}
```

- [ ] **Step 3: Verify it builds and launches**

```bash
cd sliccstart && swift build && swift run Sliccstart
```
Expected: A window with "Sliccstart" text appears.

- [ ] **Step 4: Commit**

```bash
git add sliccstart/
git commit -m "feat(sliccstart): scaffold native macOS launcher project"
```

---

## Task 3: App Detection — Model & Scanner

**Files:**
- Create: `sliccstart/Sliccstart/Models/AppTarget.swift`
- Create: `sliccstart/Sliccstart/Models/AppScanner.swift`
- Test: `sliccstart/SliccstartTests/AppScannerTests.swift`

- [ ] **Step 1: Write failing tests**

Create `sliccstart/SliccstartTests/AppScannerTests.swift`:
```swift
import Testing
@testable import Sliccstart

@Test func detectsChromiumBrowserByBundleId() {
    #expect(AppScanner.isChromiumBrowser(bundleId: "com.google.Chrome") == true)
}

@Test func rejectsNonChromiumBundleId() {
    #expect(AppScanner.isChromiumBrowser(bundleId: "com.apple.Safari") == false)
}

@Test func detectsElectronAppByFramework() {
    #expect(AppScanner.hasElectronFramework(atPath: "/nonexistent/Fake.app") == false)
}

@Test func extractsAppNameFromPath() {
    #expect(AppScanner.appName(fromPath: "/Applications/Slack.app") == "Slack")
}

@Test func resolvesExecutablePath() {
    #expect(AppScanner.executablePath(forApp: "/Applications/Slack.app", name: "Slack")
        == "/Applications/Slack.app/Contents/MacOS/Slack")
}
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd sliccstart && swift test
```

- [ ] **Step 3: Implement AppTarget and AppScanner**

Create `sliccstart/Sliccstart/Models/AppTarget.swift`:
```swift
import AppKit

enum AppTargetType: String, Codable {
    case chromiumBrowser
    case electronApp
}

struct AppTarget: Identifiable {
    let id: String              // bundle path
    let name: String            // display name
    let path: String            // /Applications/Foo.app
    let executablePath: String  // /Applications/Foo.app/Contents/MacOS/Foo
    let type: AppTargetType
    let icon: NSImage

    static let knownChromiumBrowsers: [(bundleId: String, name: String)] = [
        ("com.google.Chrome", "Google Chrome"),
        ("com.google.Chrome.canary", "Chrome Canary"),
        ("com.brave.Browser", "Brave Browser"),
        ("com.microsoft.edgemac", "Microsoft Edge"),
        ("com.vivaldi.Vivaldi", "Vivaldi"),
        ("com.operasoftware.Opera", "Opera"),
        ("org.chromium.Chromium", "Chromium"),
    ]
}
```

Create `sliccstart/Sliccstart/Models/AppScanner.swift`:
```swift
import AppKit

final class AppScanner {
    static func scan() -> [AppTarget] {
        var targets: [AppTarget] = []

        // Known Chromium browsers by bundle ID
        for (bundleId, displayName) in AppTarget.knownChromiumBrowsers {
            guard let url = NSWorkspace.shared.urlForApplication(
                withBundleIdentifier: bundleId
            ) else { continue }
            let path = url.path
            let name = appName(fromPath: path)
            let icon = NSWorkspace.shared.icon(forFile: path)
            targets.append(AppTarget(
                id: path, name: displayName, path: path,
                executablePath: executablePath(forApp: path, name: name),
                type: .chromiumBrowser, icon: icon
            ))
        }

        // Scan /Applications for Electron apps
        let fm = FileManager.default
        guard let contents = try? fm.contentsOfDirectory(atPath: "/Applications") else {
            return targets
        }
        for item in contents where item.hasSuffix(".app") {
            let appPath = "/Applications/\(item)"
            if targets.contains(where: { $0.path == appPath }) { continue }
            guard hasElectronFramework(atPath: appPath) else { continue }
            let name = appName(fromPath: appPath)
            let icon = NSWorkspace.shared.icon(forFile: appPath)
            targets.append(AppTarget(
                id: appPath, name: name, path: appPath,
                executablePath: executablePath(forApp: appPath, name: name),
                type: .electronApp, icon: icon
            ))
        }

        return targets.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    static func isChromiumBrowser(bundleId: String) -> Bool {
        AppTarget.knownChromiumBrowsers.contains { $0.bundleId == bundleId }
    }

    static func hasElectronFramework(atPath appPath: String) -> Bool {
        FileManager.default.fileExists(
            atPath: "\(appPath)/Contents/Frameworks/Electron Framework.framework"
        )
    }

    static func appName(fromPath path: String) -> String {
        let filename = (path as NSString).lastPathComponent
        return filename.hasSuffix(".app") ? String(filename.dropLast(4)) : filename
    }

    static func executablePath(forApp appPath: String, name: String) -> String {
        "\(appPath)/Contents/MacOS/\(name)"
    }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd sliccstart && swift test
```

- [ ] **Step 5: Commit**

```bash
git add sliccstart/
git commit -m "feat(sliccstart): app detection — scan for Chromium browsers and Electron apps"
```

---

## Task 4: SLICC Bootstrapper (First-Run Setup)

**Files:**
- Create: `sliccstart/Sliccstart/Models/SliccBootstrapper.swift`
- Test: `sliccstart/SliccstartTests/SliccBootstrapperTests.swift`

- [ ] **Step 1: Write failing tests**

Create `sliccstart/SliccstartTests/SliccBootstrapperTests.swift`:
```swift
import Testing
@testable import Sliccstart

@Test func defaultSliccDir() {
    #expect(SliccBootstrapper.defaultSliccDir.hasSuffix(".slicc/slicc"))
}

@Test func detectsMissingSliccInstall() {
    #expect(SliccBootstrapper.checkInstallation(sliccDir: "/nonexistent") == .notInstalled)
}
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd sliccstart && swift test
```

- [ ] **Step 3: Implement bootstrapper**

Create `sliccstart/Sliccstart/Models/SliccBootstrapper.swift`:
```swift
import Foundation

enum InstallationStatus: Equatable {
    case notInstalled
    case needsBuild
    case installed
}

@Observable
final class SliccBootstrapper {
    static let repoURL = "https://github.com/ai-ecoverse/slicc.git"

    static var defaultSliccDir: String {
        NSHomeDirectory() + "/.slicc/slicc"
    }

    var progressMessage = ""
    var isWorking = false
    var lastError: String?

    static func findNode() -> String? {
        // Check common locations
        for candidate in [
            "/usr/local/bin/node",
            "/opt/homebrew/bin/node",
            NSHomeDirectory() + "/.nvm/current/bin/node",
        ] {
            if FileManager.default.fileExists(atPath: candidate) { return candidate }
        }
        // Try PATH via which
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        task.arguments = ["node"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        try? task.run()
        task.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return output.isEmpty ? nil : output
    }

    static func checkInstallation(sliccDir: String = defaultSliccDir) -> InstallationStatus {
        let fm = FileManager.default
        guard fm.fileExists(atPath: sliccDir + "/package.json") else { return .notInstalled }
        guard fm.fileExists(atPath: sliccDir + "/dist/cli/index.js") else { return .needsBuild }
        return .installed
    }

    func bootstrap(sliccDir: String = SliccBootstrapper.defaultSliccDir) async throws {
        isWorking = true
        lastError = nil
        defer { isWorking = false }

        guard let nodePath = Self.findNode() else {
            throw BootstrapError.nodeNotFound
        }
        let npmPath = (nodePath as NSString).deletingLastPathComponent + "/npm"
        let fm = FileManager.default

        // Clone if needed
        if !fm.fileExists(atPath: sliccDir + "/package.json") {
            progressMessage = "Cloning SLICC repository..."
            try fm.createDirectory(
                atPath: (sliccDir as NSString).deletingLastPathComponent,
                withIntermediateDirectories: true
            )
            try runSync("/usr/bin/git", ["clone", "--depth", "1", Self.repoURL, sliccDir])
        }

        // npm install
        progressMessage = "Installing dependencies..."
        try runSync(npmPath, ["install"], cwd: sliccDir)

        // Build
        progressMessage = "Building SLICC..."
        try runSync(npmPath, ["run", "build"], cwd: sliccDir)

        progressMessage = "Building extension..."
        try runSync(npmPath, ["run", "build:extension"], cwd: sliccDir)

        progressMessage = "Ready!"
    }

    func update(sliccDir: String = SliccBootstrapper.defaultSliccDir) async throws {
        isWorking = true
        lastError = nil
        defer { isWorking = false }

        guard let nodePath = Self.findNode() else { throw BootstrapError.nodeNotFound }
        let npmPath = (nodePath as NSString).deletingLastPathComponent + "/npm"

        progressMessage = "Pulling latest..."
        try runSync("/usr/bin/git", ["pull"], cwd: sliccDir)

        progressMessage = "Installing dependencies..."
        try runSync(npmPath, ["install"], cwd: sliccDir)

        progressMessage = "Building..."
        try runSync(npmPath, ["run", "build"], cwd: sliccDir)

        progressMessage = "Building extension..."
        try runSync(npmPath, ["run", "build:extension"], cwd: sliccDir)

        progressMessage = "Updated!"
    }

    private func runSync(_ command: String, _ args: [String], cwd: String? = nil) throws {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: command)
        task.arguments = args
        if let cwd { task.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        try task.run()
        task.waitUntilExit()
        guard task.terminationStatus == 0 else {
            throw BootstrapError.commandFailed("\(command) \(args.joined(separator: " "))")
        }
    }

    enum BootstrapError: LocalizedError {
        case nodeNotFound
        case commandFailed(String)
        var errorDescription: String? {
            switch self {
            case .nodeNotFound: return "Node.js not found. Install from https://nodejs.org"
            case .commandFailed(let cmd): return "Command failed: \(cmd)"
            }
        }
    }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd sliccstart && swift test
```

- [ ] **Step 5: Commit**

```bash
git add sliccstart/
git commit -m "feat(sliccstart): bootstrapper — clone, install, and build SLICC on first run"
```

---

## Task 5: SLICC Process Manager

**Files:**
- Create: `sliccstart/Sliccstart/Models/SliccProcess.swift`

Sliccstart spawns Node.js as a child process. This class manages the lifecycle.

- [ ] **Step 1: Implement process manager**

Create `sliccstart/Sliccstart/Models/SliccProcess.swift`:
```swift
import Foundation

@Observable
final class SliccProcess {
    private var process: Process?
    private(set) var isRunning = false
    private(set) var target: AppTarget?

    private var sliccDir: String { SliccBootstrapper.defaultSliccDir }

    func launchWithBrowser(_ browser: AppTarget) throws {
        guard !isRunning else { return }
        target = browser
        guard let nodePath = SliccBootstrapper.findNode() else {
            throw LaunchError.nodeNotFound
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [sliccDir + "/dist/cli/index.js", "--cdp-port=9222"]
        proc.environment = ProcessInfo.processInfo.environment.merging([
            "CHROME_PATH": browser.executablePath,
            "PORT": "5710",
        ]) { _, new in new }
        proc.currentDirectoryURL = URL(fileURLWithPath: sliccDir)
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        proc.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.markStopped() }
        }

        try proc.run()
        process = proc
        isRunning = true
    }

    func launchWithElectronApp(_ app: AppTarget) throws {
        guard !isRunning else { return }
        target = app
        guard let nodePath = SliccBootstrapper.findNode() else {
            throw LaunchError.nodeNotFound
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [
            sliccDir + "/dist/cli/index.js",
            "--electron", app.path,
            "--kill",
            "--cdp-port=9223",
        ]
        proc.environment = ProcessInfo.processInfo.environment.merging([
            "PORT": "5710",
        ]) { _, new in new }
        proc.currentDirectoryURL = URL(fileURLWithPath: sliccDir)
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        proc.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.markStopped() }
        }

        try proc.run()
        process = proc
        isRunning = true
    }

    func installExtension(_ browser: AppTarget) throws {
        guard let nodePath = SliccBootstrapper.findNode() else {
            throw LaunchError.nodeNotFound
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [
            sliccDir + "/dist/cli/install-extension.js",
            "--chrome-path=\(browser.executablePath)",
            "--extension-path=\(sliccDir)/dist/extension",
        ]
        proc.currentDirectoryURL = URL(fileURLWithPath: sliccDir)
        try proc.run()
        proc.waitUntilExit()

        if proc.terminationStatus != 0 {
            throw LaunchError.extensionInstallFailed
        }
    }

    func stop() {
        process?.terminate()
        markStopped()
    }

    private func markStopped() {
        isRunning = false
        target = nil
        process = nil
    }

    enum LaunchError: LocalizedError {
        case nodeNotFound
        case extensionInstallFailed
        var errorDescription: String? {
            switch self {
            case .nodeNotFound: return "Node.js not found"
            case .extensionInstallFailed: return "Extension installation failed"
            }
        }
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add sliccstart/Sliccstart/Models/SliccProcess.swift
git commit -m "feat(sliccstart): process manager — launch browser, Electron, and extension install"
```

---

## Task 6: Main UI

**Files:**
- Create: `sliccstart/Sliccstart/Views/AppListView.swift`
- Create: `sliccstart/Sliccstart/Views/SetupProgressView.swift`
- Modify: `sliccstart/Sliccstart/SliccstartApp.swift`

- [ ] **Step 1: Create SetupProgressView**

Create `sliccstart/Sliccstart/Views/SetupProgressView.swift`:
```swift
import SwiftUI

struct SetupProgressView: View {
    let message: String
    let isWorking: Bool
    let error: String?
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            if isWorking {
                ProgressView()
                    .controlSize(.large)
            }
            Text(message)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if error != nil {
                Button("Retry") { onRetry() }
                    .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(32)
    }
}
```

- [ ] **Step 2: Create AppListView**

Create `sliccstart/Sliccstart/Views/AppListView.swift`:
```swift
import SwiftUI

struct AppListView: View {
    let targets: [AppTarget]
    @Bindable var sliccProcess: SliccProcess
    let onLaunchBrowser: (AppTarget) -> Void
    let onLaunchElectron: (AppTarget) -> Void
    let onInstallExtension: (AppTarget) -> Void
    let onUpdate: () -> Void
    let onRescan: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Text("Sliccstart")
                .font(.headline)
                .padding(.vertical, 12)
            Text("Launch an app from the list below.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.bottom, 8)
            Divider()

            List {
                let browsers = targets.filter { $0.type == .chromiumBrowser }
                if !browsers.isEmpty {
                    Section("Browsers") {
                        ForEach(browsers) { target in
                            AppRow(
                                target: target,
                                isRunning: sliccProcess.target?.id == target.id && sliccProcess.isRunning,
                                showInstallButton: target.name.contains("Chrome"),
                                onLaunch: { onLaunchBrowser(target) },
                                onInstallExtension: { onInstallExtension(target) }
                            )
                        }
                    }
                }
                let electronApps = targets.filter { $0.type == .electronApp }
                if !electronApps.isEmpty {
                    Section("Electron Apps") {
                        ForEach(electronApps) { target in
                            AppRow(
                                target: target,
                                isRunning: sliccProcess.target?.id == target.id && sliccProcess.isRunning,
                                showInstallButton: false,
                                onLaunch: { onLaunchElectron(target) },
                                onInstallExtension: {}
                            )
                        }
                    }
                }
            }
            .listStyle(.inset)

            Divider()
            HStack {
                Button("Update SLICC") { onUpdate() }
                    .buttonStyle(.borderless).font(.caption)
                Spacer()
                Button("Rescan") { onRescan() }
                    .buttonStyle(.borderless).font(.caption)
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
        }
    }
}

struct AppRow: View {
    let target: AppTarget
    let isRunning: Bool
    let showInstallButton: Bool
    let onLaunch: () -> Void
    let onInstallExtension: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(nsImage: target.icon)
                .resizable().frame(width: 32, height: 32)
            Text(target.name).font(.body)
            Spacer()
            if isRunning {
                Circle().fill(.green).frame(width: 8, height: 8)
            }
            if showInstallButton {
                Button { onInstallExtension() } label: {
                    Image(systemName: "puzzlepiece.extension").font(.system(size: 14))
                }
                .buttonStyle(.borderless)
                .help("Install SLICC extension permanently")
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { onLaunch() }
    }
}
```

- [ ] **Step 3: Wire up SliccstartApp**

Replace `sliccstart/Sliccstart/SliccstartApp.swift`:
```swift
import SwiftUI

@main
struct SliccstartApp: App {
    @State private var bootstrapper = SliccBootstrapper()
    @State private var sliccProcess = SliccProcess()
    @State private var targets: [AppTarget] = []
    @State private var isReady = false

    var body: some Scene {
        WindowGroup {
            Group {
                if !isReady {
                    SetupProgressView(
                        message: bootstrapper.progressMessage,
                        isWorking: bootstrapper.isWorking,
                        error: bootstrapper.lastError,
                        onRetry: { Task { await initialize() } }
                    )
                } else {
                    AppListView(
                        targets: targets,
                        sliccProcess: sliccProcess,
                        onLaunchBrowser: { target in
                            sliccProcess.stop()
                            try? sliccProcess.launchWithBrowser(target)
                        },
                        onLaunchElectron: { target in
                            sliccProcess.stop()
                            try? sliccProcess.launchWithElectronApp(target)
                        },
                        onInstallExtension: { target in
                            Task.detached {
                                try? sliccProcess.installExtension(target)
                            }
                        },
                        onUpdate: {
                            Task {
                                isReady = false
                                try? await bootstrapper.update()
                                targets = AppScanner.scan()
                                isReady = true
                            }
                        },
                        onRescan: { targets = AppScanner.scan() }
                    )
                }
            }
            .frame(width: 420, minHeight: 400)
            .task { await initialize() }
            .onDisappear { sliccProcess.stop() }
        }
        .windowStyle(.titleBar)
        .windowResizability(.contentMinSize)
    }

    private func initialize() async {
        let status = SliccBootstrapper.checkInstallation()
        if status != .installed {
            do {
                try await bootstrapper.bootstrap()
            } catch {
                bootstrapper.lastError = error.localizedDescription
                bootstrapper.progressMessage = error.localizedDescription
                return
            }
        }
        targets = AppScanner.scan()
        isReady = true
    }
}
```

- [ ] **Step 4: Build and run**

```bash
cd sliccstart && swift build && swift run Sliccstart
```
Expected: Window shows detected browsers and Electron apps with icons.

- [ ] **Step 5: Commit**

```bash
git add sliccstart/
git commit -m "feat(sliccstart): main UI — app list, setup, update, extension install"
```

---

## Task 7: Documentation

**Files:**
- Create: `sliccstart/README.md`
- Modify: `CLAUDE.md` — add Sliccstart to Floats and Architecture sections
- Modify: `docs/architecture.md` — add Sliccstart section

- [ ] **Step 1: Create sliccstart/README.md**

```markdown
# Sliccstart

Native macOS launcher for SLICC. Detects Chromium browsers and Electron apps,
launches them with SLICC attached.

## Requirements

- macOS 14+
- Node.js 22+ (LTS)
- Xcode 15+ or Swift 5.9+ (to build from source)

## Build & Run

    cd sliccstart
    swift build
    swift run Sliccstart

## First Launch

On first run, Sliccstart clones the SLICC repository to `~/.slicc/slicc/`
and builds it. This takes 2-3 minutes. Subsequent launches are instant.

## Features

- **Launch browser**: Click any Chromium browser to start SLICC CLI server
  with that browser (like `npm run dev:full` but with browser choice).
- **Launch Electron app**: Click any Electron app to attach SLICC as an
  overlay (like `npm run dev:electron`).
- **Install extension**: Click the puzzle piece icon next to Chrome to
  permanently install the SLICC extension via CDP pipe.
- **Update**: Click "Update SLICC" to pull latest changes and rebuild.

## Architecture

Sliccstart is a thin GUI. All intelligence lives in SLICC's TypeScript code:

| Action | What Sliccstart runs |
|--------|---------------------|
| Launch browser | `node dist/cli/index.js --cdp-port=9222` with `CHROME_PATH` env |
| Launch Electron | `node dist/cli/index.js --electron /path/to/app --kill` |
| Install extension | `node dist/cli/install-extension.js --chrome-path=... --extension-path=...` |
| Update | `git pull && npm install && npm run build && npm run build:extension` |

The extension install strategy is in TypeScript (`src/cli/install-extension.ts`)
so it can be updated via `git pull` without rebuilding the native app.
```

- [ ] **Step 2: Update CLAUDE.md** — add to Architecture section after Electron float:

```markdown
- **Sliccstart** (`sliccstart/`): Native macOS SwiftUI launcher. Scans `/Applications` for Chromium browsers and Electron apps, spawns `node dist/cli/index.js` with appropriate flags. Extension install delegates to `node dist/cli/install-extension.js`. All SLICC logic stays in TypeScript — Sliccstart is a thin GUI.
```

- [ ] **Step 3: Update docs/architecture.md** — add Sliccstart entry to file listing and a brief section

- [ ] **Step 4: Commit**

```bash
git add sliccstart/README.md CLAUDE.md docs/architecture.md
git commit -m "docs: add Sliccstart launcher documentation"
```

---

## Task 8: Integration Testing & Verification

- [ ] **Step 1: Run SLICC build gates** (verify no regressions)

```bash
npm run typecheck && npm run test && npm run build && npm run build:extension
```

- [ ] **Step 2: Run Sliccstart tests**

```bash
cd sliccstart && swift test
```

- [ ] **Step 3: Manual test — browser launch**

1. `cd sliccstart && swift run Sliccstart`
2. Click "Google Chrome"
3. Verify: Chrome opens with SLICC UI at localhost:5710
4. Verify: Green dot next to Chrome in Sliccstart

- [ ] **Step 4: Manual test — Electron app launch**

1. Click "Slack" (or another Electron app)
2. Verify: App opens with SLICC overlay
3. Verify: Green dot appears

- [ ] **Step 5: Manual test — extension install**

1. Click puzzle piece icon next to Chrome
2. Verify: Chrome opens briefly and closes
3. Open Chrome normally → verify extension in chrome://extensions

- [ ] **Step 6: Manual test — update**

1. Click "Update SLICC"
2. Verify: progress indicator, then "Updated!"
3. Verify: SLICC still works after update
