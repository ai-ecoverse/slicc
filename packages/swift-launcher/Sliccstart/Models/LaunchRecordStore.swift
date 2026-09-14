import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "LaunchRecordStore")





struct PersistedLaunchRecord: Codable, Equatable {
    let targetId: String
    let targetName: String
    let targetType: AppTargetType
    
    
    let electronAppPath: String?
    
    
    let servePort: UInt16
    
    
    let cdpPort: UInt16
    
    
    
    
    
    
    
    var joinUrl: String?
    
    
    
    
    
    
    
    
    
    var bridgeToken: String?
}




struct LaunchRecordStore {
    let storeURL: URL

    init(storeURL: URL = LaunchRecordStore.defaultStoreURL) {
        self.storeURL = storeURL
    }

    static var defaultStoreURL: URL {
        let support =
            FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first
            ?? URL(fileURLWithPath: NSHomeDirectory() + "/Library/Application Support")
        return
            support
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

    
    
    func clear() {
        try? FileManager.default.removeItem(at: storeURL)
    }
}




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
