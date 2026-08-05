import Foundation
import SliccTraySession

/// Quick liveness probe for iCloud-discovered sessions. iCloud KVS keeps
/// advertising a session for a while after its leader is gone, so the
/// Settings list probes each join URL with a short GET — the tray hub
/// answers for live trays and errors for reclaimed ones — and unreachable
/// sessions sink to the bottom of the list instead of posing as joinable.
///
/// A GET does not attach a participant (joining is the POST flow), so the
/// probe is invisible to the leader. The join URL carries the session
/// secret: it is never logged and the verdict map is keyed by the one-way
/// session id.
@MainActor
final class SessionReachability: ObservableObject {
    enum Verdict: Equatable {
        case reachable
        case unreachable
    }

    @Published private(set) var verdicts: [String: Verdict] = [:]
    private var inFlight: Set<String> = []
    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.ephemeral
        // Fast verdicts beat certain ones here: a hub that cannot answer in
        // four seconds is not a session worth sorting to the top.
        config.timeoutIntervalForRequest = 4
        config.timeoutIntervalForResource = 4
        session = URLSession(configuration: config)
    }

    /// True while no probe has finished for this id — treated as reachable
    /// for sorting so rows do not jump while verdicts trickle in.
    func presumedReachable(_ id: String) -> Bool {
        verdicts[id] != .unreachable
    }

    func probe(_ sessions: [SyncedTraySession]) {
        for tray in sessions {
            guard !inFlight.contains(tray.id), let url = URL(string: tray.joinUrl) else { continue }
            inFlight.insert(tray.id)
            Task { [weak self] in
                guard let self else { return }
                let verdict = await Self.probeVerdict(url: url, session: session)
                inFlight.remove(tray.id)
                verdicts[tray.id] = verdict
            }
        }
    }

    private static func probeVerdict(url: URL, session: URLSession) async -> Verdict {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        guard
            let (_, response) = try? await session.data(for: request),
            let http = response as? HTTPURLResponse,
            http.statusCode < 400
        else { return .unreachable }
        return .reachable
    }
}
