import Foundation
#if canImport(os)
import os
#endif

/// Fire-and-forget beacon transport. Implementations send a single
/// ``RUMEvent`` to the collector identified by `collectBaseURL` and must
/// never block the caller or surface network errors.
public protocol OptelTransport: Sendable {
    /// Send an event. Errors are swallowed; the call returns immediately.
    func send(_ event: RUMEvent, collectBaseURL: URL)
}

/// Default ``OptelTransport`` backed by `URLSession`.
///
/// Mirrors `navigator.sendBeacon` semantics from `helix-rum-js`:
/// - `POST {collectBaseURL}/.rum/{weight}` with `Content-Type: application/json`.
/// - Body is the JSON-encoded ``RUMEvent`` (with `pingData` flattened).
/// - Uses an ephemeral, non-caching `URLSession` and a finite per-request
///   timeout so a stuck collector cannot retain memory indefinitely.
/// - The returned `URLSessionDataTask` is resumed and discarded; any
///   transport / decode error from the completion handler is silently
///   dropped.
///
/// When `debugLogging` is enabled (via ``OptelEnvConfig`` honoring
/// `OPTEL_DEBUG`, or the explicit init parameter) every beacon is logged to
/// `os.Logger` with the request URL, payload byte count, and (on response)
/// HTTP status code. Default off — no logging, no behavior change.
public final class URLSessionOptelTransport: OptelTransport {
    /// Default per-request timeout. Beacons are best-effort, so a short
    /// window is preferable to letting requests pile up.
    public static let defaultTimeout: TimeInterval = 10

    /// Subsystem used for `os.Logger` wire logging when `debugLogging` is on.
    public static let loggerSubsystem = "com.slicc.swift-optel"

    /// Category used for `os.Logger` wire logging when `debugLogging` is on.
    public static let loggerCategory = "transport"

    private let session: URLSession
    private let timeout: TimeInterval
    private let encoder: JSONEncoder
    #if canImport(os)
    private let logger: Logger?
    #endif

    /// Construct a transport.
    ///
    /// - Parameters:
    ///   - session: Override for testing; defaults to an ephemeral session.
    ///   - timeout: Per-request timeout in seconds.
    ///   - debugLogging: When `true`, emit `os.Logger` entries for every
    ///     beacon (URL, payload size, response status). Default `false`.
    public init(
        session: URLSession = URLSessionOptelTransport.makeDefaultSession(),
        timeout: TimeInterval = URLSessionOptelTransport.defaultTimeout,
        debugLogging: Bool = false
    ) {
        self.session = session
        self.timeout = timeout
        self.encoder = JSONEncoder()
        #if canImport(os)
        self.logger = debugLogging
            ? Logger(subsystem: Self.loggerSubsystem, category: Self.loggerCategory)
            : nil
        #endif
    }

    public func send(_ event: RUMEvent, collectBaseURL: URL) {
        guard let request = Self.makeRequest(
            event: event,
            collectBaseURL: collectBaseURL,
            timeout: timeout,
            encoder: encoder
        ) else {
            return
        }
        #if canImport(os)
        let logger = self.logger
        let urlString = request.url?.absoluteString ?? "<unknown>"
        let bodySize = request.httpBody?.count ?? 0
        logger?.debug("optel beacon → \(urlString, privacy: .public) (\(bodySize) bytes)")
        let task = session.dataTask(with: request) { _, response, _ in
            // Fire-and-forget: beacon failures are non-actionable; never
            // propagate them back to the caller. This is the Swift analogue
            // of the JS `.catch(() => {})` swallow.
            if let http = response as? HTTPURLResponse {
                logger?.debug(
                    "optel beacon ← \(urlString, privacy: .public) status=\(http.statusCode)"
                )
            }
        }
        #else
        let task = session.dataTask(with: request) { _, _, _ in
            // Fire-and-forget: beacon failures are non-actionable; never
            // propagate them back to the caller. This is the Swift analogue
            // of the JS `.catch(() => {})` swallow.
        }
        #endif
        task.resume()
    }

    /// Default ephemeral session: no on-disk cache, no cookie persistence,
    /// short request timeout suitable for beacon traffic.
    public static func makeDefaultSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = defaultTimeout
        config.timeoutIntervalForResource = defaultTimeout
        config.waitsForConnectivity = false
        config.urlCache = nil
        return URLSession(configuration: config)
    }

    /// Build the `URLRequest` for a single beacon. Exposed `internal` so the
    /// test suite can assert URL / method / headers / body without exercising
    /// the network. Returns `nil` if URL composition fails.
    static func makeRequest(
        event: RUMEvent,
        collectBaseURL: URL,
        timeout: TimeInterval,
        encoder: JSONEncoder = JSONEncoder()
    ) -> URLRequest? {
        // `URL(string: ".rum/\(weight)", relativeTo: base)` matches the
        // `new URL('.rum/' + weight, collectBaseURL)` construction used by
        // helix-rum-js: relative to the base path, with the trailing slash
        // on `https://rum.hlx.page/` producing `…/.rum/{weight}`.
        guard let url = URL(string: ".rum/\(event.weight)", relativeTo: collectBaseURL) else {
            return nil
        }
        guard let body = try? encoder.encode(event) else {
            return nil
        }
        var request = URLRequest(url: url.absoluteURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = timeout
        request.httpBody = body
        return request
    }
}
