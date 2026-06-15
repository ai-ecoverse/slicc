#if canImport(SwiftUI)
import SwiftUI
import XCTest
@testable import SwiftOptel

@available(iOS 16.0, macOS 13.0, *)
final class OptelSwiftUITests: XCTestCase {
    // MARK: - Scene-phase transition logic

    /// Drives the documented `.background → .inactive → .active` sequence
    /// and asserts the modifier re-fires `enter` exactly once. This is the
    /// regression test for the `lastPhase`-based check that lost the
    /// was-background signal when `.inactive` arrived in between.
    func testEnterRefiresOnBackgroundInactiveActiveSequence() {
        var wasBackgrounded = false
        var enterFires = 0

        let phases: [ScenePhase] = [.background, .inactive, .active]
        for phase in phases {
            let next = OptelAutoInstrumentModifier.nextState(
                forNewPhase: phase,
                wasBackgrounded: wasBackgrounded
            )
            wasBackgrounded = next.wasBackgrounded
            if next.shouldFireEnter { enterFires += 1 }
        }
        XCTAssertEqual(enterFires, 1)
        XCTAssertFalse(wasBackgrounded, "active transition should clear the flag")
    }

    func testEnterDoesNotFireWithoutPriorBackground() {
        var wasBackgrounded = false
        var enterFires = 0
        // Cold launch path: SwiftUI may publish .inactive → .active before any
        // .background ever occurs. The modifier must NOT re-fire `enter` here
        // (the initial `enter` is fired from `.task`, not from `.onChange`).
        for phase in [ScenePhase.inactive, .active] {
            let next = OptelAutoInstrumentModifier.nextState(
                forNewPhase: phase,
                wasBackgrounded: wasBackgrounded
            )
            wasBackgrounded = next.wasBackgrounded
            if next.shouldFireEnter { enterFires += 1 }
        }
        XCTAssertEqual(enterFires, 0)
    }

    func testEnterFiresOncePerForegroundCycle() {
        var wasBackgrounded = false
        var enterFires = 0
        // Two full background→active cycles must fire `enter` twice (once per
        // cycle), and `.active → .active` must not re-fire.
        let sequence: [ScenePhase] = [
            .background, .inactive, .active,
            .active,
            .background, .inactive, .active,
        ]
        for phase in sequence {
            let next = OptelAutoInstrumentModifier.nextState(
                forNewPhase: phase,
                wasBackgrounded: wasBackgrounded
            )
            wasBackgrounded = next.wasBackgrounded
            if next.shouldFireEnter { enterFires += 1 }
        }
        XCTAssertEqual(enterFires, 2)
    }

    func testBackgroundSetsStickyFlagEvenAfterInactive() {
        // After `.background`, an arbitrary number of `.inactive` updates
        // must preserve the sticky flag until `.active` arrives.
        var wasBackgrounded = false
        for phase in [ScenePhase.background, .inactive, .inactive, .inactive] {
            let next = OptelAutoInstrumentModifier.nextState(
                forNewPhase: phase,
                wasBackgrounded: wasBackgrounded
            )
            wasBackgrounded = next.wasBackgrounded
            XCTAssertFalse(next.shouldFireEnter)
        }
        XCTAssertTrue(wasBackgrounded)
        let final = OptelAutoInstrumentModifier.nextState(
            forNewPhase: .active,
            wasBackgrounded: wasBackgrounded
        )
        XCTAssertTrue(final.shouldFireEnter)
        XCTAssertFalse(final.wasBackgrounded)
    }

    // MARK: - Unified install seam (performInstall)

    func testPerformInstallWithGlobalHooksInstallsUncaughtExceptionHook() {
        OptelUncaughtExceptionHook._testing_reset()
        XCTAssertFalse(OptelUncaughtExceptionHook.isInstalled)
        OptelAutoInstrumentModifier.performInstall(
            appID: "com.example.app",
            rate: "off",
            globalHooks: true
        )
        XCTAssertTrue(OptelUncaughtExceptionHook.isInstalled)
    }

    func testPerformInstallWithoutGlobalHooksSkipsUncaughtExceptionHook() {
        OptelUncaughtExceptionHook._testing_reset()
        XCTAssertFalse(OptelUncaughtExceptionHook.isInstalled)
        OptelAutoInstrumentModifier.performInstall(
            appID: "com.example.app",
            rate: "off",
            globalHooks: false
        )
        XCTAssertFalse(OptelUncaughtExceptionHook.isInstalled)
    }

    #if os(macOS)
    func testPerformInstallWithGlobalHooksInstallsMacHooks() {
        OptelMacAutoInstrument._testing_reset()
        XCTAssertFalse(OptelMacAutoInstrument.isInstalled)
        OptelAutoInstrumentModifier.performInstall(
            appID: "com.example.app",
            rate: "off",
            globalHooks: true
        )
        XCTAssertTrue(OptelMacAutoInstrument.isInstalled)
        OptelMacAutoInstrument.uninstall()
    }

    func testPerformInstallWithoutGlobalHooksSkipsMacHooks() {
        OptelMacAutoInstrument._testing_reset()
        XCTAssertFalse(OptelMacAutoInstrument.isInstalled)
        OptelAutoInstrumentModifier.performInstall(
            appID: "com.example.app",
            rate: "off",
            globalHooks: false
        )
        XCTAssertFalse(OptelMacAutoInstrument.isInstalled)
    }

