import SliccTraySession
import XCTest

@MainActor
final class RecentJoinStoreTests: XCTestCase {
    // MARK: - Model

    func testIdentityMatchesTheSessionHashSoLiveAndRecentCollapse() {
        let joinUrl = "https://slicc.test/join/abc.secret"
        let recent = makeRecent(joinUrl: joinUrl)
        XCTAssertEqual(recent.id, SyncedTraySession.identifier(forJoinUrl: joinUrl))
        XCTAssertFalse(recent.id.contains("secret"))
        XCTAssertEqual(recent.id.count, 64)
    }

    func testCodableRoundTrip() throws {
        let recent = makeRecent(joinUrl: "https://slicc.test/join/x.secret")
        let decoded = try JSONDecoder().decode(
            RecentJoin.self, from: JSONEncoder().encode(recent))
        XCTAssertEqual(decoded, recent)
    }

    func testDisplayHostKeepsThePortAndDropsTheSecretPath() {
        XCTAssertEqual(
            makeRecent(joinUrl: "https://tray.sliccy.ai/join/abc.secret").displayHost,
            "tray.sliccy.ai")
        XCTAssertEqual(
            makeRecent(joinUrl: "http://192.168.1.4:5710/join/abc.secret").displayHost,
            "192.168.1.4:5710")
        // A row must never be able to render the secret-bearing path.
        XCTAssertFalse(
            makeRecent(joinUrl: "https://tray.sliccy.ai/join/abc.secret").displayHost
                .contains("secret"))
        XCTAssertEqual(makeRecent(joinUrl: "not a url").displayHost, "")
    }

    func testIsStaleUsesTTLAgainstLastConnected() {
        let now = Date(timeIntervalSince1970: 10_000)
        let recent = makeRecent(joinUrl: "https://slicc.test/join/x.secret", lastConnectedAt: now)
        XCTAssertFalse(recent.isStale(ttl: 60, now: now.addingTimeInterval(59)))
        XCTAssertTrue(recent.isStale(ttl: 60, now: now.addingTimeInterval(61)))
    }

    // MARK: - Recording

    func testRecordRemembersAJoinURLThisDeviceConnectedTo() {
        let store = makeStore(deviceName: "iPhone")
        store.record(joinUrl: "https://slicc.test/join/a.secret", label: "Chrome")

        XCTAssertEqual(store.recents.map(\.label), ["Chrome"])
        XCTAssertEqual(store.recents.first?.deviceName, "iPhone")
    }

    func testRecordIgnoresEmptyAndWhitespaceURLs() {
        let store = makeStore(deviceName: "iPhone")
        store.record(joinUrl: "", label: "x")
        store.record(joinUrl: "   \n", label: "x")
        XCTAssertTrue(store.recents.isEmpty)
    }

    func testRecordTrimsSurroundingWhitespaceSoAPasteDoesNotForkTheEntry() {
        let store = makeStore(deviceName: "iPhone")
        store.record(joinUrl: "https://slicc.test/join/a.secret", label: "Chrome")
        store.record(joinUrl: "  https://slicc.test/join/a.secret\n", label: "Chrome")
        XCTAssertEqual(store.recents.count, 1)
    }

    func testReconnectUpsertsAndPreservesFirstConnectedAt() {
        var now = Date(timeIntervalSince1970: 1_000)
        let store = makeStore(deviceName: "iPhone", clock: { now })
        store.record(joinUrl: "https://slicc.test/join/a.secret", label: "Chrome")
        let first = store.recents.first?.firstConnectedAt

        now = now.addingTimeInterval(600)
        store.record(joinUrl: "https://slicc.test/join/a.secret", label: "Chrome (renamed)")

        XCTAssertEqual(store.recents.count, 1)
        XCTAssertEqual(store.recents.first?.firstConnectedAt, first)
        XCTAssertEqual(store.recents.first?.lastConnectedAt, now)
        XCTAssertEqual(store.recents.first?.label, "Chrome (renamed)")
    }

