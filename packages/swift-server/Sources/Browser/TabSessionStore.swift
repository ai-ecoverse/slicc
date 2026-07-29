import Foundation
import Logging

/// One persisted tab snapshot for a Chrome profile.
struct PersistedTabSession: Codable, Equatable {
    var updatedAt: Date
    var urls: [String]
}

/// Persists the URLs a launched Chrome had open so the next launch can
/// reopen them.
///
/// Chrome's own session restore stays disabled — `clearChromeSessionRestore`
/// wipes `Default/Sessions` on every launch because a restored SLICC tab
/// carries the previous run's bridge token and fights the fresh tab over
/// `/cdp`. Keeping our own URL-only snapshot lets us reopen everything
/// *except* that tab, which `resolveBrowserLaunchURL` re-mints with the
/// current token instead.
///
/// URLs are re-validated on both save and load: the file lives in the user's
/// Application Support directory, and every entry is handed straight to
/// Chrome's argument vector, so an entry like `--headless` or `file:///…`
/// must never survive `sanitize`.
struct TabSessionStore: Sendable {
    static let maxRestoredTabs = 50

    let fileURL: URL
    private let logger: Logger

    init(fileURL: URL, logger: Logger = Logger(label: "slicc.browser.tab-session")) {
        self.fileURL = fileURL
        self.logger = logger
    }

    /// `~/Library/Application Support/Slicc/sessions/<profile-dir>-tabs.json`.
    /// Keyed off the user-data-dir's last path component so each profile
    /// (`resolveUserDataDir` appends the serve port for non-default ports)
    /// keeps its own tab set.
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

    /// Keep only real web pages the next launch can safely reopen: absolute
    /// `http(s)` URLs with a host, minus the SLICC leader page, deduplicated
    /// in first-seen order and capped at `limit`.
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

    /// A SLICC page is either served from an origin we launch the leader
    /// from, or carries the bridge query parameters that only a SLICC
    /// launch URL has. Both halves matter: the hosted origin also serves
    /// the marketing site (reopening it as a second leader would restart
    /// the `/cdp` eviction war), and a locally hosted UI origin can differ
    /// between runs while the bridge parameters stay recognizable.
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

    /// `scheme://host[:port]`, lowercased, or `nil` for anything that is not
    /// an absolute http(s) URL.
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
