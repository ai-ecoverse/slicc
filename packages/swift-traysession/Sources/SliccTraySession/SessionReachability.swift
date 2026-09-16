import Foundation
import Observation

@MainActor
@Observable
public final class SessionReachability {
    public enum Verdict: Equatable {
        case reachable
        case unreachable
    }

    public typealias Transport = (URLRequest) async throws -> (Data, URLResponse)

    public private(set) var verdicts: [String: Verdict] = [:]

    @ObservationIgnored private var inFlight: Set<String> = []
    @ObservationIgnored private let maxSupersedeRedirects: Int
    @ObservationIgnored private let transport: Transport

    public convenience init() {
        let config = URLSessionConfiguration.ephemeral

        config.timeoutIntervalForRequest = 4
        config.timeoutIntervalForResource = 4

        let session = URLSession(
            configuration: config, delegate: NoRedirectDelegate(), delegateQueue: nil)
        self.init(maxSupersedeRedirects: 5) { request in
            try await session.data(for: request)
        }
    }

    public init(maxSupersedeRedirects: Int, transport: @escaping Transport) {
        self.maxSupersedeRedirects = max(0, maxSupersedeRedirects)
        self.transport = transport
    }

    public func presumedReachable(_ id: String) -> Bool {
        verdicts[id] != .unreachable
    }

    public func probe(_ sessions: [some ProbableSession]) {
        for tray in sessions {
            guard !inFlight.contains(tray.id), let url = URL(string: tray.joinUrl) else { continue }
            inFlight.insert(tray.id)
            Task { [weak self] in
                guard let self else { return }
                let verdict = await probeVerdict(url: url)
                inFlight.remove(tray.id)
                verdicts[tray.id] = verdict
            }
        }
    }

    private func probeVerdict(url: URL) async -> Verdict {
        var currentURL = url
        var redirectsFollowed = 0

        while true {
            guard let request = Self.request(for: currentURL) else { return .unreachable }
            guard
                let (data, response) = try? await transport(request),
                let http = response as? HTTPURLResponse
            else { return .unreachable }
            let payload = try? JSONDecoder().decode(ProbePayload.self, from: data)

            let linkSuccessor =
                SupersedeLink.successor(in: http) ?? SupersedeLink.redirectTarget(in: http)

            if http.statusCode == 200, let payload, linkSuccessor == nil {
                return payload.leader?.connected == true ? .reachable : .unreachable
            }

            let next =
                linkSuccessor ?? Self.supersededURL(from: payload, statusCode: http.statusCode)
            guard let next, redirectsFollowed < maxSupersedeRedirects else { return .unreachable }

            redirectsFollowed += 1
            currentURL = next
        }
    }

    private static func supersededURL(from payload: ProbePayload?, statusCode: Int) -> URL? {
        guard statusCode == 409, payload?.code == "TRAY_SUPERSEDED",
            let next = payload?.joinUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
            !next.isEmpty, let url = URL(string: next), url.scheme != nil, url.host != nil
        else { return nil }
        return url
    }

    private static func request(for url: URL) -> URLRequest? {

        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        var query = components.queryItems ?? []
        query.append(URLQueryItem(name: "json", value: "true"))
        components.queryItems = query
        guard let probeURL = components.url else { return nil }
        var request = URLRequest(url: probeURL)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return request
    }
}

public protocol ProbableSession {

    var id: String { get }

    var joinUrl: String { get }
}

extension SyncedTraySession: ProbableSession {}
extension RecentJoin: ProbableSession {}

private struct ProbePayload: Decodable {
    struct Leader: Decodable {
        let connected: Bool?
    }

    let code: String?
    let joinUrl: String?
    let leader: Leader?
}
