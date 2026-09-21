import Combine
import SliccTrayKit
import XCTest

@testable import SliccFollower

final class ThreadSummaryExcerptTests: XCTestCase {
    func testNothingToSummarizeWithoutSpokenRows() {
        XCTAssertNil(ThreadSummaryExcerpt.make(from: []))
        XCTAssertNil(ThreadSummaryExcerpt.make(from: [message("1", "   \n")]))
    }

    func testAStreamingTailIsNotSummarized() {
        let messages = [message("1", "done"), message("2", "half a", streaming: true)]
        XCTAssertNil(ThreadSummaryExcerpt.make(from: messages))
    }

    func testTheExcerptKeepsOnlyTheLastFewTurnsAttributed() throws {
        let messages = (1...10).map { message("\($0)", "turn \($0)", role: $0.isMultiple(of: 2) ? .assistant : .user) }
        let excerpt = try XCTUnwrap(ThreadSummaryExcerpt.make(from: messages))
        XCTAssertFalse(excerpt.text.contains("turn 4"))
        XCTAssertTrue(excerpt.text.hasPrefix("User: turn 5"))
        XCTAssertTrue(excerpt.text.hasSuffix("Assistant: turn 10"))
    }

    func testTheKeyMovesWithTheTailRowAndItsLength() throws {
        let first = try XCTUnwrap(ThreadSummaryExcerpt.make(from: [message("1", "a")]))
        let edited = try XCTUnwrap(ThreadSummaryExcerpt.make(from: [message("1", "ab")]))
        let next = try XCTUnwrap(ThreadSummaryExcerpt.make(from: [message("1", "a"), message("2", "b")]))
        XCTAssertNotEqual(first.key, edited.key)
        XCTAssertNotEqual(first.key, next.key)
    }

    func testThePreviewIsTheNewestFirstLineWithoutMarkdown() {
        let messages = [message("1", "older"), message("2", "## **Fixed** the `build`\nmore")]
        XCTAssertEqual(ThreadSummaryExcerpt.preview(from: messages), "Fixed the build")
    }

    func testAModelLineIsTidiedToOneClippedLine() {
        XCTAssertEqual(ThreadSummaryExcerpt.tidy("\"Debugging the iOS composer.\"\nextra"), "Debugging the iOS composer")
        XCTAssertNil(ThreadSummaryExcerpt.tidy("  \n"))
        let long = String(repeating: "x", count: 200)
        XCTAssertEqual(ThreadSummaryExcerpt.tidy(long)?.count, ThreadSummaryExcerpt.previewLength)
    }
}

@MainActor
final class ThreadSummaryStoreTests: XCTestCase {
    func testWithoutAModelRowsShowThePreview() {
        let store = ThreadSummaryStore(generator: nil)
        store.refresh(buffers: ["a": [message("1", "hello there")]])
        XCTAssertEqual(store.lines["a"], "hello there")
    }

    func testTheModelLineReplacesThePreviewAndAnUnchangedTailIsNotResummarized() async {
        let model = ScriptedSummarizer()
        let store = ThreadSummaryStore(generator: model)
        let buffers = ["a": [message("1", "hello there")]]
        store.refresh(buffers: buffers)
        XCTAssertEqual(store.lines["a"], "hello there")
        await store.waitUntilIdle()
        XCTAssertEqual(store.lines["a"], "summary 1")

        store.refresh(buffers: buffers)
        await store.waitUntilIdle()
        let calls = await model.calls
        XCTAssertEqual(calls, 1)
    }

    func testAModelLineStaysUpWhileTheNextOneIsMade() async {
        let model = ScriptedSummarizer()
        let store = ThreadSummaryStore(generator: model)
        store.refresh(buffers: ["a": [message("1", "one")]])
        await store.waitUntilIdle()
        store.refresh(buffers: ["a": [message("1", "one"), message("2", "two")]])
        XCTAssertEqual(store.lines["a"], "summary 1")
        await store.waitUntilIdle()
        XCTAssertEqual(store.lines["a"], "summary 2")
    }

    func testAResetThreadDropsItsLineAndItsQueuedJob() async {
        let model = ScriptedSummarizer()
        let store = ThreadSummaryStore(generator: model)
        store.refresh(buffers: ["a": [message("1", "old conversation")]])
        // New Session: the same unit comes back empty before the model ran.
        store.refresh(buffers: ["a": []])
        XCTAssertNil(store.lines["a"])
        await store.waitUntilIdle()
        XCTAssertNil(store.lines["a"], "a job queued for the old conversation must not publish")
    }

    func testAStreamingTailKeepsTheLineItHas() {
        let store = ThreadSummaryStore(generator: nil)
        store.refresh(buffers: ["a": [message("1", "settled")]])
        store.refresh(buffers: ["a": [message("1", "settled"), message("2", "half", streaming: true)]])
        XCTAssertEqual(store.lines["a"], "settled")
    }

    func testSuspendingStopsTheWorkAndTheNextRefreshResumesIt() async {
        let model = ScriptedSummarizer(delay: .seconds(5))
        let store = ThreadSummaryStore(generator: model)
        let buffers = ["a": [message("1", "one")], "b": [message("1", "two")]]
        store.refresh(buffers: buffers)
        store.suspend()
        XCTAssertEqual(store.pendingJobs, 0)
        await store.waitUntilIdle()
        XCTAssertEqual(store.lines["a"], "one", "the preview stays; no model line lands off screen")
        XCTAssertEqual(store.lines["b"], "two")

        store.refresh(buffers: buffers)
        XCTAssertEqual(store.pendingJobs, 2, "forgotten work is queued again when the list returns")
        store.suspend()
    }

    func testTheHostStaysQuietWhenALineArrives() async {
        let model = ScriptedSummarizer()
        let host = ThreadSummaryHost(store: ThreadSummaryStore(generator: model))
        var publishes = 0
        let subscription = host.objectWillChange.sink { publishes += 1 }
        host.store.refresh(buffers: ["a": [message("1", "hello there")]])
        await host.store.waitUntilIdle()
        XCTAssertEqual(host.store.lines["a"], "summary 1")
        XCTAssertEqual(publishes, 0, "a summary must not redraw the shell that owns the host")
        subscription.cancel()
    }

    func testAGoneUnitLosesItsLine() {
        let store = ThreadSummaryStore(generator: nil)
        store.refresh(buffers: ["a": [message("1", "x")]])
        store.refresh(buffers: [:])
        XCTAssertNil(store.lines["a"])
    }
}

private actor ScriptedSummarizer: ThreadSummaryGenerating {
    private(set) var calls = 0
    private let delay: Duration?

    init(delay: Duration? = nil) { self.delay = delay }

    func summarize(_ excerpt: String) async -> String? {
        calls += 1
        if let delay { try? await Task.sleep(for: delay) }
        return "summary \(calls)"
    }
}

private func message(
    _ id: String, _ content: String, role: MessageRole = .assistant, streaming: Bool = false
) -> ChatMessage {
    ChatMessage(
        id: id, role: role, content: content, timestamp: 1000, isStreaming: streaming ? true : nil)
}
