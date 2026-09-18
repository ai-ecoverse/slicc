import Foundation
import Hummingbird
import HummingbirdWebSocket
import Logging
import NIOCore
import XCTest

@testable import slicc_server

private final class OverlayRuntimeState: @unchecked Sendable {
    private let lock = NSLock()
    private var bypassed = false
    private var closedTarget: String?
    func recordBypass() { lock.withLock { bypassed = true } }
    func recordClose(_ target: String) { lock.withLock { closedTarget = target } }
    func snapshot() -> (Bool, String?) { lock.withLock { (bypassed, closedTarget) } }
}

final class OverlayTargetSessionRuntimeTests: XCTestCase {
    private func logger() -> Logger {
        var logger = Logger(label: "overlay-runtime-coverage")
        logger.logLevel = .trace
        return logger
    }

    func testRealSocketRunsConnectFlowReceivesEventsAndTimesOut() async throws {
        let port = try await findAvailablePort(startingFrom: 63_200)
        let serviceTask = Task { try? await makeApp(port: port).runService() }
        defer { serviceTask.cancel() }
        try await waitForServer(port: port)
        let state = OverlayRuntimeState()
        let session = makeSession(
            webSocketURL: "ws://127.0.0.1:\(port)/devtools/page/test",
            state: state
        )

        session.start()
        try await waitUntil("the overlay connect flow to finish") {
            state.snapshot().0
        }
        let timedOut = await session.sendCommand(
            method: "Never.respond",
            params: ["value": true],
            awaitResponse: true
        )
        XCTAssertNil(timedOut)
        await session.sendBootstrap()
        await session.gracefulShutdown()
        session.stop()
    }

    func testCommandsWithoutASocketFailClosed() async {
        let session = makeSession(webSocketURL: nil, state: OverlayRuntimeState())
        let response = await session.sendCommand(method: "Runtime.enable", awaitResponse: true)
        let fireAndForget = await session.sendCommand(method: "Runtime.enable")
        XCTAssertNil(response)
        XCTAssertNil(fireAndForget)
        session.stop()
    }

    private func makeSession(
        webSocketURL: String?,
        state: OverlayRuntimeState
    ) -> OverlayTargetSession {
        OverlayTargetSession(
            target: ElectronInspectableTarget(
                type: "page",
                title: "Runtime",
                url: "https://app.example.test/",
                webSocketDebuggerURL: webSocketURL
            ),
            bootstrapScript: "bootstrap()",
            statusBootstrapScript: "status()",
            servePort: 5710,
            bridgeToken: "bridge-token",
            session: .shared,
            logger: logger(),
            probeDelayNanoseconds: 0,
            commandTimeoutNanoseconds: 10_000_000,
            presenceCheckIntervalNanoseconds: 10_000_000_000,
            isAlreadyBypassed: { _ in false },
            recordBypassed: { _ in state.recordBypass() },
            isAlreadyEgressBlocked: { _ in false },
            recordEgressBlocked: { _ in },
            onClose: { state.recordClose($0) }
        )
    }

    private func makeApp(port: Int) -> some ApplicationProtocol {
        let router = Router()
        router.get("/health") { _, _ in "ok" }
        let wsRouter = Router(context: BasicWebSocketRequestContext.self)
        wsRouter.ws("/devtools/page/test") { _, _ in
            .upgrade()
        } onUpgrade: { inbound, outbound, _ in
            var sentNoise = false
            for try await message in inbound.messages(maxSize: 1024 * 1024) {
                guard case .text(let text) = message,
                    let data = text.data(using: .utf8),
                    let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                    let id = object["id"] as? Int,
                    let method = object["method"] as? String
                else { continue }
                if method == "Never.respond" { continue }

                let result: [String: Any]
                if method == "Page.addScriptToEvaluateOnNewDocument" {
                    result = ["identifier": "runtime-script"]
                } else if method == "Runtime.evaluate" {
                    let params = object["params"] as? [String: Any]
                    let expression = params?["expression"] as? String ?? ""
                    if expression.contains("hasGlobal") {
                        result = ["result": ["value": "gr"]]
                    } else if expression.contains("blank:") {
                        result = ["result": ["value": "ok"]]
                    } else if expression.contains("hasMarker") {
                        result = ["result": ["value": "ok"]]
                    } else {
                        result = [:]
                    }
                } else {
                    result = [:]
                }
                let response = try JSONSerialization.data(
                    withJSONObject: ["id": id, "result": result]
                )
                try await outbound.write(.text(String(decoding: response, as: UTF8.self)))

                if !sentNoise {
                    sentNoise = true
                    try await outbound.write(.binary(ByteBuffer(bytes: [0x00, 0x01])))
                    try await outbound.write(.text("not-json"))
                    try await outbound.write(.text(#"{"method":"Unrelated.event","params":{}}"#))
                }
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
        let url = URL(string: "http://127.0.0.1:\(port)/health")!
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if let (_, response) = try? await URLSession.shared.data(from: url),
                (response as? HTTPURLResponse)?.statusCode == 200
            {
                return
            }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("mock overlay CDP server did not start")
    }
}
