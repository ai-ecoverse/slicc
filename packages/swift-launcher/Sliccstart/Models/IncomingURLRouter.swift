import AppKit
import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "IncomingURL")

/// A SLICC leader browser that links can be handed to. `SliccProcess` is the
/// production implementation; the protocol keeps the routing logic testable
/// without spawning a browser.
protocol LeaderBrowserLaunching: AnyObject {
    /// CDP endpoint of the running local leader, or `nil` when none is up.
    var leaderBrowserEndpoint: LeaderBrowserEndpoint? { get }
    /// True when this browser is already attached to a remote tray as a
    /// follower, so it can never become the local leader.
    func isRunningAsFollower(_ target: AppTarget) -> Bool
    func launchStandalone(_ target: AppTarget) throws
}

extension SliccProcess: LeaderBrowserLaunching {}

enum IncomingURLRouterError: LocalizedError, Equatable {
    case leaderUnavailable
    case newTabRejected(status: Int)
    case newTabResponseUnreadable
    case activateRejected(status: Int)

    var errorDescription: String? {
        switch self {
        case .leaderUnavailable:
            return "No SLICC leader browser became available to open the link in."
        case .newTabRejected(let status):
            return "The browser rejected the new-tab request (HTTP \(status))."
        case .newTabResponseUnreadable:
            return "The browser did not report a target id for the new tab, so it stayed in the background."
        case .activateRejected(let status):
            return "The browser rejected the tab-activation request (HTTP \(status)), so the link stayed in the background."
        }
    }
}

/// Opens the links macOS hands to Sliccstart while it is the default web
/// browser. Sliccstart draws no web content of its own, so every link becomes
/// a tab in the SLICC leader browser — starting that browser first when it is
/// not running yet, which is what makes a cold "click a link with Sliccstart
/// as default browser" launch work.
///
/// Tabs are created over the browser's CDP HTTP endpoint rather than
/// `NSWorkspace.open(_:withApplicationAt:)`: the SLICC browser runs on its own
/// user-data-dir, so when the user also has the same browser open on their
/// normal profile, LaunchServices would pick between the two instances
/// non-deterministically. The CDP port only ever answers for the leader.
@MainActor
final class IncomingURLRouter {
    /// Schemes we accept. `http`/`https` are the default-browser role;
    /// `file` covers the HTML documents `CFBundleDocumentTypes` claims.
    /// Everything else (`javascript:`, `data:`, custom app schemes) is
    /// dropped rather than forwarded into the leader.
    static let openableSchemes: Set<String> = ["http", "https", "file"]

    static let leaderWaitPollInterval: TimeInterval = 0.5
    /// ~45s of waiting: enough for a cold start that has to bootstrap and
    /// boot Chrome before the CDP port answers.
    static let maxLeaderWaitPolls = 90
    /// Re-attempt the launch every ~10s while waiting. A launch can lose the
    /// race against startup's own auto-launch (or against a still-bootstrapping
    /// app), and a single attempt would then wait out the whole budget.
    static let launchRetryEveryPolls = 20

    private let process: any LeaderBrowserLaunching
    private let orderedBrowsers: () -> [AppTarget]
    private let send: (URLRequest) async throws -> (Int, Data)
    private let sleep: (TimeInterval) async -> Void
    private let activateBrowser: (String) -> Void
    private let report: (Error) -> Void

    private var pending: [URL] = []
    private var isDraining = false

    init(
        process: any LeaderBrowserLaunching,
        orderedBrowsers: @escaping () -> [AppTarget] = { IncomingURLRouter.defaultOrderedBrowsers() },
        send: @escaping (URLRequest) async throws -> (Int, Data) = { request in
            let (data, response) = try await URLSession.shared.data(for: request)
            return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
        },
        sleep: @escaping (TimeInterval) async -> Void = { seconds in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        },
        activateBrowser: @escaping (String) -> Void = { appPath in
            let bundleURL = URL(fileURLWithPath: appPath).standardizedFileURL
            NSWorkspace.shared.runningApplications
                .first { $0.bundleURL?.standardizedFileURL == bundleURL }?
                .activate()
        },
        report: @escaping (Error) -> Void = { LauncherErrorReport.report(.openIncomingUrl, $0) }
    ) {
        self.process = process
        self.orderedBrowsers = orderedBrowsers
        self.send = send
        self.sleep = sleep
        self.activateBrowser = activateBrowser
        self.report = report
    }

    /// The (reorderable) Browsers list in display order; its head is the same
    /// pick startup auto-launch makes.
    nonisolated static func defaultOrderedBrowsers() -> [AppTarget] {
        AppOrdering.orderedBrowsers(
            in: AppScanner.scan(hasAppManagementPermission: false),
            savedOrder: AppOrderStore().load(AppOrderStore.browserKey)
        )
    }

