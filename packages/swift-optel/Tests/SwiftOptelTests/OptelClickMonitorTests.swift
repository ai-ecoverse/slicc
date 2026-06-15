#if os(macOS)
import XCTest
@testable import SwiftOptel

/// Pure value-type fake mirroring ``OptelAccessibilityDeriver``'s test fake —
/// lets the decider be exercised without any AppKit state.
private final class FakeElement: OptelAccessibleElement {
    var optelAccessibilityRole: String?
    var optelAccessibilityIdentifier: String?
    var optelAccessibilityLabel: String?
    var optelAccessibilityWindowTitle: String?
    var optelAccessibilityParent: OptelAccessibleElement?

    init(
        role: String? = nil,
        identifier: String? = nil,
        label: String? = nil,
        windowTitle: String? = nil,
        parent: OptelAccessibleElement? = nil
    ) {
        self.optelAccessibilityRole = role
        self.optelAccessibilityIdentifier = identifier
        self.optelAccessibilityLabel = label
        self.optelAccessibilityWindowTitle = windowTitle
        self.optelAccessibilityParent = parent
    }
}

final class OptelClickMonitorTests: XCTestCase {
    // MARK: - OptelClickEmitDecider.decide

    func testNormalElementEmitsWithDerivedSourceAndTarget() {
        let window = FakeElement(windowTitle: "Main")
        let hit = FakeElement(role: "button", identifier: "buy", label: "Buy", parent: window)
        let decision = OptelClickEmitDecider.decide(for: hit)
        XCTAssertTrue(decision.shouldEmit)
        XCTAssertEqual(decision.source, "Main button#buy")
        XCTAssertEqual(decision.target, "Buy")
    }

    func testNilElementSkips() {
        let decision = OptelClickEmitDecider.decide(for: nil)
        XCTAssertFalse(decision.shouldEmit)
        XCTAssertNil(decision.source)
        XCTAssertNil(decision.target)
    }

    func testUndeterminableElementStillEmitsViewFallback() {
        // Hit-test found *something* but the element has no usable identity.
        // We still emit (clicks on bare views are meaningful as engagement
        // signals); the deriver supplies the `view` source fallback.
        let bare = FakeElement()
        let decision = OptelClickEmitDecider.decide(for: bare)
        XCTAssertTrue(decision.shouldEmit)
        XCTAssertEqual(decision.source, "view")
        XCTAssertNil(decision.target)
    }

    func testElementWithIgnoreMarkerIsSkipped() {
        let hit = FakeElement(
            role: "textField",
            identifier: OptelClickEmitDecider.ignoreIdentifier,
            label: "Password"
        )
        let decision = OptelClickEmitDecider.decide(for: hit)
        XCTAssertFalse(decision.shouldEmit)
        XCTAssertNil(decision.source)
        XCTAssertNil(decision.target)
    }

    func testAncestorWithIgnoreMarkerSkipsTheClick() {
        // Opt-out is inherited: marking a containing group as `optel-ignore`
        // suppresses click emission for every descendant.
        let container = FakeElement(
            role: "group",
            identifier: OptelClickEmitDecider.ignoreIdentifier
        )
        let hit = FakeElement(role: "button", identifier: "submit", parent: container)
        let decision = OptelClickEmitDecider.decide(for: hit)
        XCTAssertFalse(decision.shouldEmit)
    }

    func testWhitespacePaddedIgnoreIdentifierStillOptsOut() {
        let hit = FakeElement(
            role: "button",
            identifier: "  \(OptelClickEmitDecider.ignoreIdentifier)  "
        )
        let decision = OptelClickEmitDecider.decide(for: hit)
        XCTAssertFalse(decision.shouldEmit)
    }

    func testNonMatchingIdentifierDoesNotOptOut() {
        let hit = FakeElement(role: "button", identifier: "do-not-ignore-me")
        let decision = OptelClickEmitDecider.decide(for: hit)
        XCTAssertTrue(decision.shouldEmit)
        XCTAssertEqual(decision.source, "button#do-not-ignore-me")
    }

    func testIgnoreMarkerOnDeepAncestorIsHonored() {
        // Build a moderately deep chain with the marker on the outermost
        // ancestor; the decider should still walk up and find it.
        let outer = FakeElement(
            role: "window",
            identifier: OptelClickEmitDecider.ignoreIdentifier
        )
        var current: OptelAccessibleElement = outer
        for _ in 0..<8 {
            current = FakeElement(role: "AXGroup", parent: current)
        }
        let hit = FakeElement(role: "button", identifier: "go", parent: current)
        let decision = OptelClickEmitDecider.decide(for: hit)
        XCTAssertFalse(decision.shouldEmit)
    }

