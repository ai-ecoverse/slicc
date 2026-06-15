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
}
#endif
