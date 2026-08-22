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

    // MARK: - Discovered-session connect path

    /// The security contract of tap-to-join: the secret-bearing URL must not
    /// surface in the Join URL field, and a connection that has not landed yet
    /// must not be remembered — recents are recorded on success only.
    @MainActor
    func testDiscoveredSessionConnectLeavesManualSurfacesUntouched() {
        UserDefaults.standard.set(true, forKey: "uiTestRecentJoinsEmpty")
        defer { UserDefaults.standard.removeObject(forKey: "uiTestRecentJoinsEmpty") }
        let state = AppState()
        defer { state.disconnect() }
        let secret = "http://127.0.0.1:1/join/discovered.secret"

        state.connectToDiscoveredSession(joinUrl: secret)

        XCTAssertEqual(state.connectionState, .connecting)
        XCTAssertEqual(state.joinUrl, "", "The Join URL field must stay empty")
        XCTAssertFalse(
            state.recentJoinStore.recents.contains { $0.joinUrl == secret },
            "A dial that has not connected yet must not be remembered")
    }

    // MARK: - Recent rows

    func testRecentRowsHideATrayTheLiveListAlreadyShows() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let liveUrl = "https://t.test/join/live.secret"
        let live = makeSession(
            joinUrl: liveUrl, label: "Chrome", deviceId: "book", deviceName: "MacBook",
            lastSeenAt: now)
        let recents = [
            makeRecent(joinUrl: liveUrl, label: "Chrome", lastConnectedAt: now),
            makeRecent(joinUrl: "https://t.test/join/other.secret", label: "Other", lastConnectedAt: now),
        ]

        let rows = ICloudSessionList.recentRows(from: recents, excluding: [live]) { _ in true }

        XCTAssertEqual(rows.map(\.label), ["Other"], "A live tray must occupy one row, not two")
    }

    func testRecentRowsRankReachableFirstAndCapAtFive() {
        let base = Date(timeIntervalSince1970: 1_000_000)
        let live = makeRecent(
            joinUrl: "https://t.test/join/live.secret", label: "Live", lastConnectedAt: base)
        let dead = (0..<5).map { index in
            makeRecent(
                joinUrl: "https://t.test/join/dead\(index).secret", label: "Dead\(index)",
                lastConnectedAt: base.addingTimeInterval(Double(600 + index)))
        }

        let rows = ICloudSessionList.recentRows(from: dead + [live], excluding: []) {
            $0 == live.id
        }

        XCTAssertEqual(rows.count, 5)
        XCTAssertEqual(rows.first?.label, "Live")
        XCTAssertFalse(rows.contains(dead[0]), "The oldest dead row is the one pushed out")
    }

    func testRecentTitleFallsBackToTheHostNeverTheSecretPath() {
        XCTAssertEqual(
            ICloudSessionList.recentTitle(
                makeRecent(joinUrl: "https://tray.sliccy.ai/join/x.secret", label: "Chrome")),
            "Chrome")
        let unlabelled = makeRecent(joinUrl: "http://192.168.1.4:5710/join/x.secret", label: "")
        XCTAssertEqual(ICloudSessionList.recentTitle(unlabelled), "192.168.1.4:5710")
        XCTAssertFalse(ICloudSessionList.recentTitle(unlabelled).contains("secret"))
        XCTAssertEqual(
            ICloudSessionList.recentTitle(makeRecent(joinUrl: "not a url", label: "")),
            "Sliccy session")
    }

    func testRecentSubtitleNamesTheDeviceAgeAndBadNews() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let mine = makeRecent(
            joinUrl: "https://tray.sliccy.ai/join/x.secret", label: "Chrome", deviceName: "iPhone",
            lastConnectedAt: now.addingTimeInterval(-120))

        XCTAssertEqual(
            ICloudSessionList.recentSubtitle(
                mine, thisDeviceId: "iPhone", now: now, unreachable: false),
            "This device · tray.sliccy.ai · 2m ago")
        XCTAssertEqual(
            ICloudSessionList.recentSubtitle(
                mine, thisDeviceId: "iPad", now: now, unreachable: true),
            "iPhone · tray.sliccy.ai · 2m ago · not responding")
        // An unlabelled row already shows the host as its title.
        let pasted = makeRecent(
            joinUrl: "https://tray.sliccy.ai/join/x.secret", label: "", deviceName: "iPad",
            lastConnectedAt: now)
        XCTAssertEqual(
            ICloudSessionList.recentSubtitle(
                pasted, thisDeviceId: "iPhone", now: now, unreachable: false),
            "iPad · just now")
    }

    func testRecentJoinsFixtureBackendSeedsThisDeviceAndAnother() throws {
        UserDefaults.standard.set(true, forKey: "uiTestRecentJoinsFixture")
        defer { UserDefaults.standard.removeObject(forKey: "uiTestRecentJoinsFixture") }

        let backend = try XCTUnwrap(UITestHooks.recentJoinsFixtureBackend())
        let store = RecentJoinStore(
            backend: backend, deviceId: "ios-under-test", deviceName: "iPhone Under Test")

        XCTAssertEqual(store.recents.count, 2)
        XCTAssertEqual(Set(store.recents.map(\.deviceName)), ["iPhone Under Test", "Fixture iPad"])
        XCTAssertEqual(
            Set(store.recents.map(\.label)), ["Safari on Fixture MacBook", ""],
            "The labelled fixture recent must not collide with a live fixture session")
        // The pasted-elsewhere row deliberately carries no label.
        XCTAssertTrue(store.recents.contains { $0.label.isEmpty })
        XCTAssertTrue(store.recents.allSatisfy { $0.joinUrl.hasPrefix("http://127.0.0.1:1/") })
    }

    func testRecentJoinsEmptyBackendYieldsDeterministicEmptyStore() throws {
        UserDefaults.standard.set(true, forKey: "uiTestRecentJoinsEmpty")
        defer { UserDefaults.standard.removeObject(forKey: "uiTestRecentJoinsEmpty") }

        let backend = try XCTUnwrap(UITestHooks.recentJoinsFixtureBackend())
        let store = RecentJoinStore(
            backend: backend, deviceId: "ios-under-test", deviceName: "iPhone Under Test")
        XCTAssertTrue(store.recents.isEmpty)
    }

    func testNoRecentJoinsArgumentsMeansNoBackend() {
        XCTAssertNil(UITestHooks.recentJoinsFixtureBackend())
    }

    // MARK: - Helpers

    private func makeRecent(
        joinUrl: String,
        label: String,
        deviceName: String = "iPhone",
        lastConnectedAt: Date = Date(timeIntervalSince1970: 1_000_000)
    ) -> RecentJoin {
        RecentJoin(
            joinUrl: joinUrl,
            label: label,
            deviceId: deviceName,
            deviceName: deviceName,
            firstConnectedAt: lastConnectedAt,
            lastConnectedAt: lastConnectedAt
        )
    }

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
