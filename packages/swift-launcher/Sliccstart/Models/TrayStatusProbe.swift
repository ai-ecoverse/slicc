import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "TrayStatusProbe")

/// Polls the leader browser's `/api/tray-status` endpoint to recover the
/// freshly-minted tray join URL. Sliccstart launches the browser with
/// `--lead` so swift-server hands `tray=<workerBaseUrl>` to the webapp;
/// the webapp creates the tray and responds to the `tray_status` lick
/// with the join URL the launcher then threads into every follower
/// Electron app via `--join=<url>`.
///
/// Mirrors `CDPLiveProbe`: thin struct with an injectable `fetch` closure
/// so unit tests can drive the retry/backoff loop without real HTTP.
struct TrayStatusProbe {
    /// Tuple of HTTP status code + response body bytes. Returning the
    /// status separately lets us distinguish "leader not ready" (503)
    /// from "leader has no tray yet" (200 with `state == "connecting"`).
    let fetch: (URL) async throws -> (Int, Data)

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
        retryDelay: TimeInterval = 1.5
    ) async -> String? {
        guard let url = URL(string: "\(serveOrigin)/api/tray-status") else {
            log.error("discoverJoinUrl: invalid serveOrigin \(serveOrigin, privacy: .public)")
            return nil
        }
        for attempt in 0..<maxAttempts {
            do {
                let (status, data) = try await fetch(url)
                if status == 200,
                   let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
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
            if attempt < maxAttempts - 1 {
                try? await Task.sleep(nanoseconds: UInt64(retryDelay * 1_000_000_000))
            }
        }
        log.info("discoverJoinUrl: gave up after \(maxAttempts) attempts")
        return nil
    }
}
