import Hummingbird
import HummingbirdTesting
import Logging
import NIOCore
import XCTest

@testable import slicc_server

final class RequestLoggerTests: XCTestCase {
    func testColorPrefixMatchesStatusFamily() {
        XCTAssertEqual(RequestLogger<BasicRequestContext>.colorPrefix(for: 200), RequestLogger<BasicRequestContext>.green)
        XCTAssertEqual(RequestLogger<BasicRequestContext>.colorPrefix(for: 302), RequestLogger<BasicRequestContext>.yellow)
        XCTAssertEqual(RequestLogger<BasicRequestContext>.colorPrefix(for: 404), RequestLogger<BasicRequestContext>.red)
        XCTAssertEqual(RequestLogger<BasicRequestContext>.colorPrefix(for: 101), RequestLogger<BasicRequestContext>.reset)
    }

    func testColoredStatusCodeWrapsResetCode() {
        XCTAssertEqual(
            RequestLogger<BasicRequestContext>.coloredStatusCode(204),
            "\u{1b}[32m204\u{1b}[0m"
        )
    }

    func testLogsOneLinePerRequestIncludingFailedOnes() async throws {
        // A handler that throws still has to produce a log line, otherwise the
        // requests worth debugging are exactly the ones missing from the log.
        let sink = LogSink()
        let logger = Logger(label: "test.request") { _ in SinkLogHandler(sink: sink) }
        let router = Router(context: BasicRequestContext.self)
        router.middlewares.add(RequestLogger<BasicRequestContext>(logger: logger))
        router.get("/api/status") { _, _ in
            Response(status: .ok, body: .init(byteBuffer: ByteBuffer(string: "{}")))
        }
        router.get("/api/boom") { _, _ -> Response in
            throw HTTPError(.badGateway)
        }

        let app = Application(responder: router.buildResponder())
        try await app.test(.router) { client in
            try await client.execute(uri: "/api/status", method: .get) { XCTAssertEqual($0.status, .ok) }
            try await client.execute(uri: "/api/boom", method: .get) { XCTAssertEqual($0.status, .badGateway) }
        }

        let lines = sink.snapshot()
        XCTAssertTrue(lines.contains { $0.contains("200") && $0.contains("GET /api/status") })
        XCTAssertTrue(lines.contains { $0.contains("502") && $0.contains("GET /api/boom") })
        XCTAssertTrue(lines.allSatisfy { $0.hasSuffix("ms") })
    }
}

private final class LogSink: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []

    func record(_ line: String) {
        lock.lock()
        lines.append(line)
        lock.unlock()
    }

    func snapshot() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return lines
    }
}

private struct SinkLogHandler: LogHandler {
    let sink: LogSink
    var metadata: Logger.Metadata = [:]
    var logLevel: Logger.Level = .trace

    subscript(metadataKey key: String) -> Logger.Metadata.Value? {
        get { metadata[key] }
        set { metadata[key] = newValue }
    }

    func log(
        level: Logger.Level,
        message: Logger.Message,
        metadata: Logger.Metadata?,
        source: String,
        file: String,
        function: String,
        line: UInt
    ) {
        sink.record(message.description)
    }
}
