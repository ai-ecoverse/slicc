import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "TrayStatusProbe")

enum TrayStatusProbeExhaustion {
    case retryable
    case terminal

    func message(maxAttempts: Int) -> String {
        switch self {
        case .retryable:
            "discoverJoinUrl: attempt window exhausted after \(maxAttempts) attempts; outer probe will retry"
        case .terminal:
            "discoverJoinUrl: gave up after \(maxAttempts) attempts; no further retries scheduled"
        }
    }
}

/// Polls the leader browser's `/api/tray-status` endpoint to recover the
/// freshly-minted tray join URL. Sliccstart launches the browser with
/// `--lead` so swift-server hands `tray=<workerBaseUrl>` to the webapp;
/// the webapp creates the tray and responds to the `tray_status` lick
/// with the join URL the launcher then threads into every follower
/// Electron app via `--join=<url>`.
///
/// How long to wait before the next `/api/tray-status` read.
///
/// A tray that is up and still minting (`200`) stays on `base`. A `503`
/// (no lick client — the tray is not there) or a transport error doubles
/// the gap, up to `cap`. `startLeaderProbe` keeps one pace across its
/// outer rounds so an unavailable tray does not stay at a fixed 1.5s.
final class TrayPollPace: @unchecked Sendable {
    static let unavailableCap: TimeInterval = 30

    private let lock = NSLock()
    private var delay: TimeInterval
    let base: TimeInterval
    private let cap: TimeInterval

    init(base: TimeInterval, cap: TimeInterval = TrayPollPace.unavailableCap) {
        self.base = base
        self.delay = base
        self.cap = cap
    }

    var current: TimeInterval {
        lock.lock()
        defer { lock.unlock() }
        return delay
    }

    /// `nil` is a transport failure. `503` is "tray not available".
    func note(status: Int?) {
        lock.lock()
        defer { lock.unlock() }
        if status == nil || status == 503 {
            let grown = delay <= 0 ? base : delay * 2
            delay = min(max(grown, base), cap)
        } else {
            delay = base
        }
    }
}

/// Mirrors `CDPLiveProbe`: thin struct with an injectable `fetch` closure
/// so unit tests can drive the retry/backoff loop without real HTTP.
struct TrayStatusProbe {
    /// Tuple of HTTP status code + response body bytes. Returning the
    /// status separately lets us distinguish "leader not ready" (503)
    /// from "leader has no tray yet" (200 with `state == "connecting"`).
    let fetch: (URL) async throws -> (Int, Data)
    let sleep: (TimeInterval) async -> Void

    init(
        fetch: @escaping (URL) async throws -> (Int, Data),
        sleep: @escaping (TimeInterval) async -> Void = { seconds in
            guard seconds > 0 else { return }
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        }
    ) {
        self.fetch = fetch
        self.sleep = sleep
    }

    static let `default` = TrayStatusProbe(fetch: { url in
        var request = URLRequest(url: url)
        request.timeoutInterval = 3.0
        let (data, response) = try await URLSession.shared.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    })

    /// Retry-bounded poll for the leader join URL. Returns `nil` on
    /// timeout, error, or a leader that has no active tray — never
    /// throws, so callers can `await` it from a fire-and-forget Task
    /// without crashing the launcher (review-patterns #1).
    func discoverJoinUrl(
        serveOrigin: String,
        maxAttempts: Int = 8,
        retryDelay: TimeInterval = 1.5,
        exhaustion: TrayStatusProbeExhaustion = .terminal,
        pace: TrayPollPace? = nil
    ) async -> String? {
        guard let url = URL(string: "\(serveOrigin)/api/tray-status") else {
            log.error("discoverJoinUrl: invalid serveOrigin \(serveOrigin, privacy: .public)")
            return nil
        }
        for attempt in 0..<maxAttempts {
            var statusCode: Int?
            do {
                let (status, data) = try await fetch(url)
                statusCode = status
                if status == 200,
                    let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                {
                    if let joinUrl = json["joinUrl"] as? String, !joinUrl.isEmpty {
                        log.info("discoverJoinUrl: found join URL on attempt \(attempt + 1)")
                        return joinUrl
                    }
                    let state = (json["state"] as? String) ?? "unknown"
                    log.info("discoverJoinUrl: leader state=\(state, privacy: .public) attempt=\(attempt + 1)")
                } else if status != 200 && status != 503 {
                    log.info("discoverJoinUrl: unexpected status \(status); will retry")
                }
            } catch {
                log.info("discoverJoinUrl: fetch error attempt=\(attempt + 1): \(error.localizedDescription, privacy: .public)")
            }
            pace?.note(status: statusCode)
            if attempt < maxAttempts - 1 {
                await sleep(pace?.current ?? retryDelay)
            }
        }
        let exhaustionMessage = exhaustion.message(maxAttempts: maxAttempts)
        switch exhaustion {
        case .retryable:
            log.info("\(exhaustionMessage, privacy: .public)")
        case .terminal:
            log.warning("\(exhaustionMessage, privacy: .public)")
        }
        return nil
    }
}
