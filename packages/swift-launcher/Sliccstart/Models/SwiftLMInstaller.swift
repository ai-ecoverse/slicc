import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "SwiftLMInstaller")

/// Resolves the path to a usable SwiftLM binary, downloading the pinned
/// release tarball into `~/.slicc/SwiftLM/<version>/` on first use.
///
/// SwiftLM upstream cannot be consumed as a Swift Package dependency because
/// (a) their `Package.swift` references local-path forks of MLX via git
/// submodules SPM does not init, and (b) their release artifact is a
/// `.tar.gz` rather than an `.xcframework.zip` `.binaryTarget` accepts.
/// Renovate still bumps the pinned version via the marker in
/// `SwiftLMVersion.swift`, so the install path stays out of the way.
@Observable
final class SwiftLMInstaller {
    enum State: Equatable {
        case idle
        case downloading(Double)
        case extracting
        case ready
        case failed(String)
    }

    enum InstallError: LocalizedError {
        case downloadFailed(status: Int)
        case extractFailed(stderr: String)
        case binaryMissing(URL)

        var errorDescription: String? {
            switch self {
            case .downloadFailed(let status): return "SwiftLM download returned HTTP \(status)"
            case .extractFailed(let stderr): return "tar extract failed: \(stderr)"
            case .binaryMissing(let url): return "SwiftLM binary not found at \(url.path)"
            }
        }
    }

    private(set) var state: State = .idle

    /// `~/.slicc/SwiftLM/<pinned-version>` — versioned so a Renovate bump
    /// installs alongside instead of clobbering, easing rollback.
    var versionDirectory: URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home
            .appendingPathComponent(".slicc", isDirectory: true)
            .appendingPathComponent("SwiftLM", isDirectory: true)
            .appendingPathComponent(SwiftLMVersion.pinned, isDirectory: true)
    }

    /// Path the SwiftLM binary will live at after extraction (next to
    /// `mlx.metallib`, which the binary requires alongside it).
    var binaryURL: URL { versionDirectory.appendingPathComponent("SwiftLM") }

    /// True when the binary is already on disk for the pinned version.
    var isInstalled: Bool {
        FileManager.default.isExecutableFile(atPath: binaryURL.path)
    }

    /// Idempotent: returns the binary URL immediately if present, otherwise
    /// downloads and extracts the tarball, then returns the URL.
    @MainActor
    func ensureInstalled() async throws -> URL {
        if isInstalled {
            state = .ready
            return binaryURL
        }
        try FileManager.default.createDirectory(at: versionDirectory, withIntermediateDirectories: true)

        let tarballURL = versionDirectory.appendingPathComponent(SwiftLMVersion.releaseAssetName)
        try await downloadTarball(to: tarballURL)
        try extract(tarballURL: tarballURL)
        try? FileManager.default.removeItem(at: tarballURL)

        // SwiftLM is ad-hoc signed upstream (not notarized). Programmatically
        // exec'ing a quarantined Mach-O binary can route through Gatekeeper
        // and surface a System Settings prompt the user has to clear. We
        // strip the attribute the same way `DebugBuildCreator` does for
        // patched Electron builds — fine for a non-sandboxed Hardened
        // Runtime app spawning a child process.
        stripQuarantine(at: versionDirectory)

        guard isInstalled else {
            state = .failed(InstallError.binaryMissing(binaryURL).localizedDescription)
            throw InstallError.binaryMissing(binaryURL)
        }
        state = .ready
        return binaryURL
    }

    @MainActor
    private func downloadTarball(to destination: URL) async throws {
        state = .downloading(0)
        let (tempURL, response) = try await URLSession.shared.download(
            from: SwiftLMVersion.releaseURL,
            delegate: ProgressTracker { [weak self] fraction in
                Task { @MainActor in
                    self?.state = .downloading(fraction)
                }
            }
        )

        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            try? FileManager.default.removeItem(at: tempURL)
            state = .failed("HTTP \(http.statusCode)")
            throw InstallError.downloadFailed(status: http.statusCode)
        }

        if FileManager.default.fileExists(atPath: destination.path) {
            try? FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.moveItem(at: tempURL, to: destination)
    }

    /// Best-effort `xattr -dr com.apple.quarantine` on the SwiftLM
    /// directory. Failure is logged but never thrown — if the attribute
    /// isn't present the command exits non-zero, and that's fine.
    private func stripQuarantine(at dir: URL) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
        proc.arguments = ["-dr", "com.apple.quarantine", dir.path]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
        } catch {
            log.error("xattr strip failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    @MainActor
    private func extract(tarballURL: URL) throws {
        state = .extracting
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        proc.arguments = ["-xzf", tarballURL.path, "-C", versionDirectory.path]
        let stderr = Pipe()
        proc.standardError = stderr
        proc.standardOutput = FileHandle.nullDevice
        try proc.run()
        proc.waitUntilExit()

        guard proc.terminationStatus == 0 else {
            let bytes = stderr.fileHandleForReading.readDataToEndOfFile()
            let message = String(data: bytes, encoding: .utf8) ?? ""
            state = .failed(message)
            throw InstallError.extractFailed(stderr: message)
        }
    }
}

/// `URLSessionDownloadDelegate` that forwards fractional progress to a
/// closure. Used by `SwiftLMInstaller` to drive the UI bar.
private final class ProgressTracker: NSObject, URLSessionDownloadDelegate {
    private let onProgress: @Sendable (Double) -> Void

    init(onProgress: @escaping @Sendable (Double) -> Void) {
        self.onProgress = onProgress
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64, totalBytesWritten written: Int64, totalBytesExpectedToWrite expected: Int64) {
        guard expected > 0 else { return }
        onProgress(Double(written) / Double(expected))
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // URLSession.download(from:delegate:) needs this method present, but
        // the async API surfaces the destination through its return value
        // so we don't move the file ourselves.
    }
}
