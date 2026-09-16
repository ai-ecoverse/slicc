import Foundation

#if canImport(os)
    import os
#endif

public protocol OptelTransport: Sendable {

    func send(_ event: RUMEvent, collectBaseURL: URL)
}

public final class URLSessionOptelTransport: OptelTransport {

    public static let defaultTimeout: TimeInterval = 10

    public static let loggerSubsystem = "com.slicc.swift-optel"

    public static let loggerCategory = "transport"

    private let session: URLSession
    private let timeout: TimeInterval
    private let encoder: JSONEncoder
    #if canImport(os)
        private let logger: Logger?
    #endif

    public init(
        session: URLSession = URLSessionOptelTransport.makeDefaultSession(),
        timeout: TimeInterval = URLSessionOptelTransport.defaultTimeout,
        debugLogging: Bool = false
    ) {
        self.session = session
        self.timeout = timeout
        self.encoder = JSONEncoder()
        #if canImport(os)
            self.logger =
                debugLogging
                ? Logger(subsystem: Self.loggerSubsystem, category: Self.loggerCategory)
                : nil
        #endif
    }

    public func send(_ event: RUMEvent, collectBaseURL: URL) {
        guard
            let request = Self.makeRequest(
                event: event,
                collectBaseURL: collectBaseURL,
                timeout: timeout,
                encoder: encoder
            )
        else {
            return
        }
        #if canImport(os)
            let logger = self.logger
            let urlString = request.url?.absoluteString ?? "<unknown>"
            let bodySize = request.httpBody?.count ?? 0
            logger?.debug("optel beacon → \(urlString, privacy: .public) (\(bodySize) bytes)")
            let task = session.dataTask(with: request) { _, response, _ in

                if let http = response as? HTTPURLResponse {
                    logger?.debug(
                        "optel beacon ← \(urlString, privacy: .public) status=\(http.statusCode)"
                    )
                }
            }
        #else
            let task = session.dataTask(with: request) { _, _, _ in

            }
        #endif
        task.resume()
    }

    public static func makeDefaultSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = defaultTimeout
        config.timeoutIntervalForResource = defaultTimeout
        config.waitsForConnectivity = false
        config.urlCache = nil
        return URLSession(configuration: config)
    }

    static func makeRequest(
        event: RUMEvent,
        collectBaseURL: URL,
        timeout: TimeInterval,
        encoder: JSONEncoder = JSONEncoder()
    ) -> URLRequest? {

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