    func testAnUnlabelledReconnectKeepsTheNameAnEarlierConnectLearned() {
        let store = makeStore(deviceName: "iPhone")
        store.record(joinUrl: "https://slicc.test/join/a.secret", label: "Chrome on Studio")
        // A hand-pasted URL arrives with no label; that must not erase the name.
        store.record(joinUrl: "https://slicc.test/join/a.secret", label: "")
        XCTAssertEqual(store.recents.first?.label, "Chrome on Studio")
    }

    func testEachDevicePersistsAtMostFiveOfItsOwn() {
        var now = Date(timeIntervalSince1970: 1_000)
        let store = makeStore(deviceName: "iPhone", clock: { now })
        for index in 0..<8 {
            now = now.addingTimeInterval(60)
            store.record(joinUrl: "https://slicc.test/join/\(index).secret", label: "S\(index)")
        }
        XCTAssertEqual(store.recents.count, RecentJoinStore.maxRecents)
        // The five newest survive, newest first.
        XCTAssertEqual(store.recents.map(\.label), ["S7", "S6", "S5", "S4", "S3"])
    }

    func testStaleEntriesFallOutOfTheList() {
        var now = Date(timeIntervalSince1970: 1_000)
        let store = makeStore(deviceName: "iPhone", ttl: 300, clock: { now })
        store.record(joinUrl: "https://slicc.test/join/old.secret", label: "Old")
        now = now.addingTimeInterval(600)
        store.record(joinUrl: "https://slicc.test/join/new.secret", label: "New")

        XCTAssertEqual(store.recents.map(\.label), ["New"])
    }

    // MARK: - Cross-device merge

    func testAPasteOnAnotherDeviceShowsUpHere() {
        let backend = InMemoryKeyValueBackend()
        let phone = makeStore(deviceName: "iPhone", backend: backend)
        let pad = makeStore(deviceName: "iPad", backend: backend)

        pad.record(joinUrl: "https://slicc.test/join/pasted.secret", label: "Pasted on iPad")
        phone.reload()

        XCTAssertEqual(phone.recents.map(\.label), ["Pasted on iPad"])
        XCTAssertEqual(phone.recents.first?.deviceName, "iPad")
    }

    func testConcurrentDevicesDoNotClobberEachOther() {
        let backend = InMemoryKeyValueBackend()
        let phone = makeStore(deviceName: "iPhone", backend: backend)
        let pad = makeStore(deviceName: "iPad", backend: backend)

        phone.record(joinUrl: "https://slicc.test/join/a.secret", label: "A")
        pad.record(joinUrl: "https://slicc.test/join/b.secret", label: "B")
        phone.reload()

        XCTAssertEqual(Set(phone.recents.map(\.label)), ["A", "B"])
    }

    func testTheSameURLOnTwoDevicesCollapsesToTheNewerConnection() {
        var now = Date(timeIntervalSince1970: 1_000)
        let backend = InMemoryKeyValueBackend()
        let phone = makeStore(deviceName: "iPhone", backend: backend, clock: { now })
        let pad = makeStore(deviceName: "iPad", backend: backend, clock: { now })

        phone.record(joinUrl: "https://slicc.test/join/shared.secret", label: "Shared")
        now = now.addingTimeInterval(300)
        pad.record(joinUrl: "https://slicc.test/join/shared.secret", label: "")
        phone.reload()

        XCTAssertEqual(phone.recents.count, 1)
        // Attribution follows the most recent connect; the label survives it.
        XCTAssertEqual(phone.recents.first?.deviceName, "iPad")
        XCTAssertEqual(phone.recents.first?.label, "Shared")
        XCTAssertEqual(phone.recents.first?.firstConnectedAt, Date(timeIntervalSince1970: 1_000))
        XCTAssertEqual(phone.recents.first?.lastConnectedAt, now)
    }