    func testPerformInstallIsIdempotentForMacHooks() {
        // Remounting the root view must not double-install. Each underlying
        // hook's `installIfNeeded()` is itself a no-op on the second call,
        // and `OptelMacAutoInstrument.isInstalled` stays `true` throughout.
        OptelMacAutoInstrument._testing_reset()
        for _ in 0..<3 {
            OptelAutoInstrumentModifier.performInstall(
                appID: "com.example.app",
                rate: "off",
                globalHooks: true
            )
        }
        XCTAssertTrue(OptelMacAutoInstrument.isInstalled)
        XCTAssertTrue(OptelClickMonitor.isInstalled)
        XCTAssertTrue(OptelWindowObserver.isInstalled)
        OptelMacAutoInstrument.uninstall()
        XCTAssertFalse(OptelMacAutoInstrument.isInstalled)
    }

    func testMacAutoInstrumentCoordinatorInstallUninstall() {
        OptelMacAutoInstrument._testing_reset()
        XCTAssertFalse(OptelMacAutoInstrument.isInstalled)
        OptelMacAutoInstrument.installIfNeeded()
        XCTAssertTrue(OptelMacAutoInstrument.isInstalled)
        // Second call is a no-op — each underlying hook latches.
        OptelMacAutoInstrument.installIfNeeded()
        XCTAssertTrue(OptelMacAutoInstrument.isInstalled)
        OptelMacAutoInstrument.uninstall()
        XCTAssertFalse(OptelMacAutoInstrument.isInstalled)
        // Uninstall when nothing is installed is safe.
        OptelMacAutoInstrument.uninstall()
        XCTAssertFalse(OptelMacAutoInstrument.isInstalled)
    }
    #endif

    // MARK: - Refined controls coordinate with the global click monitor

    private struct FixedRandomSource: RandomSource {
        let value: Double
        func nextUnitDouble() -> Double { value }
    }

    private func configureRecordingOptel() -> RecordingTransport {
        let transport = RecordingTransport()
        Optel.shared.configure(
            appID: "com.example.app",
            rate: "on",
            collectBaseURL: URL(string: "https://rum.hlx.page/")!,
            transport: transport,
            randomSource: FixedRandomSource(value: 0)
        )
        return transport
    }

    func testOptelTapPerformTapClaimsAndEmits() {
        OptelClickCoordinator._testing_reset()
        let transport = configureRecordingOptel()
        // Monitor begins an event, refined `.optelTap` handler fires.
        let epoch = OptelClickCoordinator.beginMonitorEvent()
        OptelTapModifier.performTap(source: "panel view#detail")
        XCTAssertTrue(OptelClickCoordinator.wasClaimedByRefined(epoch: epoch))
        let clicks = transport.sent.filter { $0.event.checkpoint.rawValue == "click" }
        XCTAssertEqual(clicks.count, 1)
        XCTAssertEqual(clicks.first?.event.pingData.source, "panel view#detail")
    }

    func testOptelButtonPerformTapClaimsAndEmitsDerivedSource() {
        OptelClickCoordinator._testing_reset()
        let transport = configureRecordingOptel()
        let epoch = OptelClickCoordinator.beginMonitorEvent()
        OptelButton<Text>.performTap(
            identifier: "submit",
            label: "Submit",
            context: "checkout"
        )
        XCTAssertTrue(OptelClickCoordinator.wasClaimedByRefined(epoch: epoch))
        let clicks = transport.sent.filter { $0.event.checkpoint.rawValue == "click" }
        XCTAssertEqual(clicks.count, 1)
        // Source uses the standard `<context> <element>#<identifier>` shape.
        XCTAssertEqual(clicks.first?.event.pingData.source, "checkout button#submit")
    }

    #if os(macOS)
    func testRefinedTapAndMonitorTogetherProduceExactlyOneBeacon() {
        // End-to-end dedupe regression: a refined `.optelTap` fires *and* the
        // global monitor's deferred emit runs for the same event. Only the
        // refined beacon ships.
        OptelClickCoordinator._testing_reset()
        let transport = configureRecordingOptel()
        let epoch = OptelClickCoordinator.beginMonitorEvent()
        OptelTapModifier.performTap(source: "refined#go")
        // The deferred monitor block now fires (as it would after the run
        // loop has drained the synchronous event dispatch).
        OptelClickMonitor.deferredEmit(epoch: epoch, source: "ax#go", target: "Go")
        let clicks = transport.sent.filter { $0.event.checkpoint.rawValue == "click" }
        XCTAssertEqual(clicks.count, 1)
        XCTAssertEqual(clicks.first?.event.pingData.source, "refined#go")
    }

    func testRefinedButtonAndMonitorTogetherProduceExactlyOneBeacon() {
        OptelClickCoordinator._testing_reset()
        let transport = configureRecordingOptel()
        let epoch = OptelClickCoordinator.beginMonitorEvent()
        OptelButton<Text>.performTap(identifier: "buy", label: "Buy", context: "cart")
        OptelClickMonitor.deferredEmit(epoch: epoch, source: "ax#buy", target: "Buy")
        let clicks = transport.sent.filter { $0.event.checkpoint.rawValue == "click" }
        XCTAssertEqual(clicks.count, 1)
        XCTAssertEqual(clicks.first?.event.pingData.source, "cart button#buy")
    }

    func testUnrefinedClickStillEmitsViaMonitor() {
        // A bare control with no refined wrapper: the monitor's deferred
        // emission must still ship (one beacon, from the monitor).
        OptelClickCoordinator._testing_reset()
        let transport = configureRecordingOptel()
        let epoch = OptelClickCoordinator.beginMonitorEvent()
        // No refined claim happens for this event.
        OptelClickMonitor.deferredEmit(epoch: epoch, source: "ax#bare", target: "Bare")
        let clicks = transport.sent.filter { $0.event.checkpoint.rawValue == "click" }
        XCTAssertEqual(clicks.count, 1)
        XCTAssertEqual(clicks.first?.event.pingData.source, "ax#bare")
    }
    #endif
}
#endif
