import AppKit
import XCTest

@testable import Sliccstart

final class AppManagementPermissionTests: XCTestCase {

    func testInitProbesExactlyOnce() {

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

        let permission = AppManagementPermission()
        permission.startWatchingForGrant()
        permission.startWatchingForGrant()
        XCTAssertTrue(permission.isWatching)
        permission.stopWatchingForGrant()
        XCTAssertFalse(permission.isWatching, "start→start→stop should leave no observer behind")
    }

    func testActivationNotificationRetriggersProbe() {

        let permission = AppManagementPermission()
        permission.startWatchingForGrant()
        defer { permission.stopWatchingForGrant() }

        let beforeCount = permission.probeCount
        let beforeGranted = permission.isGranted

        NotificationCenter.default.post(
            name: NSApplication.didBecomeActiveNotification,
            object: nil
        )

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
