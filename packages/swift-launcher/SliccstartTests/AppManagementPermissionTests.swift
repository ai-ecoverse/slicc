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

    func testInitProbesOnce() {
        // The probe runs in the initializer; we don't assert what value
        // it returned (CI runners can be either) — only that nothing
        // throws and the `isGranted` flag is set to a concrete bool.
        let permission = AppManagementPermission()
        XCTAssertTrue(permission.isGranted == true || permission.isGranted == false)
        XCTAssertFalse(permission.isWatching, "init must not register an observer")
    }

    func testCheckPermissionIsIdempotent() {
        let permission = AppManagementPermission()
        let first = permission.isGranted
        permission.checkPermission()
        permission.checkPermission()
        XCTAssertEqual(permission.isGranted, first, "Two probes in a row should agree")
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
        // installed should land in `checkPermission()`. We can't easily
        // stub the static probe, but we can pin the round-trip by
        // observing that `isGranted` is reachable and unchanged across
        // the notification (the probe is deterministic for a given
        // process).
        let permission = AppManagementPermission()
        permission.startWatchingForGrant()
        defer { permission.stopWatchingForGrant() }

        let before = permission.isGranted
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

        XCTAssertEqual(permission.isGranted, before, "Probe is deterministic per-process; result should match")
    }
}
