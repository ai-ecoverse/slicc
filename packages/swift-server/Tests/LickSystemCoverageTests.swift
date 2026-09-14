import Foundation
import Hummingbird
import HummingbirdWebSocket
import NIOCore
import XCTest

@testable import slicc_server

private final class LickCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = 0

    func increment() { lock.withLock { stored += 1 } }
    func snapshot() -> Int { lock.withLock { stored } }
}

private final class LickTextBox: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []

    func add(_ value: String) { lock.withLock { values.append(value) } }
    func snapshot() -> [String] { lock.withLock { values } }
}

final class LickSystemCoverageTests: XCTestCase {
    func testValueDescriptionsErrorDescriptionsAndClientIdentity() async throws {
        XCTAssertEqual(LickSystemError.requestTimeout(requestId: "1", timeout: 2).localizedDescription, "Request timeout")
        XCTAssertEqual(LickSystemError.remoteError("remote").localizedDescription, "remote")

        let values: [LickSystem.JSONValue] = [
            .string("text"), .number(2.5), .bool(true),
            .object(["key": .string("value")]), .array([.number(1)]), .null,
        ]
        let encoded = try JSONEncoder().encode(values)
        XCTAssertEqual(try JSONDecoder().decode([LickSystem.JSONValue].self, from: encoded), values)
        XCTAssertEqual(values.map(\.description).prefix(3), ["text", "2.5", "true"])
        XCTAssertTrue(values[3].description.contains("key"))
        XCTAssertTrue(values[4].description.contains("1.0"))
        XCTAssertEqual(values[5].description, "null")

        let id = UUID()
        let closed = LickCounter()
        let first = WebSocketClient(id: id, sendText: { _ in }, close: { closed.increment() })
        let sameIdentity = WebSocketClient(id: id, sendText: { _ in })
        XCTAssertEqual(first, sameIdentity)
        XCTAssertEqual(Set([first, sameIdentity]).count, 1)
        try await first.send(text: "ok")
        await first.close()
        XCTAssertEqual(closed.snapshot(), 1)
    }

    func testAliasesRemoteErrorsRemovalAndSendFailure() async throws {
        let system = LickSystem()
        let sent = LickTextBox()
        let first = WebSocketClient { sent.add("first:\($0)") }
        let second = WebSocketClient { text in
            sent.add(text)
            let request = try LickSystem.decode(text)
            await system.handleMessage(
                text: try LickSystem.encode([
                    "type": .string("response"),
                    "requestId": request["requestId"]!,
                    "error": .string("denied"),
                ]))
        }
        await system.addClient(first)
        await system.addClient(second)

        do {
            _ = try await system.sendLickRequest(type: "coverage", timeout: 1)
            XCTFail("remote errors must fail the request")
        } catch let error as LickSystemError {
            XCTAssertEqual(error, .remoteError("denied"))
        }

        await system.removeClient(second)
        let request = Task { try await system.sendRequest(type: "fallback", timeout: 1) }
        try await waitUntil("fallback client request") { sent.snapshot().contains { $0.hasPrefix("first:") } }
        let text = try XCTUnwrap(sent.snapshot().last { $0.hasPrefix("first:") }).dropFirst("first:".count)
        let payload = try LickSystem.decode(String(text))
        await system.handleMessage(
            text: try LickSystem.encode([
                "type": .string("response"),
                "requestId": payload["requestId"]!,
            ]))
        let fallbackResponse = try await request.value
        XCTAssertEqual(fallbackResponse, .null)

        let failing = WebSocketClient { _ in throw URLError(.cannotConnectToHost) }
        await system.addClient(failing)
        do {
            _ = try await system.sendRequest(type: "fails", timeout: 1)
            XCTFail("send failure must propagate")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .cannotConnectToHost)
        }
        await system.shutdown()
    }

    func testBroadcastFailureMalformedResponsesAndShutdownPendingRequest() async throws {
        let system = LickSystem()
        let closed = LickCounter()
        let sent = LickTextBox()
        let healthy = WebSocketClient(sendText: { sent.add($0) }, close: { closed.increment() })
        let broken = WebSocketClient(sendText: { _ in throw URLError(.cannotWriteToFile) }, close: { closed.increment() })
        await system.addClient(healthy)
        await system.addClient(broken)
        await system.broadcastLickEvent(["type": .string("event")])
        try await waitUntil("healthy broadcast") { !sent.snapshot().isEmpty }

        await system.handleMessage(text: "not-json")
        await system.handleMessage(text: #"{"type":"event"}"#)
        await system.handleMessage(text: #"{"type":"response","requestId":"unknown","data":true}"#)
        await system.handleMessage(text: #"{"type":"response","requestId":"unknown","error":"late"}"#)

        let pending = Task { try await system.sendRequest(type: "pending", timeout: 30) }
        try await waitUntil("pending request send") { sent.snapshot().count >= 2 }
        await system.shutdown()
        do {
            _ = try await pending.value
            XCTFail("shutdown must fail pending requests")
        } catch let error as LickSystemError {
            XCTAssertEqual(error, .noBrowserConnected)
        }
        XCTAssertGreaterThanOrEqual(closed.snapshot(), 1)
        await system.broadcastEvent(["type": .string("after-shutdown")])
    }

    func testRealWebSocketRouteCarriesRequestsResponsesEventsAndBinaryFrames() async throws {
        let port = try await findAvailablePort(startingFrom: 63_200)
        let system = LickSystem()
        let router = Router()
        router.get("/health") { _, _ in "ok" }
        let app = Application(
            router: router,
            server: .http1WebSocketUpgrade(
                webSocketRouter: LickWebSocketRoute.makeRouter(lickSystem: system, maxMessageSize: 1024),
                configuration: .init(maxFrameSize: 2048)
            ),
            configuration: .init(address: .hostname("127.0.0.1", port: port))
        )
        let serviceTask = Task { try? await app.runService() }
        defer { serviceTask.cancel() }
        try await waitForLickServer(port: port)

        let socket = URLSession.shared.webSocketTask(
            with: URL(string: "ws://127.0.0.1:\(port)/licks-ws")!)
        socket.resume()
        defer { socket.cancel(with: .goingAway, reason: nil) }
        try await Task.sleep(nanoseconds: 100_000_000)

        // A binary message is deliberately ignored, keeping the route alive.
        try await socket.send(.data(Data([1, 2, 3])))
        let responseTask = Task { try await system.sendLickRequest(type: "route", timeout: 2) }
        let requestText = try await receiveText(from: socket)
        let request = try LickSystem.decode(requestText)
        try await socket.send(
            .string(
                try LickSystem.encode([
                    "type": .string("response"),
                    "requestId": request["requestId"]!,
                    "data": .array([.bool(true)]),
                ])))
        let response = try await responseTask.value
        XCTAssertEqual(response, .array([.bool(true)]))

        await system.broadcastEvent(["type": .string("route-event")])
        let eventText = try await receiveText(from: socket)
        XCTAssertEqual(try LickSystem.decode(eventText)["type"], .string("route-event"))
        socket.cancel(with: .goingAway, reason: nil)
        await system.shutdown()
    }

    private func receiveText(from socket: URLSessionWebSocketTask) async throws -> String {
        switch try await socket.receive() {
        case .string(let text): return text
        case .data(let data): return String(decoding: data, as: UTF8.self)
        @unknown default: return ""
        }
    }

    private func waitForLickServer(port: Int) async throws {
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
        XCTFail("lick route did not start")
    }
}
