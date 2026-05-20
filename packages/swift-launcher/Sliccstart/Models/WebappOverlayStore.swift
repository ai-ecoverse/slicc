import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "WebappOverlay")

/// On-disk store of unpacked `dist/ui` directories that override the one
/// shipped inside Sliccstart.app. Keyed by version so we can hot-swap
/// between releases without redownloading and prune older versions later.
///
/// Layout:
///   ~/Library/Application Support/Sliccstart/ui-overlays/
///     active.json              ← { "version": "2.55.0" }
///     2.55.0/                  ← contents of dist/ui
///     2.55.0.zip               ← original asset (kept for re-extraction)
struct WebappOverlayStore {
    let rootDirectory: URL

    init(rootDirectory: URL = WebappOverlayStore.defaultRootDirectory) {
        self.rootDirectory = rootDirectory
    }

    static var defaultRootDirectory: URL {
        let support = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first
            ?? URL(fileURLWithPath: NSHomeDirectory() + "/Library/Application Support")
        return support
            .appendingPathComponent("Sliccstart", isDirectory: true)
            .appendingPathComponent("ui-overlays", isDirectory: true)
    }

    private var activePointerURL: URL {
        rootDirectory.appendingPathComponent("active.json")
    }

    /// Path to the active overlay's `dist/ui`-equivalent directory, or
    /// nil when no overlay is set or the pointed-at directory is missing.
    func activeOverlayPath() -> String? {
        let fm = FileManager.default
        guard fm.fileExists(atPath: activePointerURL.path) else { return nil }
        do {
            let data = try Data(contentsOf: activePointerURL)
            let pointer = try JSONDecoder().decode(OverlayPointer.self, from: data)
            let dir = rootDirectory.appendingPathComponent(pointer.version, isDirectory: true)
            return fm.fileExists(atPath: dir.path) ? dir.path : nil
        } catch {
            log.error("activeOverlayPath: failed to read pointer: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    func activeVersion() -> String? {
        let fm = FileManager.default
        guard fm.fileExists(atPath: activePointerURL.path) else { return nil }
        guard let data = try? Data(contentsOf: activePointerURL),
              let pointer = try? JSONDecoder().decode(OverlayPointer.self, from: data) else {
            return nil
        }
        return pointer.version
    }

    func setActive(version: String) throws {
        let fm = FileManager.default
        if !fm.fileExists(atPath: rootDirectory.path) {
            try fm.createDirectory(at: rootDirectory, withIntermediateDirectories: true)
        }
        let data = try JSONEncoder().encode(OverlayPointer(version: version))
        try data.write(to: activePointerURL, options: .atomic)
        log.info("setActive: version=\(version, privacy: .public)")
    }

    /// Returns the directory where an overlay for `version` is/will be
    /// installed. Creates the parent directory but not the overlay dir
    /// itself (that's left to the unzip step).
    func overlayDirectory(for version: String) throws -> URL {
        let fm = FileManager.default
        if !fm.fileExists(atPath: rootDirectory.path) {
            try fm.createDirectory(at: rootDirectory, withIntermediateDirectories: true)
        }
        return rootDirectory.appendingPathComponent(version, isDirectory: true)
    }

    /// Cached download path for the webapp zip.
    func zipPath(for version: String) throws -> URL {
        let fm = FileManager.default
        if !fm.fileExists(atPath: rootDirectory.path) {
            try fm.createDirectory(at: rootDirectory, withIntermediateDirectories: true)
        }
        return rootDirectory.appendingPathComponent("\(version).zip")
    }

    /// Install an already-downloaded zip as the overlay for `version`.
    /// Idempotent — if the overlay directory exists, it's removed first.
    ///
    /// Zip entries are validated before extraction to defend against
    /// zip-slip path traversal (`../`, absolute paths) and symlink
    /// tricks that point outside `overlayDir`. The asset comes from the
    /// network, so we don't trust it even though `SmoothUpdateCoordinator`
    /// re-checks the sha256 afterwards: a content-hash check would still
    /// happen *after* files had already been written to disk.
    func install(zipURL: URL, version: String) throws -> URL {
        let fm = FileManager.default
        let overlayDir = try overlayDirectory(for: version)
        if fm.fileExists(atPath: overlayDir.path) {
            try fm.removeItem(at: overlayDir)
        }
        try fm.createDirectory(at: overlayDir, withIntermediateDirectories: true)

        try validateArchiveEntries(zipURL: zipURL)

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        // `-X` strips owner/permission metadata, but more importantly we
        // already vetted the entry list above so unzip can't be coerced
        // into writing outside `overlayDir`.
        task.arguments = ["-o", "-q", zipURL.path, "-d", overlayDir.path]
        let stderr = Pipe()
        task.standardError = stderr
        task.standardOutput = FileHandle.nullDevice
        try task.run()
        task.waitUntilExit()
        guard task.terminationStatus == 0 else {
            let detail = String(
                data: stderr.fileHandleForReading.readDataToEndOfFile(),
                encoding: .utf8
            ) ?? ""
            throw OverlayError.unzipFailed(detail.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return overlayDir
    }

    /// Inspect zip entries with `zipinfo` and reject anything that would
    /// escape the destination directory: absolute paths, `..` segments,
    /// backslash separators, NUL bytes, and symlinks. Refusing the whole
    /// archive on the first bad entry is safer than relying on `unzip`'s
    /// own checks, which historically have had bypasses.
    func validateArchiveEntries(zipURL: URL) throws {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/zipinfo")
        // `-1` lists one file per line (just the path).
        // `-h` would add a header — omit so output is purely entries.
        task.arguments = ["-1", zipURL.path]
        let stdout = Pipe()
        let stderr = Pipe()
        task.standardOutput = stdout
        task.standardError = stderr
        try task.run()
        task.waitUntilExit()
        guard task.terminationStatus == 0 else {
            let detail = String(
                data: stderr.fileHandleForReading.readDataToEndOfFile(),
                encoding: .utf8
            ) ?? ""
            throw OverlayError.unzipFailed("zipinfo failed: \(detail)")
        }
        let listing = String(
            data: stdout.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        ) ?? ""

        for raw in listing.split(separator: "\n") {
            let entry = String(raw)
            if entry.isEmpty { continue }
            if entry.hasPrefix("/") {
                throw OverlayError.unsafeEntry(entry: entry, reason: "absolute path")
            }
            if entry.contains("..") {
                // Catch both `../foo` and `foo/../bar` — `unzip` would
                // happily resolve the latter outside `overlayDir`.
                let components = entry.split(separator: "/", omittingEmptySubsequences: false)
                if components.contains(where: { $0 == ".." }) {
                    throw OverlayError.unsafeEntry(entry: entry, reason: "parent traversal")
                }
            }
            if entry.contains("\\") {
                throw OverlayError.unsafeEntry(entry: entry, reason: "backslash separator")
            }
            if entry.contains("\0") {
                throw OverlayError.unsafeEntry(entry: entry, reason: "embedded NUL")
            }
        }

        // Use `unzip -Z1l` to surface entries with non-regular file types
        // (symlinks have a leading `l` in the long listing). We don't want
        // a malicious symlink → unzip would happily write through it.
        let longList = Process()
        longList.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        longList.arguments = ["-Z", "-l", zipURL.path]
        let longPipe = Pipe()
        longList.standardOutput = longPipe
        longList.standardError = FileHandle.nullDevice
        try longList.run()
        longList.waitUntilExit()
        let longOutput = String(
            data: longPipe.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        ) ?? ""
        for line in longOutput.split(separator: "\n") {
            // `unzip -Z -l` lines start with the file-mode flags. A leading
            // `l` (lowercase L) marks a symlink entry.
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("l") {
                throw OverlayError.unsafeEntry(entry: trimmed, reason: "symlink not permitted")
            }
        }
    }

    /// Delete every overlay other than `version`. Called after a
    /// successful activation to keep disk footprint bounded.
    func pruneOthers(keep version: String) {
        let fm = FileManager.default
        guard let contents = try? fm.contentsOfDirectory(atPath: rootDirectory.path) else { return }
        for entry in contents {
            if entry == "active.json" { continue }
            if entry == version || entry == "\(version).zip" { continue }
            try? fm.removeItem(at: rootDirectory.appendingPathComponent(entry))
        }
    }

    private struct OverlayPointer: Codable {
        let version: String
    }

    enum OverlayError: LocalizedError, Equatable {
        case unzipFailed(String)
        case unsafeEntry(entry: String, reason: String)

        var errorDescription: String? {
            switch self {
            case .unzipFailed(let detail):
                return "Failed to unzip webapp overlay: \(detail)"
            case .unsafeEntry(let entry, let reason):
                return "Refusing to extract \(entry): \(reason)"
            }
        }
    }
}
