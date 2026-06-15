import XCTest
@testable import SwiftOptel

/// Deterministic ``RandomSource`` for sampling-session construction.
private struct FixedRandomSource: RandomSource {
    let value: Double
    func nextUnitDouble() -> Double { value }
}

final class OptelCollectorTests: XCTestCase {
    private let baseURL = URL(string: "https://rum.hlx.page/")!

    private func event(_ checkpoint: RUMCheckpoint, t: Int = 0) -> RUMEvent {
        RUMEvent(
            weight: 100,
            id: "abc123def",
            referer: "https://com.example.app/",
            checkpoint: checkpoint,
            t: t
        )
    }

    private func session(selected: Bool, weight: Int = 100) -> SamplingSession {
        // weight=1 + random=0 → selected (0 * 1 < 1).
        // weight=100 + random=0.99 → not selected (0.99 * 100 = 99 ≥ 1).
        let random = FixedRandomSource(value: selected ? 0 : 0.99)
        let config = SamplingConfig(weight: selected ? 1 : weight)
        return SamplingSession(id: "abc123def", config: config, random: random)
    }

    func testEventsAreBufferedUntilSessionAttached() {
        let mock = RecordingTransport()
        let collector = OptelCollector(transport: mock, collectBaseURL: baseURL)
        collector.enqueue(event(.top))
        collector.enqueue(event(.enter))
        XCTAssertEqual(mock.sent.count, 0)
        XCTAssertEqual(collector.bufferedCount, 2)
    }

    func testFlushesBufferedEventsWhenSelectedSessionAttaches() {
        let mock = RecordingTransport()
        let collector = OptelCollector(transport: mock, collectBaseURL: baseURL)
        collector.enqueue(event(.top))
        collector.enqueue(event(.enter))
        collector.attach(session: session(selected: true))
        XCTAssertEqual(mock.sent.count, 2)
        XCTAssertEqual(mock.sent.map { $0.event.checkpoint.rawValue }, ["top", "enter"])
        XCTAssertEqual(collector.bufferedCount, 0)
    }

    func testDropsBufferedEventsWhenUnselectedSessionAttaches() {
        let mock = RecordingTransport()
        let collector = OptelCollector(transport: mock, collectBaseURL: baseURL)
        collector.enqueue(event(.top))
        collector.enqueue(event(.enter))
        collector.attach(session: session(selected: false))
        XCTAssertEqual(mock.sent.count, 0)
        XCTAssertEqual(collector.bufferedCount, 0)
    }

    func testForwardsEventsImmediatelyAfterSelectedSessionAttached() {
        let mock = RecordingTransport()
        let collector = OptelCollector(transport: mock, collectBaseURL: baseURL)
        collector.attach(session: session(selected: true))
        collector.enqueue(event(.click))
        XCTAssertEqual(mock.sent.count, 1)
        XCTAssertEqual(mock.sent.first?.event.checkpoint.rawValue, "click")
        XCTAssertEqual(mock.sent.first?.baseURL, baseURL)
    }

    func testDropsEventsAfterUnselectedSessionAttached() {
        let mock = RecordingTransport()
        let collector = OptelCollector(transport: mock, collectBaseURL: baseURL)
        collector.attach(session: session(selected: false))
        collector.enqueue(event(.click))
        collector.enqueue(event(.navigate))
        XCTAssertEqual(mock.sent.count, 0)
        XCTAssertEqual(collector.bufferedCount, 0)
    }

    func testAttachIsIdempotent() {
        let mock = RecordingTransport()
        let collector = OptelCollector(transport: mock, collectBaseURL: baseURL)
        collector.enqueue(event(.top))
        collector.attach(session: session(selected: true))
        XCTAssertEqual(mock.sent.count, 1)
        // Second attach (even with a different decision) must be a no-op.
        collector.attach(session: session(selected: false))
        collector.enqueue(event(.enter))
        XCTAssertEqual(mock.sent.count, 2)
        XCTAssertEqual(mock.sent.last?.event.checkpoint.rawValue, "enter")
    }

    func testQueueLimitDropsOldestWhileBuffered() {
        let mock = RecordingTransport()
        let collector = OptelCollector(
            transport: mock,
            collectBaseURL: baseURL,
            queueLimit: 2
        )
        collector.enqueue(event(.top, t: 1))
        collector.enqueue(event(.enter, t: 2))
        collector.enqueue(event(.click, t: 3))
        XCTAssertEqual(collector.bufferedCount, 2)
        collector.attach(session: session(selected: true))
        XCTAssertEqual(mock.sent.map { $0.event.t }, [2, 3])
    }

    func testDefaultBaseURLMatchesRumHlxPage() {
        let mock = RecordingTransport()
        let collector = OptelCollector(transport: mock)
        collector.attach(session: session(selected: true))
        collector.enqueue(event(.top))
        XCTAssertEqual(mock.sent.first?.baseURL.absoluteString, "https://rum.hlx.page/")
    }

    func testHasSessionReflectsAttachState() {
        let mock = RecordingTransport()
        let collector = OptelCollector(transport: mock, collectBaseURL: baseURL)
        XCTAssertFalse(collector.hasSession)
        collector.attach(session: session(selected: false))
        XCTAssertTrue(collector.hasSession)
    }
}
