import Foundation
import Logging

private let defaultTabSnapshotIntervalNanoseconds: UInt64 = 5_000_000_000

private struct CDPTargetEntry: Decodable {
    let type: String?
    let url: String?
}

/// Polls the launched browser's CDP target list and keeps a persisted
/// snapshot of the open tabs, so the next launch can reopen them.
///
/// Polling (rather than subscribing to `Target.targetInfoChanged`) keeps this
/// off the `/cdp` proxy socket the webapp owns: a plain `/json/list` read
/// cannot evict the leader's CDP session. A failed poll is dropped rather
/// than persisted, so a browser that is quitting — or a momentarily
/// unreachable CDP endpoint — never erases the last good snapshot.
actor TabSessionRecorder {
    private let store: TabSessionStore
    private let cdpPort: Int
    private let hostedOrigins: [String]
    private let fetch: @Sendable (URL) async throws -> (Int, Data)
    private let intervalNanoseconds: UInt64
    private let logger: Logger

    private var pollTask: Task<Void, Never>?
    private var lastPersisted: [String]?

    init(
        store: TabSessionStore,
        cdpPort: Int,
        hostedOrigins: [String],
        intervalNanoseconds: UInt64 = defaultTabSnapshotIntervalNanoseconds,
        logger: Logger = Logger(label: "slicc.browser.tab-session"),
        fetch: @escaping @Sendable (URL) async throws -> (Int, Data) = { url in
            var request = URLRequest(url: url)
            request.timeoutInterval = 2
            request.cachePolicy = .reloadIgnoringLocalCacheData
            let (data, response) = try await URLSession.shared.data(for: request)
            return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
        }
    ) {
        self.store = store
        self.cdpPort = cdpPort
        self.hostedOrigins = hostedOrigins
        self.intervalNanoseconds = intervalNanoseconds
        self.logger = logger
        self.fetch = fetch
    }

    func start() {
        stop()
        let interval = intervalNanoseconds
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.snapshotNow()
                do {
                    try await Task.sleep(nanoseconds: interval)
                } catch {
                    break
                }
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// Read the target list once and persist it when it differs from the last
    /// snapshot this recorder wrote. Never throws: a snapshot is a
    /// best-effort convenience, and it runs on the shutdown path where a
    /// thrown error would abort the rest of the sequence.
    func snapshotNow() async {
        guard let listURL = URL(string: "http://127.0.0.1:\(cdpPort)/json/list") else { return }
        let urls: [String]
        do {
            let (status, data) = try await fetch(listURL)
            guard (200..<300).contains(status) else {
                logger.debug("Tab snapshot skipped: /json/list returned \(status)")
                return
            }
            let entries = try JSONDecoder().decode([CDPTargetEntry].self, from: data)
            urls = entries.filter { $0.type == "page" }.compactMap { $0.url }
        } catch {
            logger.debug("Tab snapshot skipped: \(error.localizedDescription)")
            return
        }
        let sanitized = TabSessionStore.sanitize(rawUrls: urls, hostedOrigins: hostedOrigins)
        guard sanitized != lastPersisted else { return }
        store.save(urls: sanitized, hostedOrigins: hostedOrigins)
        lastPersisted = sanitized
        logger.debug("Persisted \(sanitized.count) tab(s) for restore")
    }
}
