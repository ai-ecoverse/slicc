import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "WebKitManager")

enum WebKitInstallState: Equatable {
    case notInstalled
    case installing
    case installed(binaryPath: String, frameworkPath: String)
}

@Observable
final class WebKitManager {
    var installState: WebKitInstallState = .notInstalled
    var installProgress: String = ""

    /// The base directory where Playwright caches browsers
    private static var playwrightCacheDir: String {
        NSHomeDirectory() + "/Library/Caches/ms-playwright"
    }

    /// Check if Playwright's patched WebKit is installed and return its paths.
    ///
    /// We accept any `webkit-*` directory (not just `webkit-<manifestRevision>`)
    /// so that an existing `npx playwright install webkit` payload from before
    /// Sliccstart adopted the bundled installer is still picked up. The launch
    /// path doesn't care which exact revision is on disk — it just needs the
    /// `Playwright.app/Contents/MacOS/Playwright` Mach-O binary.
    static func detectWebKit() -> WebKitInstallState {
        let fm = FileManager.default
        let cacheDir = playwrightCacheDir

        guard fm.fileExists(atPath: cacheDir) else {
            log.info("detectWebKit: playwright cache dir not found")
            return .notInstalled
        }

        guard let contents = try? fm.contentsOfDirectory(atPath: cacheDir) else {
            return .notInstalled
        }

        // Prefer the manifest revision if present, then fall back to any
        // webkit-* directory (newest first).
        let preferred = WebKitManifest.installDirName
        var ordered = [String]()
        if contents.contains(preferred) {
            ordered.append(preferred)
        }
        ordered.append(
            contentsOf: contents
                .filter { $0.hasPrefix("webkit-") && $0 != preferred }
                .sorted { $0.localizedStandardCompare($1) == .orderedDescending }
        )

        for dir in ordered {
            let webkitDir = "\(cacheDir)/\(dir)"
            let playwrightApp = "\(webkitDir)/Playwright.app"
            let binaryPath = "\(playwrightApp)/Contents/MacOS/Playwright"

            if fm.fileExists(atPath: binaryPath) {
                log.info("detectWebKit: found at \(webkitDir, privacy: .public)")
                return .installed(binaryPath: binaryPath, frameworkPath: webkitDir)
            }
        }

        log.info("detectWebKit: no Playwright.app found in webkit dirs")
        return .notInstalled
    }

    /// Refresh the install state by checking the filesystem
    func refresh() {
        if case .installing = installState { return }
        installState = Self.detectWebKit()
    }

    /// Install Playwright's patched WebKit by downloading the archive
    /// directly from the CDN. Mirrors the layout that
    /// `npx playwright install webkit` produces.
    func install() async throws {
        guard case .notInstalled = installState else { return }

        installState = .installing
        installProgress = "Resolving WebKit archive..."

        let platformKey = WebKitInstaller.currentPlatformKey()
        guard let urls = WebKitManifest.downloadUrlsByPlatform[platformKey], !urls.isEmpty else {
            installState = .notInstalled
            throw WebKitError.platformUnsupported(platformKey)
        }

        let cacheDir = Self.playwrightCacheDir
        let installDir = "\(cacheDir)/\(WebKitManifest.installDirName)"

        do {
            try await WebKitInstaller.installArchive(
                urls: urls,
                cacheDir: cacheDir,
                installDir: installDir,
                progress: { [weak self] message in
                    guard let self else { return }
                    Task { @MainActor in
                        self.installProgress = message
                    }
                }
            )
        } catch {
            log.error("install: download/extract failed: \(error.localizedDescription, privacy: .public)")
            installState = .notInstalled
            throw error
        }

        installProgress = "WebKit installed!"
        let detected = Self.detectWebKit()
        installState = detected

        guard case .installed = detected else {
            throw WebKitError.installFailed("Installation completed but WebKit binary not found")
        }
    }

    /// Whether WebKit is ready to launch
    var isInstalled: Bool {
        if case .installed = installState { return true }
        return false
    }

    /// Whether an install is in progress
    var isInstalling: Bool {
        if case .installing = installState { return true }
        return false
    }

    enum WebKitError: LocalizedError {
        case platformUnsupported(String)
        case installFailed(String)
        case downloadFailed(url: String, status: Int, underlying: String?)
        case extractFailed(String)
        var errorDescription: String? {
            switch self {
            case .platformUnsupported(let key):
                return "WebKit installation is not supported on this platform (\(key))."
            case .installFailed(let detail):
                return "WebKit installation failed: \(detail)"
            case .downloadFailed(let url, let status, let underlying):
                if let underlying {
                    return "Failed to download \(url): \(underlying) (status \(status))"
                }
                return "Failed to download \(url): HTTP \(status)"
            case .extractFailed(let detail):
                return "Failed to extract WebKit archive: \(detail)"
            }
        }
    }
}

/// Pure helpers for the WebKit installer flow. Split out from the
/// observable so they can be unit-tested without touching the UI state.
enum WebKitInstaller {
    /// Build the Playwright `shortPlatform` string for the current host:
    ///   "mac<major>" on x86_64, "mac<major>-arm64" on Apple Silicon.
    static func currentPlatformKey(
        osVersion: OperatingSystemVersion = ProcessInfo.processInfo.operatingSystemVersion,
        machine: String = currentMachine()
    ) -> String {
        let major = osVersion.majorVersion
        let suffix = (machine == "arm64") ? "-arm64" : ""
        return "mac\(major)\(suffix)"
    }

