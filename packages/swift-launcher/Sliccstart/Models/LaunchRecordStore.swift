import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "LaunchRecordStore")

/// Persistable snapshot of one running SLICC runtime. Written to disk just
/// before Sliccstart quits for an update, then read on the next launch so
/// the new Sliccstart can reattach to the still-running browser/Electron
/// session via a fresh slicc-server in --serve-only mode.
struct PersistedLaunchRecord: Codable, Equatable {
    let targetId: String
    let targetName: String
    let targetType: AppTargetType
    /// For Electron records: the .app path of the running app (the
    /// debug-build copy when applicable). Empty for chromium browsers.
    let electronAppPath: String?
    /// HTTP serve port used by slicc-server (so we re-spawn on the same
    /// port the UI was bookmarked on).
    let servePort: UInt16
    /// CDP port the running browser is listening on; reattach is only
    /// attempted when this port still answers /json/version.
    let cdpPort: UInt16
    /// Optional UI overlay path (Phase C). When set, the relaunched
    /// slicc-server is spawned with --static-root pointing here.
    var staticRoot: String?
    /// Leader join URL captured at launch time for Electron followers.
    /// Nil for chromiumBrowser records. Persisted so reattach can re-thread
    /// `--join=<url>` to the new slicc-server and keep the follower
    /// auto-attached to the leader after a smooth update. Decoding uses
    /// the synthesized `decodeIfPresent` for Optional properties, so
    /// JSON written by older Sliccstart versions (which omit the key)
    /// still loads with `joinUrl == nil`.
    var joinUrl: String?
}

/// Disk-backed store for `PersistedLaunchRecord`s. JSON, single file under
/// ~/Library/Application Support/Sliccstart/launch-records.json so it
/// survives an .app replacement by AppUpdater.
struct LaunchRecordStore {
    let storeURL: URL

    init(storeURL: URL = LaunchRecordStore.defaultStoreURL) {
        self.storeURL = storeURL
    }

    static var defaultStoreURL: URL {
        let support = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first
            ?? URL(fileURLWithPath: NSHomeDirectory() + "/Library/Application Support")
        return support
            .appendingPathComponent("Sliccstart", isDirectory: true)
            .appendingPathComponent("launch-records.json", isDirectory: false)
    }

    func save(_ records: [PersistedLaunchRecord]) throws {
        let fm = FileManager.default
        let dir = storeURL.deletingLastPathComponent()
        if !fm.fileExists(atPath: dir.path) {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(records)
        try data.write(to: storeURL, options: .atomic)
        log.info("save: wrote \(records.count) records to \(self.storeURL.path, privacy: .public)")
    }

    func load() -> [PersistedLaunchRecord] {
        guard FileManager.default.fileExists(atPath: storeURL.path) else { return [] }
        do {
            let data = try Data(contentsOf: storeURL)
            return try JSONDecoder().decode([PersistedLaunchRecord].self, from: data)
        } catch {
            log.error("load: failed to decode \(self.storeURL.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    /// Remove the on-disk file. Called after reattach so a normal next
    /// launch doesn't try to resurrect stale records.
    func clear() {
        try? FileManager.default.removeItem(at: storeURL)
    }
}

/// Probe a CDP endpoint to decide whether the original browser/Electron
/// process from a `PersistedLaunchRecord` is still alive. Lifted into its
/// own type so the unit tests can swap the URLSession implementation.
struct CDPLiveProbe {
    let fetch: (URL) async throws -> Int

    static let `default` = CDPLiveProbe(fetch: { url in
        var request = URLRequest(url: url)
        request.timeoutInterval = 0.75
        let (_, response) = try await URLSession.shared.data(for: request)
        return (response as? HTTPURLResponse)?.statusCode ?? 0
    })

    func isAlive(cdpPort: UInt16) async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(cdpPort)/json/version") else { return false }
        do {
            let status = try await fetch(url)
            return (200..<300).contains(status)
        } catch {
            return false
        }
    }
}
