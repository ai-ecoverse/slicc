import Foundation
import Logging


struct PersistedTabSession: Codable, Equatable {
    var updatedAt: Date
    var urls: [String]
}















struct TabSessionStore: Sendable {
    static let maxRestoredTabs = 50

    let fileURL: URL
    private let logger: Logger

    init(fileURL: URL, logger: Logger = Logger(label: "slicc.browser.tab-session")) {
        self.fileURL = fileURL
        self.logger = logger
    }

    
    
    
    
    static func defaultFileURL(userDataDir: String, homeDirectory: String = NSHomeDirectory()) -> URL {
        let profileDirName = URL(fileURLWithPath: userDataDir).lastPathComponent
        return URL(fileURLWithPath: homeDirectory, isDirectory: true)
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Application Support", isDirectory: true)
            .appendingPathComponent("Slicc", isDirectory: true)
            .appendingPathComponent("sessions", isDirectory: true)
            .appendingPathComponent("\(profileDirName)-tabs.json")
    }

    func load(hostedOrigins: [String]) -> [String] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        guard let session = try? JSONDecoder().decode(PersistedTabSession.self, from: data) else {
            logger.warning("Ignoring unreadable tab snapshot at \(fileURL.path)")
            return []
        }
        return Self.sanitize(rawUrls: session.urls, hostedOrigins: hostedOrigins)
    }

    func save(urls: [String], hostedOrigins: [String], now: Date = Date()) {
        let sanitized = Self.sanitize(rawUrls: urls, hostedOrigins: hostedOrigins)
        let session = PersistedTabSession(updatedAt: now, urls: sanitized)
        let encoder = JSONEncoder()
        encoder.outputFormatting = .prettyPrinted
        guard let data = try? encoder.encode(session) else { return }
        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(to: fileURL, options: .atomic)
        } catch {
            logger.warning("Could not persist tab snapshot: \(error.localizedDescription)")
        }
    }

    
    
    
    static func sanitize(
        rawUrls: [String],
        hostedOrigins: [String],
        limit: Int = maxRestoredTabs
    ) -> [String] {
        let origins = Set(hostedOrigins.compactMap { normalizedOrigin(of: $0) })
        var seen = Set<String>()
        var kept: [String] = []
        for raw in rawUrls {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let url = URL(string: trimmed),
                let scheme = url.scheme?.lowercased(),
                scheme == "http" || scheme == "https",
                let host = url.host,
                !host.isEmpty,
                !isSliccPage(url, origins: origins),
                !seen.contains(trimmed)
            else { continue }
            seen.insert(trimmed)
            kept.append(trimmed)
            if kept.count >= max(limit, 0) { break }
        }
        return kept
    }

    
    
    
    
    
    
    private static func isSliccPage(_ url: URL, origins: Set<String>) -> Bool {
        if let origin = normalizedOrigin(of: url.absoluteString), origins.contains(origin) {
            return true
        }
        let queryNames =
            URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?
            .map { $0.name.lowercased() } ?? []
        return queryNames.contains("bridge") || queryNames.contains("bridgetoken")
    }

    
    
    static func normalizedOrigin(of value: String) -> String? {
        guard let components = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
            let scheme = components.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            let host = components.host?.lowercased(),
            !host.isEmpty
        else { return nil }
        if let port = components.port {
            return "\(scheme)://\(host):\(port)"
        }
        return "\(scheme)://\(host)"
    }
}
