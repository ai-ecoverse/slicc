import SliccTraySession
import XCTest

@testable import SliccFollower

final class ICloudSessionListTests: XCTestCase {
    // MARK: - Grouping

    func testGroupsKeyOnDeviceIdAndKeepNewestFirstDeviceOrder() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        // Store order is newest-first; the Studio session is newest overall.
        let sessions = [
            makeSession(joinUrl: "https://t.test/join/s1.secret", label: "Chrome on Studio", deviceId: "studio", deviceName: "MacBook Pro", lastSeenAt: now),
            makeSession(
                joinUrl: "https://t.test/join/m1.secret", label: "Chrome on Book", deviceId: "book", deviceName: "MacBook Pro",
                lastSeenAt: now.addingTimeInterval(-60)),
            makeSession(
                joinUrl: "https://t.test/join/m2.secret", label: "Edge on Book", deviceId: "book", deviceName: "MacBook Pro",
                lastSeenAt: now.addingTimeInterval(-120)),
        ]

        let groups = ICloudSessionList.groups(from: sessions)

        XCTAssertEqual(groups.map(\.deviceId), ["studio", "book"])
        // Same host name on both Macs must NOT merge the groups.
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(groups[1].sessions.map(\.label), ["Chrome on Book", "Edge on Book"])
    }

    func testGroupsFallBackToPlaceholderForEmptyDeviceName() {
        let sessions = [
            makeSession(joinUrl: "https://t.test/join/x.secret", label: "Chrome", deviceId: "d1", deviceName: "", lastSeenAt: Date())
        ]
        XCTAssertEqual(ICloudSessionList.groups(from: sessions).first?.deviceName, "Unknown device")
    }

    func testGroupsOfNothingIsEmpty() {
        XCTAssertTrue(ICloudSessionList.groups(from: []).isEmpty)
    }

    // MARK: - Empty state

    func testEmptyReasonDistinguishesSignedOutFromNoSessions() {
        XCTAssertEqual(ICloudSessionList.emptyReason(hasICloudIdentity: false), .iCloudUnavailable)
        XCTAssertEqual(ICloudSessionList.emptyReason(hasICloudIdentity: true), .noSessions)
    }

    // MARK: - Age

    func testAgeThresholdsMatchTheLauncher() {
        let now = Date(timeIntervalSince1970: 100_000)
        XCTAssertEqual(ICloudSessionList.age(of: now, now: now), "just now")
        XCTAssertEqual(ICloudSessionList.age(of: now.addingTimeInterval(-120), now: now), "2m ago")
        XCTAssertEqual(ICloudSessionList.age(of: now.addingTimeInterval(-7200), now: now), "2h ago")
        XCTAssertEqual(ICloudSessionList.age(of: now.addingTimeInterval(-172_800), now: now), "2d ago")
    }

    // MARK: - UITest fixture seam

    func testSessionsFixtureBackendSeedsTwoDevices() throws {
        UserDefaults.standard.set(true, forKey: "uiTestSessionsFixture")
        defer { UserDefaults.standard.removeObject(forKey: "uiTestSessionsFixture") }

        let backend = try XCTUnwrap(UITestHooks.sessionsFixtureBackend())
        let store = TraySessionSyncStore(
            backend: backend, deviceId: "ios-under-test", deviceName: "iPhone Under Test"
        )

        let groups = ICloudSessionList.groups(from: store.sessions)
        XCTAssertEqual(Set(groups.map(\.deviceName)), ["Fixture MacBook", "Fixture Studio"])
        XCTAssertEqual(store.sessions.count, 3)
        // Every fixture join URL is hermetic — no test may dial out.
        XCTAssertTrue(store.sessions.allSatisfy { $0.joinUrl.hasPrefix("http://127.0.0.1:1/") })
    }

    func testSessionsEmptyBackendYieldsDeterministicEmptyStore() throws {
        UserDefaults.standard.set(true, forKey: "uiTestSessionsEmpty")
        defer { UserDefaults.standard.removeObject(forKey: "uiTestSessionsEmpty") }

        let backend = try XCTUnwrap(UITestHooks.sessionsFixtureBackend())
        let store = TraySessionSyncStore(
            backend: backend, deviceId: "ios-under-test", deviceName: "iPhone Under Test"
        )
        XCTAssertTrue(store.sessions.isEmpty)
    }

    func testNoFixtureArgumentsMeansNoBackend() {
        XCTAssertNil(UITestHooks.sessionsFixtureBackend())
    }

    // MARK: - Helpers

    private func makeSession(
        joinUrl: String,
        label: String,
        deviceId: String,
        deviceName: String,
        lastSeenAt: Date
    ) -> SyncedTraySession {
        SyncedTraySession(
            joinUrl: joinUrl,
            label: label,
            deviceId: deviceId,
            deviceName: deviceName,
            createdAt: lastSeenAt,
            lastSeenAt: lastSeenAt
        )
    }
}
