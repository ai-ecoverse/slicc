import Foundation
import Hummingbird
import HummingbirdWebSocket
import Logging
import NIOCore
import XCTest

@testable import slicc_server

private final class ConsoleOutputBox: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []
    func add(_ line: String) { lock.withLock { lines.append(line) } }
    func snapshot() -> [String] { lock.withLock { lines } }
}

private final class ConsoleDiscoveryURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 503,
            httpVersion: nil,
            headerFields: nil
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("[]".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class ConsoleForwarderRuntimeTests: XCTestCase {
    private func logger() -> Logger {
        var logger = Logger(label: "console-forwarder-runtime")
        logger.logLevel = .trace
        return logger
    }

    func testProductionWebSocketForwardsTextAndBinaryConsoleEvents() async throws {
        let port = try await findAvailablePort(startingFrom: 63_100)
        let serviceTask = Task { try? await makeApp(port: port).runService() }
        defer { serviceTask.cancel() }
        try await waitForServer(port: port)

        let output = ConsoleOutputBox()
        let forwarder = ConsoleForwarder(
            session: .shared,
            logger: logger(),
            output: { output.add($0) },
            pollAttempts: 2,
            pollDelayNanoseconds: 1_000_000,
            reconnectDelayNanoseconds: 1_000_000
        )
        await forwarder.start(cdpPort: port, pageUrl: "5710")
        try await waitUntil("console frames to be rendered") {
            output.snapshot().contains("[page] hello 42")
                && output.snapshot().contains { $0.contains("[page] careful") }
        }
        await forwarder.stop()
        await forwarder.stop()
    }

    func testDiscoveryFailuresEndTheLoopWithoutLeakingATask() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ConsoleDiscoveryURLProtocol.self]
        let output = ConsoleOutputBox()
        let forwarder = ConsoleForwarder(
            session: URLSession(configuration: configuration),
            logger: logger(),
            output: { output.add($0) },
            pollAttempts: 2,
            pollDelayNanoseconds: 0,
            reconnectDelayNanoseconds: 0
        )

        await forwarder.start(cdpPort: 1, pageUrl: "5710")
        try await waitUntil("failed discovery to disable forwarding") {
            output.snapshot().contains { $0.contains("console forwarding disabled") }
        }
        await forwarder.stop()
    }

    private func makeApp(port: Int) -> some ApplicationProtocol {
        let router = Router()
        router.get("/health") { _, _ in "ok" }
        router.get("/json/list") { _, _ in
            let json = """
                [{"type":"page","url":"http:
                "webSocketDebuggerUrl":"ws://127.0.0.1:\(port)/devtools/page/test"}]
                """
            return Response(
                status: .ok,
                headers: [.contentType: "application/json"],
                body: .init(byteBuffer: ByteBuffer(string: json))
            )
        }
        let wsRouter = Router(context: BasicWebSocketRequestContext.self)
        wsRouter.ws("/devtools/page/test") { _, _ in
            .upgrade()
        } onUpgrade: { inbound, outbound, _ in
            for try await message in inbound.messages(maxSize: 1024 * 1024) {
                guard case .text = message else { continue }
                try await outbound.write(
                    .text(
                        #"{"method":"Runtime.consoleAPICalled","params":{"type":"log","args":[{"type":"string","value":"hello"},{"type":"number","value":42}]}}"#
                    )
                )
                try await outbound.write(
                    .binary(
                        ByteBuffer(
                            string:
                                #"{"method":"Runtime.consoleAPICalled","params":{"type":"warning","args":[{"type":"string","value":"careful"}]}}"#
                        )
                    )
                )
                try await outbound.write(.text("not-json"))
            }
        }
        return Application(
            router: router,
            server: .http1WebSocketUpgrade(
                webSocketRouter: wsRouter,
                configuration: .init(maxFrameSize: 1024 * 1024)
            ),
            configuration: .init(address: .hostname("127.0.0.1", port: port))
        )
    }

    private func waitForServer(port: Int) async throws {
        let url = URL(string: "http:
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if let (_, response) = try? await URLSession.shared.data(from: url),
                (response as? HTTPURLResponse)?.statusCode == 200
            {
                return
            }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("mock console CDP server did not start")
    }
}
