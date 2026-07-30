import Foundation
import Logging

private let defaultTabSnapshotIntervalNanoseconds: UInt64 = 5_000_000_000

private struct CDPVersionEntry: Decodable {
    let webSocketDebuggerUrl: String?
}

private struct CDPBrowserContextsResult: Decodable {
    let defaultBrowserContextId: String?
}

private struct CDPTargetInfo: Decodable {
    let type: String?
    let url: String?
    let browserContextId: String?
}

private struct CDPTargetsResult: Decodable {
    let targetInfos: [CDPTargetInfo]
}

/// Polls the launched browser's CDP target list and keeps a persisted
/// snapshot of the open tabs, so the next launch can reopen them.
///
/// Polling (rather than subscribing to `Target.targetInfoChanged`) keeps this
/// off the `/cdp` proxy socket the webapp owns: a browser-level read cannot
/// evict the leader's page CDP session. A failed poll is dropped rather than
/// persisted, so a browser that is quitting — or a momentarily unreachable CDP
/// endpoint — never erases the last good snapshot.
///
/// Targets are read over the browser endpoint rather than `/json/list`
/// because only `Target.getTargets` reports each target's
/// `browserContextId`, which is the only way to keep **Incognito** tabs out of
/// a file on disk: `/json/list` lists them with nothing to tell them apart
/// from normal tabs.
actor TabSessionRecorder {
    private let store: TabSessionStore
    private let cdpPort: Int
    private let hostedOrigins: [String]
    private let fetch: @Sendable (URL) async throws -> (Int, Data)
    private let openSession: @Sendable (URL) -> any CDPBrowserSession
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
        },
        openSession: @escaping @Sendable (URL) -> any CDPBrowserSession = { url in
            WebSocketCDPBrowserSession(url: url)
        }
    ) {
        self.store = store
        self.cdpPort = cdpPort
        self.hostedOrigins = hostedOrigins
        self.intervalNanoseconds = intervalNanoseconds
        self.logger = logger
        self.fetch = fetch
        self.openSession = openSession
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
        guard let urls = await restorableTabUrls() else { return }
        let sanitized = TabSessionStore.sanitize(rawUrls: urls, hostedOrigins: hostedOrigins)
        guard sanitized != lastPersisted else { return }
        store.save(urls: sanitized, hostedOrigins: hostedOrigins)
        lastPersisted = sanitized
        logger.debug("Persisted \(sanitized.count) tab(s) for restore")
    }

    /// The open page URLs that may be written to disk, or `nil` when this
    /// snapshot has to be skipped.
    private func restorableTabUrls() async -> [String]? {
        guard let browserURL = await browserDebuggerURL() else { return nil }
        let session = openSession(browserURL)
        let urls = await defaultContextPageUrls(in: session)
        await session.close()
        return urls
    }

    private func browserDebuggerURL() async -> URL? {
        guard let versionURL = URL(string: "http://127.0.0.1:\(cdpPort)/json/version") else { return nil }
        do {
            let (status, data) = try await fetch(versionURL)
            guard (200..<300).contains(status) else {
                logger.debug("Tab snapshot skipped: /json/version returned \(status)")
                return nil
            }
            guard let raw = try JSONDecoder().decode(CDPVersionEntry.self, from: data).webSocketDebuggerUrl,
                let url = URL(string: raw)
            else {
                logger.debug("Tab snapshot skipped: browser reported no debugger URL")
                return nil
            }
            return url
        } catch {
            logger.debug("Tab snapshot skipped: \(error.localizedDescription)")
            return nil
        }
    }

    private func defaultContextPageUrls(in session: any CDPBrowserSession) async -> [String]? {
        do {
            let contexts = try JSONDecoder().decode(
                CDPBrowserContextsResult.self,
                from: try await session.call(method: "Target.getBrowserContexts")
            )
            // Incognito tabs live in a non-default browser context and are
            // otherwise indistinguishable from normal ones. Without the
            // default context's id there is no way to exclude them, and
            // writing browsing the user made private into a file on disk is
            // worse than restoring nothing — so skip the snapshot entirely.
            guard let defaultContextId = contexts.defaultBrowserContextId else {
                logger.debug("Tab snapshot skipped: browser reported no default context id")
                return nil
            }
            let targets = try JSONDecoder().decode(
                CDPTargetsResult.self,
                from: try await session.call(method: "Target.getTargets")
            )
            return targets.targetInfos
                .filter { $0.type == "page" && $0.browserContextId == defaultContextId }
                .compactMap { $0.url }
        } catch {
            logger.debug("Tab snapshot skipped: \(error.localizedDescription)")
            return nil
        }
    }
}