    /// Queue `urls` and drain them into the leader. Re-entrant calls (macOS
    /// delivers one `application(_:open:)` per user click) append to the queue
    /// the in-flight drain is already working through, so a second click while
    /// the browser is still booting is not lost.
    func handle(_ urls: [URL]) async {
        let openable = Self.openableURLs(from: urls)
        guard !openable.isEmpty else { return }
        pending.append(contentsOf: openable)
        guard !isDraining else { return }
        isDraining = true
        defer { isDraining = false }

        guard let leader = await resolveLeader() else {
            log.error("handle: no leader browser available; dropping \(self.pending.count, privacy: .public) link(s)")
            report(IncomingURLRouterError.leaderUnavailable)
            pending.removeAll()
            return
        }

        while !pending.isEmpty {
            await open(pending.removeFirst(), cdpPort: leader.cdpPort)
        }
        // Bring forward the browser that actually owns the CDP port we just
        // wrote to — which is not necessarily `topBrowser()`, since the user
        // may have started a different browser by hand.
        activateBrowser(leader.appPath)
    }

    static func openableURLs(from urls: [URL]) -> [URL] {
        urls.filter { openableSchemes.contains($0.scheme?.lowercased() ?? "") }
    }

    /// Chrome's DevTools endpoint takes the **whole query string** as the
    /// target URL (`PUT /json/new?<url>`) — a `?url=<url>` spelling opens
    /// `about:blank` instead — and rejects GET since Chrome 111.
    static func newTabRequest(cdpPort: UInt16, target: URL) -> URLRequest? {
        guard
            let encoded = target.absoluteString.addingPercentEncoding(
                withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))
            ),
            let url = URL(string: "http://127.0.0.1:\(cdpPort)/json/new?\(encoded)")
        else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.timeoutInterval = 5
        return request
    }

    /// `/json/new` creates the tab in the background, so the link the user
    /// just clicked would stay hidden without this follow-up.
    static func activateRequest(cdpPort: UInt16, targetId: String) -> URLRequest? {
        guard
            let encodedId = targetId.addingPercentEncoding(
                withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))
            ),
            !encodedId.isEmpty,
            let url = URL(string: "http://127.0.0.1:\(cdpPort)/json/activate/\(encodedId)")
        else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 5
        return request
    }

    /// Target id from a `/json/new` response body.
    static func createdTargetId(from body: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let id = json["id"] as? String,
            !id.isEmpty
        else { return nil }
        return id
    }

    private func open(_ url: URL, cdpPort: UInt16) async {
        guard let request = Self.newTabRequest(cdpPort: cdpPort, target: url) else { return }
        do {
            let (status, body) = try await send(request)
            guard (200..<300).contains(status) else {
                throw IncomingURLRouterError.newTabRejected(status: status)
            }
            log.info("open: opened link in leader on cdp \(cdpPort, privacy: .public)")
            // The tab exists but is in the background, so a failure here is a
            // user-visible failure — the browser comes forward showing the
            // tab the user was already on and the clicked link looks lost.
            guard let targetId = Self.createdTargetId(from: body),
                let activate = Self.activateRequest(cdpPort: cdpPort, targetId: targetId)
            else {
                throw IncomingURLRouterError.newTabResponseUnreadable
            }
            let (activateStatus, _) = try await send(activate)
            guard (200..<300).contains(activateStatus) else {
                throw IncomingURLRouterError.activateRejected(status: activateStatus)
            }
        } catch {
            log.error("open: failed: \(error.localizedDescription, privacy: .public)")
            report(error)
        }
    }

    private func resolveLeader() async -> LeaderBrowserEndpoint? {
        for attempt in 0..<Self.maxLeaderWaitPolls {
            if let leader = process.leaderBrowserEndpoint { return leader }
            if attempt % Self.launchRetryEveryPolls == 0 {
                launchLeader()
            }
            await sleep(Self.leaderWaitPollInterval)
        }
        return process.leaderBrowserEndpoint
    }

    private func launchLeader() {
        let browsers = orderedBrowsers()
        // Skip a browser already attached to a remote tray as a follower:
        // `launchStandalone` would no-op on it ("already running") while the
        // wait loop keeps ignoring follower records, so retrying it would burn
        // the whole budget and drop the link. A browser that is merely still
        // booting is *not* skipped — it is the leader-to-be.
        guard let target = browsers.first(where: { !process.isRunningAsFollower($0) }) else {
            log.error("launchLeader: no browser available to become the leader")
            return
        }
        do {
            log.info("launchLeader: starting \(target.name, privacy: .public) for an incoming link")
            try process.launchStandalone(target)
        } catch {
            // A losing race against startup's own auto-launch surfaces as
            // "port in use"; the wait loop below picks the leader up either
            // way, so this is logged rather than reported.
            log.info("launchLeader: launch attempt failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