    func testSkipDecisionExposesAllNilFields() {
        let skip = OptelClickEmitDecider.skip
        XCTAssertFalse(skip.shouldEmit)
        XCTAssertNil(skip.source)
        XCTAssertNil(skip.target)
    }

    // MARK: - macOS monitor install/uninstall

    func testMonitorInstallIsIdempotent() {
        OptelClickMonitor._testing_reset()
        XCTAssertFalse(OptelClickMonitor.isInstalled)
        OptelClickMonitor.installIfNeeded()
        XCTAssertTrue(OptelClickMonitor.isInstalled)
        // Second call is a no-op; the monitor must not be retained twice.
        OptelClickMonitor.installIfNeeded()
        XCTAssertTrue(OptelClickMonitor.isInstalled)
        OptelClickMonitor.uninstall()
        XCTAssertFalse(OptelClickMonitor.isInstalled)
        // Uninstall when nothing is installed is also a no-op.
        OptelClickMonitor.uninstall()
        XCTAssertFalse(OptelClickMonitor.isInstalled)
    }

    // MARK: - Refined-vs-monitor dedupe (deferredEmit)

    /// Deterministic ``RandomSource`` for pinning sample selection in the
    /// dedupe regression tests below.
    private struct FixedRandom: RandomSource {
        let value: Double
        func nextUnitDouble() -> Double { value }
    }

    private func makeRecordingOptel() -> RecordingTransport {
        let transport = RecordingTransport()
        Optel.shared.configure(
            appID: "com.example.app",
            rate: "on",
            collectBaseURL: URL(string: "https://rum.hlx.page/")!,
            transport: transport,
            randomSource: FixedRandom(value: 0)
        )
        return transport
    }

    func testDeferredEmitFiresWhenNoRefinedClaim() {
        OptelClickCoordinator._testing_reset()
        let transport = makeRecordingOptel()
        let epoch = OptelClickCoordinator.beginMonitorEvent()
        // No refined claim: the monitor's deferred emission ships.
        OptelClickMonitor.deferredEmit(epoch: epoch, source: "Main button#go", target: "Go")
        let clicks = transport.sent.filter { $0.event.checkpoint.rawValue == "click" }
        XCTAssertEqual(clicks.count, 1)
        XCTAssertEqual(clicks.first?.event.pingData.source, "Main button#go")
        XCTAssertEqual(clicks.first?.event.pingData.target, "Go")
    }

    func testDeferredEmitIsSkippedWhenRefinedClaimsTheEpoch() {
        // Simulates a real user interaction: the global monitor schedules a
        // click for an in-flight event, a refined SwiftUI handler runs and
        // claims that event during synchronous dispatch, then the deferred
        // monitor block fires. Only the refined beacon must ship.
        OptelClickCoordinator._testing_reset()
        let transport = makeRecordingOptel()
        let epoch = OptelClickCoordinator.beginMonitorEvent()
        OptelClickCoordinator.claimByRefined()
        // Refined handler does its own `Optel.sample(.click, …)` separately;
        // here we emulate that explicit emit so the assertion exercises the
        // end-to-end "exactly one click on the wire" contract.
        Optel.sample(.click, source: "panel button#submit")
        OptelClickMonitor.deferredEmit(epoch: epoch, source: "ax-derived", target: "Submit")
        let clicks = transport.sent.filter { $0.event.checkpoint.rawValue == "click" }
        XCTAssertEqual(clicks.count, 1)
        XCTAssertEqual(clicks.first?.event.pingData.source, "panel button#submit")
    }

    func testDeferredEmitFiresForUnrelatedSubsequentEvent() {
        // After a refined claim absorbs one monitor event, the *next* monitor
        // event must still emit (its epoch is fresh and unclaimed). This is
        // the regression for "stale claim suppresses everything forever".
        OptelClickCoordinator._testing_reset()
        let transport = makeRecordingOptel()
        let firstEpoch = OptelClickCoordinator.beginMonitorEvent()
        OptelClickCoordinator.claimByRefined()
        OptelClickMonitor.deferredEmit(epoch: firstEpoch, source: "a", target: nil)
        let secondEpoch = OptelClickCoordinator.beginMonitorEvent()
        OptelClickMonitor.deferredEmit(epoch: secondEpoch, source: "b", target: nil)
        let clicks = transport.sent.filter { $0.event.checkpoint.rawValue == "click" }
        XCTAssertEqual(clicks.count, 1)
        XCTAssertEqual(clicks.first?.event.pingData.source, "b")
    }
}
#endif
