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

        let exactKey = WebKitInstaller.currentPlatformKey()
        guard
            let resolvedKey = WebKitInstaller.resolvePlatformKey(
                available: WebKitManifest.downloadUrlsByPlatform.keys
            ),
            let urls = WebKitManifest.downloadUrlsByPlatform[resolvedKey],
            !urls.isEmpty
        else {
            installState = .notInstalled
            throw WebKitError.platformUnsupported(exactKey)
        }
        if resolvedKey != exactKey {
            log.info(
                "install: host platform \(exactKey, privacy: .public) not in manifest; falling back to \(resolvedKey, privacy: .public)"
            )
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

    /// Pick the best manifest key for the host. Prefers an exact match,
    /// otherwise falls back to the highest available `mac<N>` (or
    /// `mac<N>-arm64`) for the host's architecture.
    ///
    /// The fallback handles two real cases:
    /// 1. **Host newer than manifest** (e.g. macOS 26 host, manifest stops
    ///    at mac15). Apple's binary compatibility means a mac15 build
    ///    still runs on mac26, so we use the newest available.
    /// 2. **Host older than manifest** (manifest dropped support for the
    ///    host's major). We pick the highest mac major ≤ host instead of
    ///    failing — Playwright would do the same.
    /// If neither rule yields a candidate (no matching arch in manifest),
    /// returns nil and the caller surfaces a `.platformUnsupported` error.
    static func resolvePlatformKey(
        available: some Collection<String>,
        osVersion: OperatingSystemVersion = ProcessInfo.processInfo.operatingSystemVersion,
        machine: String = currentMachine()
    ) -> String? {
        let exact = currentPlatformKey(osVersion: osVersion, machine: machine)
        if available.contains(exact) {
            return exact
        }

        let isArm64 = (machine == "arm64")
        let candidates: [(major: Int, key: String)] = available.compactMap { key in
            guard key.hasPrefix("mac") else { return nil }
            let keyIsArm64 = key.hasSuffix("-arm64")
            guard keyIsArm64 == isArm64 else { return nil }
            var middle = String(key.dropFirst("mac".count))
            if keyIsArm64 {
                middle = String(middle.dropLast("-arm64".count))
            }
            // Take the leading numeric component ("15" from "15", "10" from "10.13").
            guard let major = Int(middle.split(separator: ".").first ?? "") else {
                return nil
            }
            return (major, key)
        }
        if candidates.isEmpty { return nil }

        let host = osVersion.majorVersion
        let leqHost = candidates.filter { $0.major <= host }
        let pool = leqHost.isEmpty ? candidates : leqHost
        return pool.max(by: { $0.major < $1.major })?.key
    }

    /// Build a compact progress string suitable for the narrow Sliccstart
    /// row. With a known Content-Length we get e.g.
    ///   "29% · 23.4/78.2 MB · 5.1 MB/s · 11s"
    /// Without it:
    ///   "23.4 MB · 5.1 MB/s"
    /// Returns "Starting download..." until we have at least one chunk.
    static func formatDownloadProgress(
        bytesDone: Int64,
        totalBytes: Int64,
        elapsed: TimeInterval
    ) -> String {
        guard bytesDone > 0 else { return "Starting download..." }

        let speedPart: String? = {
            guard elapsed > 0.5 else { return nil }
            let bytesPerSec = Double(bytesDone) / elapsed
            guard bytesPerSec > 0 else { return nil }
            return "\(formatBytes(Int64(bytesPerSec)))/s"
        }()

        if totalBytes > 0 {
            let percent = min(100, Int((Double(bytesDone) / Double(totalBytes)) * 100))
            let sizePart = "\(formatBytes(bytesDone))/\(formatBytes(totalBytes))"
            let etaPart: String? = {
                guard elapsed > 0.5 else { return nil }
                let remaining = totalBytes - bytesDone
                guard remaining > 0 else { return nil }
                let bytesPerSec = Double(bytesDone) / elapsed
                guard bytesPerSec > 0 else { return nil }
                return formatDuration(Double(remaining) / bytesPerSec)
            }()
            return ["\(percent)%", sizePart, speedPart, etaPart]
                .compactMap { $0 }
                .joined(separator: " · ")
        }

        return [formatBytes(bytesDone), speedPart]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    /// Format a byte count as KB / MB / GB with one decimal.
    static func formatBytes(_ bytes: Int64) -> String {
        guard bytes > 0 else { return "0 B" }
        let units: [(Double, String)] = [
            (1024.0 * 1024.0 * 1024.0, "GB"),
            (1024.0 * 1024.0, "MB"),
            (1024.0, "KB"),
        ]
        let value = Double(bytes)
        for (scale, label) in units where value >= scale {
            return String(format: "%.1f %@", value / scale, label)
        }
        return "\(bytes) B"
    }

    /// Format a duration as e.g. "5s", "42s", "1m 23s", "12m 5s".
    static func formatDuration(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        if total < 60 {
            return "\(total)s"
        }
        let m = total / 60
        let s = total % 60
        if m < 60 {
            return s == 0 ? "\(m)m" : "\(m)m \(s)s"
        }
        let h = m / 60
        let mm = m % 60
        return mm == 0 ? "\(h)h" : "\(h)h \(mm)m"
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
    let configuration: URLSessionConfiguration

    init(configuration: URLSessionConfiguration = .default) {
        self.configuration = configuration
    }

    func download(
        from url: String,
        to path: String,
        progress: @escaping @Sendable (String) -> Void
    ) async throws {
        guard let parsed = URL(string: url) else {
            throw WebKitManager.WebKitError.downloadFailed(url: url, status: 0, underlying: "invalid URL")
        }

        let delegate = ProgressDownloadDelegate(progress: progress)
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }

        let tempURL: URL = try await withCheckedThrowingContinuation { continuation in
            delegate.continuation = continuation
            let task = session.downloadTask(with: parsed)
            task.resume()
        }
        defer { try? FileManager.default.removeItem(at: tempURL) }

        guard let httpResponse = delegate.response else {
            throw WebKitManager.WebKitError.downloadFailed(url: url, status: 0, underlying: "no response")
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
        progress("Downloaded WebKit (\(WebKitInstaller.formatBytes(httpResponse.expectedContentLength)))")
    }
}

/// URLSessionDownloadDelegate that tunnels:
///   - per-chunk progress callbacks (throttled, formatted with ETA) to the
///     `progress` closure handed in by the installer,
///   - the final downloaded file URL + HTTP response back to the awaiting
///     async caller via a CheckedContinuation.
private final class ProgressDownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let progress: @Sendable (String) -> Void
    fileprivate var continuation: CheckedContinuation<URL, Error>?
    fileprivate var response: HTTPURLResponse?

    private let lock = NSLock()
    private let startedAt = Date()
    private var lastReportedAt: Date = .distantPast
    private var didReportAtLeastOnce = false

    init(progress: @escaping @Sendable (String) -> Void) {
        self.progress = progress
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        let now = Date()
        let shouldReport: Bool = {
            lock.lock()
            defer { lock.unlock() }
            let elapsedSinceLast = now.timeIntervalSince(lastReportedAt)
            // Throttle to ~4 Hz to avoid UI thrashing, but always emit the
            // first chunk so the user sees something quickly.
            if !didReportAtLeastOnce || elapsedSinceLast >= 0.25 {
                lastReportedAt = now
                didReportAtLeastOnce = true
                return true
            }
            return false
        }()
        guard shouldReport else { return }

        let elapsed = now.timeIntervalSince(startedAt)
        progress(WebKitInstaller.formatDownloadProgress(
            bytesDone: totalBytesWritten,
            totalBytes: totalBytesExpectedToWrite,
            elapsed: elapsed
        ))
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        // The system deletes `location` once this delegate method returns,
        // so move to a stable temp path before resuming the continuation.
        if let httpResponse = downloadTask.response as? HTTPURLResponse {
            response = httpResponse
        }
        let staged = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("wk-download-\(UUID().uuidString)")
        do {
            try FileManager.default.moveItem(at: location, to: staged)
            continuation?.resume(returning: staged)
        } catch {
            continuation?.resume(throwing: error)
        }
        continuation = nil
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        guard let error else { return }
        if let httpResponse = task.response as? HTTPURLResponse {
            response = httpResponse
        }
        continuation?.resume(throwing: error)
        continuation = nil
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
