import Foundation
import XCTest

@testable import SliccTrayFollower

/// Round-trips of every `AgentEvent` variant, including the optional-field
/// branches and the `default` → `.unknown` decode fallback.
final class AgentEventTests: XCTestCase {

    private func roundTrip(_ event: AgentEvent) throws -> AgentEvent {
        try WireCodec.roundTrip(event)
    }

    private func sampleUsage() -> ChatMessageUsage {
        ChatMessageUsage(
            input: 10, output: 20, cacheRead: 1, cacheWrite: 2,
            cost: ChatMessageCost(input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33))
    }

    func testMessageStart() throws {
        guard case .messageStart(let messageId) = try roundTrip(.messageStart(messageId: "m1")) else {
            XCTFail("expected messageStart")
            return
        }
        XCTAssertEqual(messageId, "m1")
    }

    func testContentDelta() throws {
        guard case .contentDelta(let messageId, let text) = try roundTrip(.contentDelta(messageId: "m1", text: "hello")) else {
            XCTFail("expected contentDelta")
            return
        }
        XCTAssertEqual(messageId, "m1")
        XCTAssertEqual(text, "hello")
    }

    func testContentDoneWithModelAndUsage() throws {
        let usage = sampleUsage()
        guard
            case .contentDone(let messageId, let model, let decodedUsage) =
                try roundTrip(.contentDone(messageId: "m1", model: "claude-x", usage: usage))
        else {
            XCTFail("expected contentDone")
            return
        }
        XCTAssertEqual(messageId, "m1")
        XCTAssertEqual(model, "claude-x")
        XCTAssertEqual(decodedUsage, usage)
    }

    func testContentDoneWithoutOptionalFields() throws {
        guard
            case .contentDone(let messageId, let model, let usage) =
                try roundTrip(.contentDone(messageId: "m1", model: nil, usage: nil))
        else {
            XCTFail("expected contentDone")
            return
        }
        XCTAssertEqual(messageId, "m1")
        XCTAssertNil(model)
        XCTAssertNil(usage)
    }

    func testToolUseStartWithInput() throws {
        let input = try WireCodec.anyCodable(#"{"cmd":"ls"}"#)
        guard
            case .toolUseStart(let messageId, let toolName, let decodedInput, let toolCallId) =
                try roundTrip(
                    .toolUseStart(
                        messageId: "m1", toolName: "shell", toolInput: input, toolCallId: "call-1"))
        else {
            XCTFail("expected toolUseStart")
            return
        }
        XCTAssertEqual(messageId, "m1")
        XCTAssertEqual(toolName, "shell")
        XCTAssertEqual(decodedInput, input)
        XCTAssertEqual(toolCallId, "call-1")
    }

    func testToolUseStartWithoutInput() throws {
        guard case .toolUseStart(_, _, let input, let toolCallId) = try roundTrip(.toolUseStart(messageId: "m1", toolName: "shell", toolInput: nil)) else {
            XCTFail("expected toolUseStart")
            return
        }
        XCTAssertNil(input)
        // A leader built before #2306 sends no id; the case stays decodable and
        // the follower falls back to pairing results by tool name.
        XCTAssertNil(toolCallId)
    }

    func testToolResultWithError() throws {
        guard
            case .toolResult(let messageId, let toolName, let result, let isError, let toolCallId) =
                try roundTrip(
                    .toolResult(
                        messageId: "m1", toolName: "shell", result: "boom", isError: true,
                        toolCallId: "call-2"))
        else {
            XCTFail("expected toolResult")
            return
        }
        XCTAssertEqual(messageId, "m1")
        XCTAssertEqual(toolName, "shell")
        XCTAssertEqual(result, "boom")
        XCTAssertEqual(isError, true)
        XCTAssertEqual(toolCallId, "call-2")
    }

    func testToolResultWithoutErrorFlag() throws {
        guard
            case .toolResult(_, _, _, let isError, let toolCallId) = try roundTrip(
                .toolResult(messageId: "m1", toolName: "shell", result: "ok", isError: nil))
        else {
            XCTFail("expected toolResult")
            return
        }
        XCTAssertNil(isError)
        XCTAssertNil(toolCallId)
    }

    func testToolUI() throws {
        guard
            case .toolUI(let messageId, let toolName, let requestId, let html) =
                try roundTrip(.toolUI(messageId: "m1", toolName: "chart", requestId: "r1", html: "<div/>"))
        else {
            XCTFail("expected toolUI")
            return
        }
        XCTAssertEqual(messageId, "m1")
        XCTAssertEqual(toolName, "chart")
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(html, "<div/>")
    }

    func testToolUIDone() throws {
        guard case .toolUIDone(let messageId, let requestId) = try roundTrip(.toolUIDone(messageId: "m1", requestId: "r1")) else {
            XCTFail("expected toolUIDone")
            return
        }
        XCTAssertEqual(messageId, "m1")
        XCTAssertEqual(requestId, "r1")
    }

    func testTurnEnd() throws {
        guard case .turnEnd(let messageId) = try roundTrip(.turnEnd(messageId: "m1")) else {
            XCTFail("expected turnEnd")
            return
        }
        XCTAssertEqual(messageId, "m1")
    }

    func testError() throws {
        guard case .error(let error) = try roundTrip(.error(error: "kaboom")) else {
            XCTFail("expected error")
            return
        }
        XCTAssertEqual(error, "kaboom")
    }

    func testScreenshotWithUrl() throws {
        guard case .screenshot(let base64, let url) = try roundTrip(.screenshot(base64: "AAAA", url: "https://x")) else {
            XCTFail("expected screenshot")
            return
        }
        XCTAssertEqual(base64, "AAAA")
        XCTAssertEqual(url, "https://x")
    }

    func testScreenshotWithoutUrl() throws {
        guard case .screenshot(let base64, let url) = try roundTrip(.screenshot(base64: "AAAA", url: nil)) else {
            XCTFail("expected screenshot")
            return
        }
        XCTAssertEqual(base64, "AAAA")
        XCTAssertNil(url)
    }

    func testTerminalOutput() throws {
        guard case .terminalOutput(let text) = try roundTrip(.terminalOutput(text: "$ ls")) else {
            XCTFail("expected terminalOutput")
            return
        }
        XCTAssertEqual(text, "$ ls")
    }

    func testUnknownEncodesBareType() throws {
        // `.unknown` only carries a `type`, so re-encoding it yields just that tag.
        XCTAssertEqual(try WireCodec.discriminator(AgentEvent.unknown(type: "future_event")), "future_event")
    }

    func testUnknownTypeDecodesToUnknown() throws {
        guard case .unknown(let type) = try WireCodec.decode(AgentEvent.self, from: #"{"type":"brand_new"}"#) else {
            XCTFail("expected unknown")
            return
        }
        XCTAssertEqual(type, "brand_new")
    }
}
