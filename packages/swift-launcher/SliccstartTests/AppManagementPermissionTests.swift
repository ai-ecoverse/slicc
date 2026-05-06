import AppKit
import XCTest
@testable import Sliccstart

/// Pins the focus-driven re-probe behavior of `AppManagementPermission`.
///
/// History: this class used to schedule a `Timer` firing every 2 s that
/// called `probeAppManagementAccess()`, which writes a temp file inside
/// a user app bundle to test the App Management entitlement. On macOS
/// Sonoma+ each denied write posts a "Sliccstart was prevented from
/// modifying apps on your Mac" Notification Center alert, so the timer
/// turned that into a continuous spam loop on machines that hadn't
/// granted the permission. The replacement re-probes on
/// `NSApplication.didBecomeActiveNotification` instead — fires at most
/// once per app switch, which is when the answer can actually change.
///
/// These tests pin the new contract so a future refactor that re-adds
/// a timer (or drops the activation observer) breaks loudly.
final class AppManagementPermissionTests: XCTestCase {

    func testInitProbesExactlyOnce() {
        // Pins the launch-time alert budget: `init()` runs the probe
        // once, registers no observer, and `startWatchingForGrant()`
        // (called next from `.onAppear`) must NOT add a second probe.
        // Each probe is one potential Sonoma+ "prevented from
        // modifying" alert — keeping `probeCount == 1` after
        // `start...()` keeps the launch budget at one alert.
        let permission = AppManagementPermission()
        XCTAssertEqual(permission.probeCount, 1, "init should probe exactly once")
        XCTAssertFalse(permission.isWatching, "init must not register an observer")

        permission.startWatchingForGrant()
        defer { permission.stopWatchingForGrant() }
        XCTAssertEqual(
            permission.probeCount, 1,
            "startWatchingForGrant() must not add a second probe — init already did it"
        )
        XCTAssertTrue(permission.isWatching)
    }

    func testCheckPermissionIsIdempotent() {
        let permission = AppManagementPermission()
        let first = permission.isGranted
        let initialCount = permission.probeCount
        permission.checkPermission()
        permission.checkPermission()
        XCTAssertEqual(permission.isGranted, first, "Two probes in a row should agree")
        XCTAssertEqual(permission.probeCount, initialCount + 2)
    }

    func testStartWatchingDoesNotRetainATimer() {
        // Regression guard: an earlier implementation kept a
        // `Timer.scheduledTimer(...)` alive in `checkTimer`. Mirror
        // reflection sees stored values regardless of `@Observable`'s
        // label rewriting, so a refactor that re-adds *any* Timer
        // anywhere on the instance fails here instead of in the wild.
        let permission = AppManagementPermission()
        permission.startWatchingForGrant()
        defer { permission.stopWatchingForGrant() }

        let storedTimer = Mirror(reflecting: permission)
            .children
            .first(where: { ($0.value as? Timer) != nil })
        XCTAssertNil(storedTimer, "AppManagementPermission must not hold a Timer")
    }

    func testStartWatchingRegistersObserver() {
        let permission = AppManagementPermission()
        XCTAssertFalse(permission.isWatching)
        permission.startWatchingForGrant()
        defer { permission.stopWatchingForGrant() }
        XCTAssertTrue(permission.isWatching)
    }

    func testStopWatchingClearsObserver() {
        let permission = AppManagementPermission()
        permission.startWatchingForGrant()
        permission.stopWatchingForGrant()
        XCTAssertFalse(permission.isWatching, "stopWatchingForGrant() should drop the observer")
    }

    func testStartWatchingIsIdempotent() {
        // Calling start twice (e.g. window reappearing after sheet
        // dismiss) must not stack observers — which would cause N
        // probes per activation. After a single stop the slot must
        // be empty.
        let permission = AppManagementPermission()
        permission.startWatchingForGrant()
        permission.startWatchingForGrant()
        XCTAssertTrue(permission.isWatching)
        permission.stopWatchingForGrant()
        XCTAssertFalse(permission.isWatching, "start→start→stop should leave no observer behind")
    }

    func testActivationNotificationRetriggersProbe() {
        // End-to-end: posting `didBecomeActive` while the observer is
        // installed must land in `checkPermission()`. `probeCount`
        // makes that observable — without it, the test would also pass
        // if the handler never fired (since `isGranted` is deterministic
        // per process).
        let permission = AppManagementPermission()
        permission.startWatchingForGrant()
        defer { permission.stopWatchingForGrant() }

        let beforeCount = permission.probeCount
        let beforeGranted = permission.isGranted

        NotificationCenter.default.post(
            name: NSApplication.didBecomeActiveNotification,
            object: nil
        )
        // `addObserver(forName:queue:)` with `.main` may dispatch async
        // when called off the main thread; pump the runloop briefly so
        // the handler lands before we read the value.
        let expectation = XCTestExpectation(description: "main queue drain")
        DispatchQueue.main.async { expectation.fulfill() }
        wait(for: [expectation], timeout: 1.0)

        XCTAssertEqual(
            permission.probeCount, beforeCount + 1,
            "didBecomeActive must trigger exactly one re-probe"
        )
        XCTAssertEqual(
            permission.isGranted, beforeGranted,
            "Probe is deterministic per-process; the value should not flip"
        )
    }

    func testMultipleActivationsTriggerOneProbeEach() {
        // Pins that the handler stays attached across multiple firings —
        // i.e. it's not a one-shot. Three activations → three probes.
        let permission = AppManagementPermission()
        permission.startWatchingForGrant()
        defer { permission.stopWatchingForGrant() }

        let beforeCount = permission.probeCount
        for _ in 0..<3 {
            NotificationCenter.default.post(
                name: NSApplication.didBecomeActiveNotification,
                object: nil
            )
        }
        let expectation = XCTestExpectation(description: "main queue drain")
        DispatchQueue.main.async { expectation.fulfill() }
        wait(for: [expectation], timeout: 1.0)

        XCTAssertEqual(permission.probeCount, beforeCount + 3)
    }
}