    func testMergedPoolIsBounded() {
        var now = Date(timeIntervalSince1970: 1_000)
        let backend = InMemoryKeyValueBackend()
        // Six devices × five entries is well past the pooled ceiling.
        for device in 0..<6 {
            let store = makeStore(deviceName: "device\(device)", backend: backend, clock: { now })
            for entry in 0..<5 {
                now = now.addingTimeInterval(60)
                store.record(joinUrl: "https://slicc.test/join/\(device)-\(entry).secret", label: "x")
            }
        }
        let reader = makeStore(deviceName: "reader", backend: backend, clock: { now })
        XCTAssertEqual(reader.recents.count, RecentJoinStore.maxPooled)
    }

    // MARK: - Ranking

    func testRankPutsReachableFirstThenNewest() {
        let base = Date(timeIntervalSince1970: 1_000)
        let live = makeRecent(joinUrl: "https://t.test/join/live.secret", lastConnectedAt: base)
        let deadNewer = makeRecent(
            joinUrl: "https://t.test/join/dead.secret", lastConnectedAt: base.addingTimeInterval(600))
        let liveNewest = makeRecent(
            joinUrl: "https://t.test/join/newest.secret", lastConnectedAt: base.addingTimeInterval(900))

        let ranked = RecentJoinStore.rank([live, deadNewer, liveNewest]) { $0 != deadNewer.id }

        // A dead row sinks below every live one, however fresh it is.
        XCTAssertEqual(ranked.map(\.id), [liveNewest.id, live.id, deadNewer.id])
    }

    func testRankCapsAtFiveAfterRankingSoALiveOlderRowCanDisplaceADeadNewerOne() {
        let base = Date(timeIntervalSince1970: 1_000)
        // Five dead-but-recent rows, one live-but-old.
        let dead = (0..<5).map { index in
            makeRecent(
                joinUrl: "https://t.test/join/dead\(index).secret",
                lastConnectedAt: base.addingTimeInterval(Double(600 + index)))
        }
        let liveOld = makeRecent(joinUrl: "https://t.test/join/live.secret", lastConnectedAt: base)

        let ranked = RecentJoinStore.rank(dead + [liveOld]) { $0 == liveOld.id }

        XCTAssertEqual(ranked.count, RecentJoinStore.maxRecents)
        XCTAssertEqual(ranked.first?.id, liveOld.id)
        // The oldest dead row is the one pushed out.
        XCTAssertFalse(ranked.contains(dead[0]))
    }

    func testRankIsATotalOrderForEqualTimestamps() {
        let now = Date(timeIntervalSince1970: 1_000)
        let entries = [
            makeRecent(joinUrl: "https://t.test/join/a.secret", lastConnectedAt: now),
            makeRecent(joinUrl: "https://t.test/join/b.secret", lastConnectedAt: now),
        ]
        let first = RecentJoinStore.rank(entries) { _ in true }
        let second = RecentJoinStore.rank(entries.reversed()) { _ in true }
        XCTAssertEqual(first.map(\.id), second.map(\.id))
    }

    func testRankedUsesTheStoresOwnPool() {
        let store = makeStore(deviceName: "iPhone")
        store.record(joinUrl: "https://slicc.test/join/a.secret", label: "A")
        store.record(joinUrl: "https://slicc.test/join/b.secret", label: "B")
        let deadId = SyncedTraySession.identifier(forJoinUrl: "https://slicc.test/join/b.secret")

        XCTAssertEqual(store.ranked { $0 != deadId }.map(\.label), ["A", "B"])
        XCTAssertEqual(store.ranked(limit: 1) { _ in true }.count, 1)
        XCTAssertTrue(store.ranked(limit: 0) { _ in true }.isEmpty)
    }

    // MARK: - Forgetting

    func testForgetDropsOneOwnEntry() {
        let store = makeStore(deviceName: "iPhone")
        store.record(joinUrl: "https://slicc.test/join/a.secret", label: "A")
        store.record(joinUrl: "https://slicc.test/join/b.secret", label: "B")

        store.forget(id: SyncedTraySession.identifier(forJoinUrl: "https://slicc.test/join/a.secret"))

        XCTAssertEqual(store.recents.map(\.label), ["B"])
    }

