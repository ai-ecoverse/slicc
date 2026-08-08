import Foundation
import XCTest

@testable import SliccTrayFollower

/// Codable coverage of the chat payload types: `ChatMessage`, `ToolCall`,
/// `MessageAttachment(Kind)`, `LickState`, `ChatMessageUsage`/`Cost`, and the
/// lenient enum decode fallbacks that keep a snapshot from being emptied by a
/// single unrecognized string.
final class ChatMessageTests: XCTestCase {

    func testMessageRoleRoundTrip() throws {
        XCTAssertEqual(try WireCodec.roundTrip(MessageRole.user), .user)
        XCTAssertEqual(try WireCodec.roundTrip(MessageRole.assistant), .assistant)
    }

    func testFullChatMessageRoundTrip() throws {
        let usage = ChatMessageUsage(
            input: 5, output: 6, cacheRead: 1, cacheWrite: 2,
            cost: ChatMessageCost(input: 0.5, output: 0.6, cacheRead: 0.1, cacheWrite: 0.2, total: 1.4))
        let attachment = MessageAttachment(id: "a1", name: "f", mimeType: "text/plain", size: 3, kind: .text, text: "abc")
        let tool = ToolCall(id: "t1", name: "shell", input: try WireCodec.anyCodable(#"{"cmd":"ls"}"#), result: "ok", isError: false)
        let original = ChatMessage(
            id: "m1", role: .assistant, content: "hi", timestamp: 1_700.5,
            attachments: [attachment], toolCalls: [tool], isStreaming: true, model: "claude-x",
            usage: usage, source: "cone", channel: "webhook", lickCount: 2, lickParts: ["a", "b"],
            lickId: "lk1", lickState: .confirmed, queued: false, error: true)

        let decoded = try WireCodec.roundTrip(original)
        XCTAssertEqual(decoded.id, "m1")
        XCTAssertEqual(decoded.role, .assistant)
        XCTAssertEqual(decoded.content, "hi")
        XCTAssertEqual(decoded.timestamp, 1_700.5)
        XCTAssertEqual(decoded.attachments, [attachment])
        XCTAssertEqual(decoded.toolCalls?.count, 1)
        XCTAssertEqual(decoded.toolCalls?.first?.id, "t1")
        XCTAssertEqual(decoded.toolCalls?.first?.result, "ok")
        XCTAssertEqual(decoded.isStreaming, true)
        XCTAssertEqual(decoded.model, "claude-x")
        XCTAssertEqual(decoded.usage, usage)
        XCTAssertEqual(decoded.source, "cone")
        XCTAssertEqual(decoded.channel, "webhook")
        XCTAssertEqual(decoded.lickCount, 2)
        XCTAssertEqual(decoded.lickParts, ["a", "b"])
        XCTAssertEqual(decoded.lickState, .confirmed)
        XCTAssertEqual(decoded.queued, false)
        XCTAssertEqual(decoded.error, true)
    }

    func testMinimalChatMessageOmitsOptionalKeys() throws {
        let original = ChatMessage(id: "m1", role: .user, content: "hi", timestamp: 1)
        let json = try WireCodec.jsonString(original)
        XCTAssertFalse(json.contains("attachments"))
        XCTAssertFalse(json.contains("toolCalls"))
        XCTAssertFalse(json.contains("usage"))

        let decoded = try WireCodec.roundTrip(original)
        XCTAssertNil(decoded.attachments)
        XCTAssertNil(decoded.toolCalls)
        XCTAssertNil(decoded.usage)
    }

    func testToolCallRoundTrip() throws {
        let tool = ToolCall(id: "t1", name: "grep", input: nil)
        let decoded = try WireCodec.roundTrip(tool)
        XCTAssertEqual(decoded.id, "t1")
        XCTAssertEqual(decoded.name, "grep")
        XCTAssertNil(decoded.input)
        XCTAssertNil(decoded.result)
        XCTAssertNil(decoded.isError)
    }

    func testMessageAttachmentKindKnownValues() throws {
        for kind in [MessageAttachmentKind.image, .text, .file] {
            XCTAssertEqual(try WireCodec.roundTrip(kind), kind)
        }
    }

    func testMessageAttachmentKindUnknownDegradesToFile() throws {
        let decoded = try WireCodec.decode(MessageAttachmentKind.self, from: #""video""#)
        XCTAssertEqual(decoded, .file)
    }

    func testMessageAttachmentAllFieldsRoundTrip() throws {
        let attachment = MessageAttachment(
            id: "a1", name: "big.bin", mimeType: "application/octet-stream", size: 999,
            kind: .file, data: nil, text: nil, path: "/vfs/big.bin", error: "too large")
        XCTAssertEqual(try WireCodec.roundTrip(attachment), attachment)
    }

    func testLickStateKnownValues() throws {
        for state in [LickState.pending, .confirmed, .dismissed] {
            XCTAssertEqual(try WireCodec.roundTrip(state), state)
        }
    }

    func testLickStateUnknownDegradesToPending() throws {
        let decoded = try WireCodec.decode(LickState.self, from: #""expired""#)
        XCTAssertEqual(decoded, .pending)
    }

    func testUsageAndCostRoundTrip() throws {
        let usage = ChatMessageUsage(
            input: 100, output: 200, cacheRead: 10, cacheWrite: 20,
            cost: ChatMessageCost(input: 1.5, output: 2.5, cacheRead: 0.5, cacheWrite: 0.25, total: 4.75))
        XCTAssertEqual(try WireCodec.roundTrip(usage), usage)
    }

    func testChatMessageDecodesFromLeaderJson() throws {
        let json = #"""
            {"id":"m1","role":"assistant","content":"done","timestamp":1700,"model":"claude-x","source":"cone"}
            """#
        let decoded = try WireCodec.decode(ChatMessage.self, from: json)
        XCTAssertEqual(decoded.id, "m1")
        XCTAssertEqual(decoded.role, .assistant)
        XCTAssertEqual(decoded.model, "claude-x")
        XCTAssertEqual(decoded.source, "cone")
    }
}
