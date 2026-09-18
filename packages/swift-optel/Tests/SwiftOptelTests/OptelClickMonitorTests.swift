#if os(macOS)
    import XCTest
    @testable import SwiftOptel

    
    
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

        

        func testMonitorInstallIsIdempotent() {
            OptelClickMonitor._testing_reset()
            XCTAssertFalse(OptelClickMonitor.isInstalled)
            OptelClickMonitor.installIfNeeded()
            XCTAssertTrue(OptelClickMonitor.isInstalled)
            
            OptelClickMonitor.installIfNeeded()
            XCTAssertTrue(OptelClickMonitor.isInstalled)
            OptelClickMonitor.uninstall()
            XCTAssertFalse(OptelClickMonitor.isInstalled)
            
            OptelClickMonitor.uninstall()
            XCTAssertFalse(OptelClickMonitor.isInstalled)
        }

        

        
        
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
            
            OptelClickMonitor.deferredEmit(epoch: epoch, source: "Main button#go", target: "Go")
            let clicks = transport.sent.filter { $0.event.checkpoint.rawValue == "click" }
            XCTAssertEqual(clicks.count, 1)
            XCTAssertEqual(clicks.first?.event.pingData.source, "Main button#go")
            XCTAssertEqual(clicks.first?.event.pingData.target, "Go")
        }

        func testDeferredEmitIsSkippedWhenRefinedClaimsTheEpoch() {
            
            
            
            
            OptelClickCoordinator._testing_reset()
            let transport = makeRecordingOptel()
            let epoch = OptelClickCoordinator.beginMonitorEvent()
            OptelClickCoordinator.claimByRefined()
            
            
            
            Optel.sample(.click, source: "panel button#submit")
            OptelClickMonitor.deferredEmit(epoch: epoch, source: "ax-derived", target: "Submit")
            let clicks = transport.sent.filter { $0.event.checkpoint.rawValue == "click" }
            XCTAssertEqual(clicks.count, 1)
            XCTAssertEqual(clicks.first?.event.pingData.source, "panel button#submit")
        }

        func testDeferredEmitFiresForUnrelatedSubsequentEvent() {
            
            
            
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
