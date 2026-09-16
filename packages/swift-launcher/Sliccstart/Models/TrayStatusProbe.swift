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

struct TrayStatusProbe {

    let fetch: (URL) async throws -> (Int, Data)

    static let `default` = TrayStatusProbe(fetch: { url in
        var request = URLRequest(url: url)
        request.timeoutInterval = 3.0
        let (data, response) = try await URLSession.shared.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    })

    func discoverJoinUrl(
        serveOrigin: String,
        maxAttempts: Int = 8,
        retryDelay: TimeInterval = 1.5,
        exhaustion: TrayStatusProbeExhaustion = .terminal
    ) async -> String? {
        guard let url = URL(string: "\(serveOrigin)/api/tray-status") else {
            log.error("discoverJoinUrl: invalid serveOrigin \(serveOrigin, privacy: .public)")
            return nil
        }
        for attempt in 0..<maxAttempts {
            do {
                let (status, data) = try await fetch(url)
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
            if attempt < maxAttempts - 1 {
                try? await Task.sleep(nanoseconds: UInt64(retryDelay * 1_000_000_000))
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
