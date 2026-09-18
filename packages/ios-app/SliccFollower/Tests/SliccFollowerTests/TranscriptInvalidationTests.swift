import SliccTrayKit
import SwiftUI
import XCTest

@testable import SliccFollower








@MainActor
final class TranscriptInvalidationTests: XCTestCase {

    

    func testParsingTheSameBodyTwiceOnlyParsesOnce() {
        MarkdownBlockParser.resetParseCountForTesting()
        let body = "# Heading\n\nSome **bold** text.\n\n- one\n- two\n"

        let first = MarkdownBlockParser.parse(body)
        XCTAssertEqual(MarkdownBlockParser.parseCount, 1, "the first parse is a miss")

        let second = MarkdownBlockParser.parse(body)
        XCTAssertEqual(
            MarkdownBlockParser.parseCount, 1,
            "re-parsing an unchanged body must be a cache hit — `MarkdownText.blocks` is a "
                + "computed property and runs on every body evaluation")
        XCTAssertEqual(first.count, second.count, "a cache hit must return the same blocks")
    }

    func testDifferentBodiesEachParseOnce() {
        MarkdownBlockParser.resetParseCountForTesting()
        _ = MarkdownBlockParser.parse("first body")
        _ = MarkdownBlockParser.parse("second body")
        _ = MarkdownBlockParser.parse("first body")
        XCTAssertEqual(
            MarkdownBlockParser.parseCount, 2,
            "two distinct bodies parse twice; the repeat is a hit")
    }

    func testAGrowingStreamingBodyStillReparses() {
        MarkdownBlockParser.resetParseCountForTesting()
        _ = MarkdownBlockParser.parse("Great, running")
        _ = MarkdownBlockParser.parse("Great, running the")
        _ = MarkdownBlockParser.parse("Great, running the coverage")
        XCTAssertEqual(
            MarkdownBlockParser.parseCount, 3,
            "each streamed token is genuinely new content and MUST re-parse — the cache "
                + "must not serve a stale prefix")
    }

    

    
    
    func testAnUnchangedRowComparesEqual() {
        let message = Self.message(id: "m1", content: "hello")
        XCTAssertEqual(
            MessageBubble(message: message),
            MessageBubble(message: message),
            "an unchanged row must compare equal or SwiftUI re-renders it every pass")
    }

    func testAChangedBodyComparesUnequal() {
        XCTAssertNotEqual(
            MessageBubble(message: Self.message(id: "m1", content: "hello")),
            MessageBubble(message: Self.message(id: "m1", content: "hello there")),
            "a streamed token must still invalidate its own row")
    }

    
    
    
    func testProgressOnAnotherMessagesToolDoesNotChangeThisRow() {
        let message = Self.message(id: "m1", content: "hello")
        let unrelated = ["other-tool": Self.progress(id: "other-tool", fraction: 0.5)]

        
        
        let sliced = Self.list(messages: [message], toolProgress: unrelated)
            .progressSliceForTesting(message)
        XCTAssertTrue(
            sliced.isEmpty,
            "a message with no tool calls must receive an empty slice, not the whole dictionary")

        XCTAssertEqual(
            MessageBubble(message: message, toolProgress: sliced),
            MessageBubble(message: message, toolProgress: [:]),
            "an unrelated tool tick must not change this row's value")
    }

    func testProgressOnThisMessagesOwnToolDoesReachIt() {
        let call = ToolCall(id: "bash-1", name: "bash", input: nil)
        let message = Self.message(id: "m1", content: "running", toolCalls: [call])
        let progress = ["bash-1": Self.progress(id: "bash-1", fraction: 0.5)]

        let sliced = Self.list(messages: [message], toolProgress: progress)
            .progressSliceForTesting(message)
        XCTAssertEqual(
            Array(sliced.keys), ["bash-1"],
            "a message's own tool progress must reach it")
        XCTAssertNotEqual(
            MessageBubble(message: message, toolProgress: sliced),
            MessageBubble(message: message, toolProgress: [:]),
            "its own tool's progress must invalidate the row")
    }

    

    
    
    func testTimestampFormattersAreSharedAndStillCorrect() throws {
        let calendar = Calendar.current
        let now = Date()
        XCTAssertTrue(
            MessageListView.timestampLabel(for: now, calendar: calendar).hasPrefix("Today "),
            "today's messages keep the Today prefix")

        let yesterday = try XCTUnwrap(calendar.date(byAdding: .day, value: -1, to: now))
        XCTAssertTrue(
            MessageListView.timestampLabel(for: yesterday, calendar: calendar)
                .hasPrefix("Yesterday "),
            "yesterday's messages keep the Yesterday prefix")

        
        
        
        
        let longAgo = try XCTUnwrap(calendar.date(byAdding: .day, value: -30, to: now))
        _ = MessageListView.timestampLabel(for: longAgo, calendar: calendar)
        XCTAssertTrue(
            MessageListView.timestampLabel(for: now, calendar: calendar).hasPrefix("Today "),
            "formatting an older message must not leak its date style into later labels")
    }

    

    
    
    
    
    private static func list(
        messages: [ChatMessage], toolProgress: [String: ToolProgressEvent]
    ) -> MessageListView {
        MessageListView(
            messages: messages,
            isStreaming: false,
            toolProgress: toolProgress)
    }

    private static func message(
        id: String, content: String, toolCalls: [ToolCall]? = nil
    ) -> ChatMessage {
        ChatMessage(
            id: id, role: .assistant, content: content, timestamp: 1_756_000_000_000,
            toolCalls: toolCalls)
    }

    private static func progress(id: String, fraction: Double) -> ToolProgressEvent {
        ToolProgressEvent(id: id, label: "bash", fraction: fraction)
    }
}
