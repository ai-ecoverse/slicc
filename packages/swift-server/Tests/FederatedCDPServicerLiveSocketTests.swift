import Foundation
import Hummingbird
import HummingbirdTesting
import HummingbirdWebSocket
import Logging
import SliccTrayFollower
import XCTest

@testable import slicc_server

/// Integration test for the federated-CDP servicer over a **real** WebSocket.
///
/// The servicer's unit tests inject a mock `CDPWebSocketTransport`, which hid a
/// production bug: the servicer used `URLSessionWebSocketTask`, whose handshake
/// silently fails against Electron/Chrome's raw CDP endpoint (found only by
/// driving Signal live). This test stands up a real CDP-speaking WebSocket
/// server (Hummingbird `.live`) and drives the servicer's **production**
/// transport (`WebSocketKitCDPTransport`) through connect → probe → cdp.request
/// → cdp.response (small + chunked) → cdp.event, so a broken real-socket
/// transport fails here instead of in production.
final class FederatedCDPServicerLiveSocketTests: XCTestCase {

    /// Minimal CDP-over-WebSocket mock server bound to an explicit loopback
    /// port: replies to each `{id, method}` command and emits one unsolicited
    /// event after the first command. Run as a real service (not `.test(.live)`,
    /// which does not run the WebSocket-upgrade server).
    private func makeApp(port: Int) -> some ApplicationProtocol {
        let httpRouter = Router()
        httpRouter.get("/health") { _, _ in "ok" }

        let wsRouter = Router(context: BasicWebSocketRequestContext.self)
        wsRouter.ws("/devtools/browser/test") { _, _ in
            .upgrade()
        } onUpgrade: { inbound, outbound, _ in
            var emittedEvent = false
            for try await message in inbound.messages(maxSize: 64 * 1024 * 1024) {
                guard case .text(let text) = message else { continue }
                if let reply = Self.mockReply(for: text) {
                    try await outbound.write(.text(reply))
                }
                if !emittedEvent {
                    emittedEvent = true
                    try await outbound.write(.text(#"{"method":"Test.event","params":{"ok":true}}"#))
                }
            }
        }

        return Application(
            router: httpRouter,
            server: .http1WebSocketUpgrade(
                webSocketRouter: wsRouter,
                configuration: .init(maxFrameSize: 64 * 1024 * 1024)),
            configuration: .init(address: .hostname("127.0.0.1", port: port))
        )
    }

    private static func mockReply(for text: String) -> String? {
        guard let data = text.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let id = object["id"] as? Int
        else { return nil }
        let method = object["method"] as? String ?? ""
        let result: [String: Any]
        switch method {
        // A >64 KB result forces the servicer to chunk the cdp.response.
        case "SLICC.large": result = ["blob": String(repeating: "x", count: 200_000)]
        default: result = ["value": 42, "echoedMethod": method]
        }
        let payload: [String: Any] = ["id": id, "result": result]
        guard let out = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
        return String(decoding: out, as: UTF8.self)
    }

    func testServicerRoundTripsOverRealWebSocket() async throws {
        let port = try await findAvailablePort(startingFrom: 9460)
        let serviceTask = Task { try? await makeApp(port: port).runService() }
        defer { serviceTask.cancel() }
        try await waitForServer(port: port)

        let wsURL = try XCTUnwrap(URL(string: "ws://127.0.0.1:\(port)/devtools/browser/test"))
        let box = FollowerMessageBox()
        let servicer = FederatedCDPServicer(
            runtimeId: "it", logger: Logger(label: "it"), send: { box.add($0) })
        // PRODUCTION connect path — the real WebSocketKit transport.
        await servicer.connect(browserWsUrl: wsURL)

        // 1) A small cdp.request round-trips to a single (unchunked) cdp.response.
        await servicer.handleCdpRequest(
            requestId: "r1", method: "Runtime.evaluate", params: ["expression": "1"], sessionId: nil)
        try await waitUntil {
            box.messages.contains {
                if case .cdpResponse(let requestId, let result, let error, let chunkData, _, _) = $0 {
                    return requestId == "r1" && error == nil && result != nil && chunkData == nil
                }
                return false
            }
        }

        // 2) A large result comes back chunked (chunkData / totalChunks).
        await servicer.handleCdpRequest(
            requestId: "r2", method: "SLICC.large", params: nil, sessionId: nil)
        try await waitUntil {
            box.messages.contains {
                if case .cdpResponse(let requestId, _, _, let chunkData, _, let total) = $0 {
                    return requestId == "r2" && chunkData != nil && (total ?? 0) > 1
                }
                return false
            }
        }

        // 3) An unsolicited server event is forwarded as cdp.event.
        try await waitUntil {
            box.messages.contains {
                if case .cdpEvent(let method, _, _) = $0 { return method == "Test.event" }
                return false
            }
        }

        await servicer.stop()
        serviceTask.cancel()
    }

    /// The bug that this whole file exists for: `URLSessionWebSocketTask` fails
    /// the handshake against a real browser's raw CDP endpoint, where WebSocketKit
    /// succeeds. A mock (or a plain WebSocket server) can't reproduce it, so this
    /// runs the servicer's PRODUCTION transport against a real headless Chrome and
    /// asserts a real `Target.getTargets` round-trip. Skipped (never failed) when
    /// no Chrome is resolvable or it does not come up, so CI without a browser is
    /// unaffected; a genuine transport regression against a real browser fails it.
    func testServicerRoundTripsAgainstRealChromeBrowserCDP() async throws {
        guard let chromePath = ChromeLauncher().findChromeExecutable() else {
            throw XCTSkip("No Chrome/Chromium resolvable; skipping real-browser CDP test")
        }
        let port = try await findAvailablePort(startingFrom: 9470)
        let userDataDir = NSTemporaryDirectory() + "slicc-cdp-it-\(UUID().uuidString)"

        let chrome = Process()
        chrome.executableURL = URL(fileURLWithPath: chromePath)
        chrome.arguments = [
            "--headless=new",
            "--remote-debugging-port=\(port)",
            "--user-data-dir=\(userDataDir)",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-gpu",
        ]
        chrome.standardOutput = Pipe()
        chrome.standardError = Pipe()
        try chrome.run()
        // Only ever terminates the Chrome THIS test launched (never any other).
        defer {
            chrome.terminate()
            try? FileManager.default.removeItem(atPath: userDataDir)
        }

        guard let wsURL = await resolveBrowserWs(port: port) else {
            throw XCTSkip("headless Chrome did not expose /json/version in time")
        }

        let box = FollowerMessageBox()
        let servicer = FederatedCDPServicer(
            runtimeId: "it", logger: Logger(label: "it-chrome"), send: { box.add($0) })
        await servicer.connect(browserWsUrl: wsURL)  // production WebSocketKit transport

        await servicer.handleCdpRequest(
            requestId: "r1", method: "Target.getTargets", params: nil, sessionId: nil)
        try await waitUntil {
            box.messages.contains {
                if case .cdpResponse(let requestId, let result, let error, _, _, _) = $0 {
                    return requestId == "r1" && error == nil && result != nil
                }
                return false
            }
        }
        await servicer.stop()
    }

    private func resolveBrowserWs(port: Int) async -> URL? {
        let versionURL = URL(string: "http://127.0.0.1:\(port)/json/version")!
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if let (data, _) = try? await URLSession.shared.data(from: versionURL),
                let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let ws = object["webSocketDebuggerUrl"] as? String,
                let url = URL(string: ws)
            {
                return url
            }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        return nil
    }

    /// Poll `/health` until the service is accepting connections.
    private func waitForServer(port: Int) async throws {
        let health = URL(string: "http://127.0.0.1:\(port)/health")!
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if let (_, response) = try? await URLSession.shared.data(from: health),
                (response as? HTTPURLResponse)?.statusCode == 200
            {
                return
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw XCTSkip("mock CDP server did not start in time")
    }

    private func waitUntil(
        timeout: TimeInterval = 10, _ condition: @escaping () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        XCTFail("timed out waiting for the expected follower message")
    }
}
