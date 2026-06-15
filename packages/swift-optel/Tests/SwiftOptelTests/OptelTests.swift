import XCTest
@testable import SwiftOptel

/// Deterministic ``RandomSource`` for pinning the per-session selection
/// decision in tests.
private struct FixedRandomSource: RandomSource {
    let value: Double
    func nextUnitDouble() -> Double { value }
}

final class OptelTests: XCTestCase {
    private let baseURL = URL(string: "https://rum.hlx.page/")!

    private func makeOptel(
        appID: String = "com.example.app",
        rate: String? = nil,
        transport: OptelTransport,
        selected: Bool = true
    ) -> Optel {
        let optel = Optel()
        // weight=1 + random=0 → selected; weight=100 + random=0.99 → not selected
        let random = FixedRandomSource(value: selected ? 0 : 0.99)
        optel.configure(
            appID: appID,
            rate: rate ?? (selected ? "on" : nil),
            collectBaseURL: baseURL,
            transport: transport,
            randomSource: random
        )
        return optel
    }

    func testConfigureThenSampleProducesOneBeaconForTopWhenSelected() {
        let mock = RecordingTransport()
        let optel = makeOptel(transport: mock, selected: true)
        optel.sample(.top, source: "app", target: "/", value: 1)
        XCTAssertEqual(mock.sent.count, 1)
        let call = mock.sent[0]
        XCTAssertEqual(call.event.checkpoint.rawValue, "top")
        XCTAssertEqual(call.event.referer, "https://com.example.app/")
        XCTAssertEqual(call.event.pingData.source, "app")
        XCTAssertEqual(call.event.pingData.target, "/")
        XCTAssertEqual(call.event.pingData.value, 1)
        XCTAssertEqual(call.baseURL, baseURL)
    }

    func testFirstSampleAutoEmitsTopBeforeUserCheckpoint() {
        let mock = RecordingTransport()
        let optel = makeOptel(transport: mock, selected: true)
        optel.sample(.click, source: ".button#submit")
        XCTAssertEqual(mock.sent.map { $0.event.checkpoint.rawValue }, ["top", "click"])
        XCTAssertEqual(mock.sent[0].event.t, 0)
        XCTAssertNil(mock.sent[0].event.pingData.source)
        XCTAssertEqual(mock.sent[1].event.pingData.source, ".button#submit")
    }

    func testSubsequentSamplesDoNotReEmitTop() {
        let mock = RecordingTransport()
        let optel = makeOptel(transport: mock, selected: true)
        optel.sample(.enter)
        optel.sample(.click)
        optel.sample(.navigate)
        XCTAssertEqual(
            mock.sent.map { $0.event.checkpoint.rawValue },
            ["top", "enter", "click", "navigate"]
        )
    }

    func testUnselectedSessionProducesZeroBeacons() {
        let mock = RecordingTransport()
        let optel = makeOptel(transport: mock, selected: false)
        optel.sample(.click)
        optel.sample(.navigate)
        XCTAssertEqual(mock.sent.count, 0)
    }

    func testEventCarriesSessionWeightAndStableID() {
        let mock = RecordingTransport()
        let optel = makeOptel(rate: "on", transport: mock, selected: true)
        optel.sample(.click)
        XCTAssertEqual(mock.sent.count, 2)
        let first = mock.sent[0].event
        let second = mock.sent[1].event
        XCTAssertEqual(first.weight, 1)
        XCTAssertEqual(second.weight, 1)
        XCTAssertEqual(first.id.count, 9)
        XCTAssertEqual(first.id, second.id)
    }

    func testRefererUsesAppIDAsHostname() {
        let mock = RecordingTransport()
        let optel = makeOptel(appID: "io.acme.client", transport: mock, selected: true)
        optel.sample(.click)
        XCTAssertEqual(mock.sent.first?.event.referer, "https://io.acme.client/")
    }

    func testReconfigureResetsTopAndSessionID() {
        let mock = RecordingTransport()
        let optel = makeOptel(transport: mock, selected: true)
        optel.sample(.click)
        XCTAssertEqual(mock.sent.count, 2)
        let firstID = mock.sent[0].event.id

        optel.configure(
            appID: "com.example.app",
            rate: "on",
            collectBaseURL: baseURL,
            transport: mock,
            randomSource: FixedRandomSource(value: 0)
        )
        optel.sample(.click)
        XCTAssertEqual(mock.sent.count, 4)
        XCTAssertEqual(mock.sent[2].event.checkpoint.rawValue, "top")
        XCTAssertEqual(mock.sent[3].event.checkpoint.rawValue, "click")
        XCTAssertNotEqual(mock.sent[2].event.id, firstID)
    }

    func testSampleBeforeConfigureIsNoOp() {
        let optel = Optel()
        // No configure call. Sample must not crash and must not emit.
        optel.sample(.click, source: "x")
        // No transport to inspect; success is "no crash".
    }

    func testTimeShiftIsNonNegativeForUserCheckpoint() {
        let mock = RecordingTransport()
        let optel = makeOptel(transport: mock, selected: true)
        optel.sample(.enter)
        XCTAssertGreaterThanOrEqual(mock.sent.last?.event.t ?? -1, 0)
    }

    func testConcurrentSamplesAreThreadSafe() {
        let mock = RecordingTransport()
        let optel = makeOptel(transport: mock, selected: true)
        let group = DispatchGroup()
        let queue = DispatchQueue(label: "optel.test", attributes: .concurrent)
        for _ in 0..<200 {
            group.enter()
            queue.async {
                optel.sample(.click)
                group.leave()
            }
        }
        group.wait()
        let tops = mock.sent.filter { $0.event.checkpoint.rawValue == "top" }
        XCTAssertEqual(tops.count, 1)
        XCTAssertEqual(mock.sent.count, 201)
    }

    func testTopBeaconIsFirstOnTheWireUnderConcurrentFirstCallers() {
        // Race many threads through `sample` immediately after `configure`,
        // synchronized on a `DispatchSemaphore` so they all unblock together.
        // The auto-`top` beacon must be the very first entry on the wire even
        // though the caller that flipped `hasEmittedTop` is not guaranteed to
        // be scheduled before the others.
        for trial in 0..<20 {
            let mock = RecordingTransport()
            let optel = makeOptel(transport: mock, selected: true)
            let threadCount = 32
            let startGate = DispatchSemaphore(value: 0)
            let group = DispatchGroup()
            let queue = DispatchQueue(label: "optel.race", attributes: .concurrent)
            for _ in 0..<threadCount {
                group.enter()
                queue.async {
                    startGate.wait()
                    optel.sample(.click)
                    group.leave()
                }
            }
            for _ in 0..<threadCount { startGate.signal() }
            group.wait()
            XCTAssertEqual(
                mock.sent.first?.event.checkpoint.rawValue,
                "top",
                "trial \(trial): top must be the first beacon on the wire"
            )
            let tops = mock.sent.filter { $0.event.checkpoint.rawValue == "top" }
            XCTAssertEqual(tops.count, 1, "trial \(trial): expected exactly one top beacon")
            XCTAssertEqual(
                mock.sent.count,
                threadCount + 1,
                "trial \(trial): expected one top + \(threadCount) clicks"
            )
        }
    }
}
