import AppKit
import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "IncomingURL")




protocol LeaderBrowserLaunching: AnyObject {
    
    var leaderBrowserEndpoint: LeaderBrowserEndpoint? { get }
    
    
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












@MainActor
final class IncomingURLRouter {
    
    
    
    
    static let openableSchemes: Set<String> = ["http", "https", "file"]

    static let leaderWaitPollInterval: TimeInterval = 0.5
    
    
    static let maxLeaderWaitPolls = 90
    
    
    
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

    
    
    nonisolated static func defaultOrderedBrowsers() -> [AppTarget] {
        AppOrdering.orderedBrowsers(
            in: AppScanner.scan(hasAppManagementPermission: false),
            savedOrder: AppOrderStore().load(AppOrderStore.browserKey)
        )
    }

    
    
    
    
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
        
        
        
        activateBrowser(leader.appPath)
    }

    static func openableURLs(from urls: [URL]) -> [URL] {
        urls.filter { openableSchemes.contains($0.scheme?.lowercased() ?? "") }
    }

    
    
    
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
        
        
        
        
        
        guard let target = browsers.first(where: { !process.isRunningAsFollower($0) }) else {
            log.error("launchLeader: no browser available to become the leader")
            return
        }
        do {
            log.info("launchLeader: starting \(target.name, privacy: .public) for an incoming link")
            try process.launchStandalone(target)
        } catch {
            
            
            
            log.info("launchLeader: launch attempt failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