    /// Resolve the host machine architecture (`arm64` or `x86_64`).
    static func currentMachine() -> String {
        var sysinfo = utsname()
        guard uname(&sysinfo) == 0 else { return "" }
        let capacity = MemoryLayout.size(ofValue: sysinfo.machine)
        return withUnsafePointer(to: &sysinfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: capacity) {
                String(cString: $0)
            }
        }
    }

    /// Download the archive from the first URL that succeeds, then extract
    /// it into `installDir`. The directory layout matches the one
    /// `npx playwright install webkit` produces, so the existing
    /// `WebKitManager.detectWebKit()` happy path keeps working.
    static func installArchive(
        urls: [String],
        cacheDir: String,
        installDir: String,
        progress: @escaping @Sendable (String) -> Void,
        downloader: WebKitDownloader = URLSessionWebKitDownloader(),
        extractor: WebKitExtractor = DittoWebKitExtractor()
    ) async throws {
        let fm = FileManager.default
        try fm.createDirectory(atPath: cacheDir, withIntermediateDirectories: true)

        // Download into a temp path under cacheDir so the eventual move is on
        // the same volume (atomic, no cross-volume copies).
        let tempZip = "\(cacheDir)/.webkit-\(WebKitManifest.revision)-\(UUID().uuidString).zip"
        defer { try? fm.removeItem(atPath: tempZip) }

        var lastError: Error?
        var downloaded = false
        for (index, url) in urls.enumerated() {
            progress("Downloading WebKit (\(index + 1)/\(urls.count))...")
            do {
                try await downloader.download(from: url, to: tempZip, progress: progress)
                downloaded = true
                break
            } catch {
                log.warning("download attempt \(index + 1) of \(urls.count) failed: \(error.localizedDescription, privacy: .public)")
                lastError = error
            }
        }

        guard downloaded else {
            throw lastError ?? WebKitManager.WebKitError.installFailed("All CDN mirrors failed")
        }

        progress("Extracting WebKit...")

        // Extract into a sibling temp dir so a partial extraction doesn't
        // leave a half-populated installDir for detectWebKit to find.
        let tempExtract = "\(cacheDir)/.webkit-extract-\(UUID().uuidString)"
        defer { try? fm.removeItem(atPath: tempExtract) }
        try fm.createDirectory(atPath: tempExtract, withIntermediateDirectories: true)
        try extractor.extract(archivePath: tempZip, destinationDir: tempExtract)

        // Move into final location atomically. If installDir already exists
        // (partial previous run), replace it.
        if fm.fileExists(atPath: installDir) {
            try fm.removeItem(atPath: installDir)
        }
        try fm.moveItem(atPath: tempExtract, toPath: installDir)

        // ditto preserves POSIX modes from the zip, but be defensive —
        // the cost is negligible and we depend on this binary being
        // exec-bit set.
        let binaryPath = "\(installDir)/Playwright.app/Contents/MacOS/Playwright"
        if fm.fileExists(atPath: binaryPath) {
            try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binaryPath)
        }
    }
}

/// Abstraction over the network download. Allows tests to substitute a
/// local-file fake without standing up an HTTP server.
protocol WebKitDownloader: Sendable {
    func download(from url: String, to path: String, progress: @escaping @Sendable (String) -> Void) async throws
}

struct URLSessionWebKitDownloader: WebKitDownloader {
    let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func download(from url: String, to path: String, progress: @escaping @Sendable (String) -> Void) async throws {
        guard let parsed = URL(string: url) else {
            throw WebKitManager.WebKitError.downloadFailed(url: url, status: 0, underlying: "invalid URL")
        }

        let (tempURL, response) = try await session.download(from: parsed)
        defer { try? FileManager.default.removeItem(at: tempURL) }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw WebKitManager.WebKitError.downloadFailed(url: url, status: 0, underlying: "non-HTTP response")
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw WebKitManager.WebKitError.downloadFailed(
                url: url,
                status: httpResponse.statusCode,
                underlying: nil
            )
        }

        let fm = FileManager.default
        if fm.fileExists(atPath: path) {
            try fm.removeItem(atPath: path)
        }
        try fm.moveItem(at: tempURL, to: URL(fileURLWithPath: path))
        progress("Downloaded WebKit archive")
    }
}

/// Abstraction over the archive-extract step. Real implementation shells
/// out to `/usr/bin/ditto`, the macOS-native tool used by Archive Utility,
/// the App Store, and Xcode to unpack signed `.app` bundles. Unlike BSD
/// `unzip`, ditto preserves extended attributes, resource forks, and code
/// signature metadata correctly, which matters here because the archive
/// contains a signed `Playwright.app`.
protocol WebKitExtractor: Sendable {
    func extract(archivePath: String, destinationDir: String) throws
}

struct DittoWebKitExtractor: WebKitExtractor {
    func extract(archivePath: String, destinationDir: String) throws {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        // -x extract, -k PKZip archive format
        task.arguments = ["-x", "-k", archivePath, destinationDir]

        let stderrPipe = Pipe()
        task.standardError = stderrPipe
        task.standardOutput = FileHandle.nullDevice

        try task.run()
        task.waitUntilExit()

        guard task.terminationStatus == 0 else {
            let stderr = String(
                data: stderrPipe.fileHandleForReading.readDataToEndOfFile(),
                encoding: .utf8
            )?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            throw WebKitManager.WebKitError.extractFailed(
                stderr.isEmpty ? "ditto exit \(task.terminationStatus)" : stderr
            )
        }
    }
}
