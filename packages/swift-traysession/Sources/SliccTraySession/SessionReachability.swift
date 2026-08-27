import Foundation
import Observation

/// Quick liveness probe for iCloud-discovered sessions. iCloud KVS keeps
/// advertising a session for a while after its leader is gone, so consumers
/// probe each join URL and can de-emphasise sessions that no longer answer.
///
/// A GET does not attach a participant (joining is the POST flow), so the
/// probe is invisible to the leader. The join URL carries the session
/// secret: it is never logged and the verdict map is keyed by the one-way
/// session id.
///
/// A session is reachable only when the tray handler returns HTTP 200 with
/// `leader.connected == true`. HTTP 409 `TRAY_SUPERSEDED` responses are
/// followed through their replacement join URLs, up to the configured limit.
/// Every other response, invalid body, transport failure, or exhausted chain
/// is unreachable.
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
        // Fast verdicts beat certain ones here: a hub that cannot answer in
        // four seconds is not a session worth sorting to the top. The timeout
        // applies independently to every supersede-chain hop.
        config.timeoutIntervalForRequest = 4
        config.timeoutIntervalForResource = 4
        let session = URLSession(configuration: config)
        self.init(maxSupersedeRedirects: 5) { request in
            try await session.data(for: request)
        }
    }

    public init(maxSupersedeRedirects: Int, transport: @escaping Transport) {
        self.maxSupersedeRedirects = max(0, maxSupersedeRedirects)
        self.transport = transport
    }

    /// True while no probe has finished for this id — treated as reachable
    /// for sorting so rows do not jump while verdicts trickle in.
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

            if http.statusCode == 200, let payload {
                return payload.leader?.connected == true ? .reachable : .unreachable
            }

            // #1957: the hub names the replacement twice — as an RFC 5829
            // `successor-version` link, and in the body it has always used. The
            // link wins and stands alone, so a body this build cannot decode
            // (or a status other than 409) is not a dead end.
            let next =
                SupersedeLink.successor(in: http)
                ?? Self.supersededURL(from: payload, statusCode: http.statusCode)
            guard let next, redirectsFollowed < maxSupersedeRedirects else { return .unreachable }

            redirectsFollowed += 1
            currentURL = next
        }
    }

    /// The pre-#1957 reading: a 409 whose body says `TRAY_SUPERSEDED` and
    /// carries the replacement. Kept for hubs that predate the link header.
    private static func supersededURL(from payload: ProbePayload?, statusCode: Int) -> URL? {
        guard statusCode == 409, payload?.code == "TRAY_SUPERSEDED",
            let next = payload?.joinUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
            !next.isEmpty, let url = URL(string: next), url.scheme != nil, url.host != nil
        else { return nil }
        return url
    }

    private static func request(for url: URL) -> URLRequest? {
        // `?json=true` is load-bearing: a bare GET on a hosted join URL hits
        // the worker's SPA fallback, which answers 200 for live, dead, and
        // malformed trays alike (index.ts serveSPA short-circuit). Asking
        // for JSON reaches the real tray handler, whose body reports leader
        // connectivity or the next TRAY_SUPERSEDED hop.
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

/// Anything with an opaque identity and a join URL can be probed: live
/// iCloud sessions (`SyncedTraySession`) and remembered ones (`RecentJoin`)
/// share the same liveness question and the same secret-handling rules.
public protocol ProbableSession {
    /// One-way session id — the only identity that may leave this type.
    var id: String { get }
    /// Secret-bearing join URL. Probed, never logged, never persisted here.
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