    func testClearLocalHistoryLeavesOtherDevicesEntriesAlone() {
        let backend = InMemoryKeyValueBackend()
        let phone = makeStore(deviceName: "iPhone", backend: backend)
        let pad = makeStore(deviceName: "iPad", backend: backend)
        phone.record(joinUrl: "https://slicc.test/join/a.secret", label: "A")
        pad.record(joinUrl: "https://slicc.test/join/b.secret", label: "B")

        phone.clearLocalHistory()

        // Nothing can write another device's key, so the iPad's row survives —
        // the same limit `withdrawLocalSessions` has in the session store.
        XCTAssertEqual(phone.recents.map(\.label), ["B"])
    }

    // MARK: - Backend plumbing

    func testCorruptPayloadDecodesAsEmptyRatherThanCrashing() {
        let backend = InMemoryKeyValueBackend()
        backend.setData(Data("not json".utf8), forKey: RecentJoinStore.storageKeyPrefix + "iPad")
        let store = makeStore(deviceName: "iPhone", backend: backend)
        XCTAssertTrue(store.recents.isEmpty)
    }

    func testExternalICloudChangeReloadsAndObserverIsTornDown() {
        let backend = ObservableRecentsBackend()
        var store: RecentJoinStore? = makeStore(deviceName: "iPhone", backend: backend)
        XCTAssertTrue(store?.recents.isEmpty ?? false)

        let seeded = makeRecent(
            joinUrl: "https://slicc.test/join/remote.secret", deviceName: "iPad",
            lastConnectedAt: Date())
        backend.setData(
            try? JSONEncoder().encode([seeded]),
            forKey: RecentJoinStore.storageKeyPrefix + "iPad")
        NotificationCenter.default.post(name: ObservableRecentsBackend.changeName, object: nil)
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        XCTAssertEqual(store?.recents.count, 1)

        store = nil
        XCTAssertNil(store)
    }

    func testStoreKeyNamespaceIsSeparateFromLiveSessions() {
        XCTAssertFalse(
            RecentJoinStore.storageKeyPrefix.hasPrefix(TraySessionSyncStore.storageKeyPrefix))
        XCTAssertFalse(
            TraySessionSyncStore.storageKeyPrefix.hasPrefix(RecentJoinStore.storageKeyPrefix))
    }

    // MARK: - Helpers

    private func makeStore(
        deviceName: String,
        backend: KeyValueSyncBackend = InMemoryKeyValueBackend(),
        ttl: TimeInterval = RecentJoinStore.defaultTTL,
        clock: @escaping () -> Date = Date.init
    ) -> RecentJoinStore {
        RecentJoinStore(
            backend: backend,
            deviceId: deviceName,
            deviceName: deviceName,
            ttl: ttl,
            clock: clock
        )
    }

    private func makeRecent(
        joinUrl: String,
        label: String = "Chrome",
        deviceName: String = "iPhone",
        lastConnectedAt: Date = Date(timeIntervalSince1970: 0)
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
}

/// Mirrors `ObservableTestBackend` for the recents namespace: an in-memory
/// backend that advertises an external-change notification, so the observer
/// registration/teardown path iCloud drives in production stays exercisable.
private final class ObservableRecentsBackend: KeyValueSyncBackend {
    static let changeName = Notification.Name("SliccTraySessionTest.recentsChanged")
    private var storage: [String: Data] = [:]

    func data(forKey key: String) -> Data? { storage[key] }
    func setData(_ data: Data?, forKey key: String) { storage[key] = data }
    func keys(withPrefix prefix: String) -> [String] {
        storage.keys.filter { $0.hasPrefix(prefix) }
    }
    @discardableResult func synchronize() -> Bool { true }
    var externalChange: (name: Notification.Name, object: AnyObject?)? {
        (Self.changeName, nil)
    }
}
