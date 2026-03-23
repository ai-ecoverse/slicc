import XCTest
@testable import slicc_server

private enum TestTimeoutError: Error {
    case timedOut(String)
}

actor MessageRecorder {
    private var messages: [String] = []

    func append(_ message: String) {
        self.messages.append(message)
    }

    func waitForMessage(timeout: TimeInterval = 1) async throws -> String {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let message = self.messages.first {
                return message
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw TestTimeoutError.timedOut("Timed out waiting for message")
    }

    func allMessages(timeout: TimeInterval = 1, count: Int) async throws -> [String] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if self.messages.count >= count {
                return self.messages
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw TestTimeoutError.timedOut("Timed out waiting for \(count) messages")
    }
}

final class LickSystemTests: XCTestCase {
    func testSendRequestThrowsWithoutConnectedClient() async {
        let lickSystem = LickSystem()

        do {
            _ = try await lickSystem.sendRequest(type: "tray_status")
            XCTFail("Expected request to fail without a connected client")
        } catch let error as LickSystemError {
            XCTAssertEqual(error, .noBrowserConnected)
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testSendRequestResolvesMatchingResponse() async throws {
        let lickSystem = LickSystem()
        let recorder = MessageRecorder()
        let client = WebSocketClient { text in
            await recorder.append(text)
        }
        await lickSystem.addClient(client)

        let responseTask = Task {
            try await lickSystem.sendRequest(
                type: "tray_status",
                data: ["includeFollowers": .bool(true)],
                timeout: 1
            )
        }

        let requestText = try await recorder.waitForMessage()
        let request = try LickSystem.decode(requestText)
        XCTAssertEqual(request["type"], LickSystem.JSONValue.string("tray_status"))
        XCTAssertEqual(request["includeFollowers"], LickSystem.JSONValue.bool(true))

        let requestId = try XCTUnwrap(request["requestId"]?.stringValue)
        await lickSystem.handleMessage(text: try LickSystem.encode([
            "type": .string("response"),
            "requestId": .string(requestId),
            "data": .object(["joined": .bool(true)])
        ]))

        let response = try await responseTask.value
        XCTAssertEqual(response, .object(["joined": .bool(true)]))
    }

    func testSendRequestTimesOut() async {
        let lickSystem = LickSystem()
        let client = WebSocketClient { _ in }
        await lickSystem.addClient(client)

        do {
            _ = try await lickSystem.sendRequest(type: "tray_status", timeout: 0.05)
            XCTFail("Expected request to time out")
        } catch let error as LickSystemError {
            guard case .requestTimeout = error else {
                XCTFail("Unexpected LickSystemError: \(error)")
                return
            }
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testBroadcastEventSendsToAllConnectedClients() async throws {
        let lickSystem = LickSystem()
        let firstRecorder = MessageRecorder()
        let secondRecorder = MessageRecorder()

        await lickSystem.addClient(WebSocketClient { text in
            await firstRecorder.append(text)
        })
        await lickSystem.addClient(WebSocketClient { text in
            await secondRecorder.append(text)
        })

        await lickSystem.broadcastEvent([
            "type": .string("webhook_event"),
            "id": .string("abc123")
        ])

        let firstMessages = try await firstRecorder.allMessages(count: 1)
        let secondMessages = try await secondRecorder.allMessages(count: 1)

        XCTAssertEqual(try LickSystem.decode(firstMessages[0])["id"], .string("abc123"))
        XCTAssertEqual(try LickSystem.decode(secondMessages[0])["id"], .string("abc123"))
    }
}