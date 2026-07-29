import AppKit
import XCTest

@testable import Sliccstart

@MainActor
final class TraySessionSyncTests: XCTestCase {
    // MARK: - Model

    func testSessionIdentityIsAnOpaqueHashOfJoinURL() {
        let joinUrl = "https://slicc.test/join/abc.secret"
        let session = makeSession(joinUrl: joinUrl)
        // Stable, derived from the join URL, but not the join URL itself — so
        // it is safe to use in accessibility identifiers / telemetry.
        XCTAssertEqual(session.id, SyncedTraySession.identifier(forJoinUrl: joinUrl))
        XCTAssertNotEqual(session.id, joinUrl)
        XCTAssertFalse(session.id.contains("secret"))
        XCTAssertEqual(session.id.count, 64)  // SHA-256 hex
    }

    func testSessionCodableRoundTrip() throws {
        let session = makeSession(joinUrl: "https://slicc.test/join/x.secret")
        let data = try JSONEncoder().encode(session)
        let decoded = try JSONDecoder().decode(SyncedTraySession.self, from: data)
        XCTAssertEqual(decoded, session)
    }

    func testIsStaleUsesTTLAgainstLastSeen() {
        let now = Date(timeIntervalSince1970: 10_000)
        let session = makeSession(joinUrl: "https://slicc.test/join/x.secret", lastSeenAt: now)
        XCTAssertFalse(session.isStale(ttl: 60, now: now.addingTimeInterval(59)))
        XCTAssertTrue(session.isStale(ttl: 60, now: now.addingTimeInterval(61)))
    }

    // MARK: - Store

    func testPublishAddsLocalSession() {
        let store = makeStore(deviceName: "MacA")
        store.publish(joinUrl: "https://slicc.test/join/a.secret", label: "Chrome")

        XCTAssertEqual(store.sessions.count, 1)
        XCTAssertEqual(store.localSessions.map(\.label), ["Chrome"])
        XCTAssertEqual(store.localSessions.first?.deviceName, "MacA")
        XCTAssertTrue(store.remoteSessions.isEmpty)
    }

    func testRepublishUpsertsAndPreservesCreatedAt() {
        var now = Date(timeIntervalSince1970: 1_000)
        let store = makeStore(deviceName: "MacA", clock: { now })
        store.publish(joinUrl: "https://slicc.test/join/a.secret", label: "Chrome")
        let created = store.localSessions.first?.createdAt

        now = now.addingTimeInterval(120)
        store.publish(joinUrl: "https://slicc.test/join/a.secret", label: "Chrome (renamed)")

        XCTAssertEqual(store.sessions.count, 1)
        XCTAssertEqual(store.localSessions.first?.label, "Chrome (renamed)")
        XCTAssertEqual(store.localSessions.first?.createdAt, created)
        XCTAssertEqual(store.localSessions.first?.lastSeenAt, now)
    }

    func testWithdrawRemovesSession() {
        let store = makeStore(deviceName: "MacA")
        store.publish(joinUrl: "https://slicc.test/join/a.secret", label: "Chrome")
        store.withdraw(joinUrl: "https://slicc.test/join/a.secret")
        XCTAssertTrue(store.sessions.isEmpty)
    }

    func testWithdrawLocalSessionsLeavesRemoteIntact() {
        let backend = InMemoryKeyValueBackend()
        let deviceA = makeStore(deviceName: "MacA", backend: backend)
        deviceA.publish(joinUrl: "https://slicc.test/join/a.secret", label: "Chrome")

        let deviceB = makeStore(deviceName: "MacB", backend: backend)
        deviceB.publish(joinUrl: "https://slicc.test/join/b.secret", label: "Edge")

        deviceB.withdrawLocalSessions()
        deviceB.reload()

        XCTAssertEqual(deviceB.localSessions.count, 0)
        XCTAssertEqual(deviceB.remoteSessions.map(\.label), ["Chrome"])
    }

    func testOtherDeviceSessionSurfacesAsRemote() {
        let backend = InMemoryKeyValueBackend()
        let deviceA = makeStore(deviceName: "MacA", backend: backend)
        deviceA.publish(joinUrl: "https://slicc.test/join/a.secret", label: "Chrome")

        let deviceB = makeStore(deviceName: "MacB", backend: backend)
        deviceB.reload()

        XCTAssertEqual(deviceB.remoteSessions.map(\.deviceName), ["MacA"])
        XCTAssertTrue(deviceB.localSessions.isEmpty)
    }

    func testStaleSessionsArePrunedOnReload() {
        var now = Date(timeIntervalSince1970: 1_000)
        let store = makeStore(deviceName: "MacA", ttl: 60, clock: { now })
        store.publish(joinUrl: "https://slicc.test/join/a.secret", label: "Chrome")
        XCTAssertEqual(store.sessions.count, 1)

        now = now.addingTimeInterval(61)
        store.reload()
        XCTAssertTrue(store.sessions.isEmpty)
    }

    func testActiveSortsNewestFirstAndCaps() {
        let base = Date(timeIntervalSince1970: 1_000_000)
        let raw = (0..<(TraySessionSyncStore.maxSessions + 5)).map { index in
            makeSession(
                joinUrl: "https://slicc.test/join/\(index).secret",
                lastSeenAt: base.addingTimeInterval(TimeInterval(index))
            )
        }
        let now = base.addingTimeInterval(TimeInterval(raw.count))
        let capped = TraySessionSyncStore.active(from: raw, ttl: .greatestFiniteMagnitude, now: now)

        XCTAssertEqual(capped.count, TraySessionSyncStore.maxSessions)
        XCTAssertGreaterThan(capped[0].lastSeenAt, capped[1].lastSeenAt)
    }

    func testSameHostNameDevicesStayDistinctByDeviceId() {
        let backend = InMemoryKeyValueBackend()
        // Two Macs both named "MacBook Pro" but with distinct persisted UUIDs.
        let deviceA = makeStore(deviceName: "MacBook Pro", deviceId: "uuid-a", backend: backend)
        deviceA.publish(joinUrl: "https://slicc.test/join/a.secret", label: "Chrome")
        let deviceB = makeStore(deviceName: "MacBook Pro", deviceId: "uuid-b", backend: backend)
        deviceB.publish(joinUrl: "https://slicc.test/join/b.secret", label: "Edge")

        deviceB.reload()
        XCTAssertEqual(deviceB.localSessions.map(\.label), ["Edge"])
        XCTAssertEqual(deviceB.remoteSessions.map(\.label), ["Chrome"])

        // Withdrawing on B must not delete A's advertisement.
        deviceB.withdrawLocalSessions()
        deviceA.reload()
        XCTAssertEqual(deviceA.localSessions.map(\.label), ["Chrome"])
    }

    func testConcurrentPublishDoesNotClobber() {
        let backend = InMemoryKeyValueBackend()
        let deviceA = makeStore(deviceName: "MacA", backend: backend)
        let deviceB = makeStore(deviceName: "MacB", backend: backend)

        deviceA.publish(joinUrl: "https://slicc.test/join/a.secret", label: "Chrome")
        deviceB.publish(joinUrl: "https://slicc.test/join/b.secret", label: "Edge")

        deviceA.reload()
        XCTAssertEqual(Set(deviceA.sessions.map(\.label)), ["Chrome", "Edge"])
    }

    func testCurrentDeviceIdIsMintedOnceAndStable() {
        let defaults = UserDefaults(suiteName: "TraySyncDeviceId-\(UUID().uuidString)")!
        let first = TraySessionSyncStore.currentDeviceId(defaults: defaults)
        let second = TraySessionSyncStore.currentDeviceId(defaults: defaults)
        XCTAssertFalse(first.isEmpty)
        XCTAssertEqual(first, second)
    }

    func testLegacyPayloadWithoutDeviceIdDecodes() throws {
        let legacy = """
            {"id":"abc","joinUrl":"https://slicc.test/join/x.secret","label":"Chrome",\
            "deviceName":"MacA","createdAt":0,"lastSeenAt":0}
            """
        let decoded = try JSONDecoder().decode(SyncedTraySession.self, from: Data(legacy.utf8))
        XCTAssertEqual(decoded.deviceId, "")
        XCTAssertEqual(decoded.deviceName, "MacA")
    }

    // MARK: - Age formatting

    func testAgeFormatting() {
        let now = Date(timeIntervalSince1970: 100_000)
        XCTAssertEqual(TraySessionRow.age(of: now, now: now), "just now")
        XCTAssertEqual(TraySessionRow.age(of: now.addingTimeInterval(-120), now: now), "2m ago")
        XCTAssertEqual(TraySessionRow.age(of: now.addingTimeInterval(-7200), now: now), "2h ago")
        XCTAssertEqual(TraySessionRow.age(of: now.addingTimeInterval(-172_800), now: now), "2d ago")
    }

    // MARK: - Remote follow override

    func testTerminalFollowerUsesOverrideWithoutLocalLeader() async throws {
        var launchedCommand: String?
        let service = TerminalFollowerLaunchService(
            findCliBinary: { "/usr/local/bin/slicc" },
            downloadCli: { _ in URL(fileURLWithPath: "/unused") },
            resolveLoginShell: { "/bin/zsh" },
            loadTemplate: { FollowCommandTemplate.defaultTemplate },
            launchTerminal: { _, command in launchedCommand = command }
        )
        let process = SliccProcess(terminalFollowerLaunchService: service)
        // No leader seeded and leaderJoinUrl is nil — the override must still
        // drive a follower attaching to the remote leader.
        XCTAssertFalse(process.isLeaderReady())

        try await process.launchTerminalFollower(
            terminalTarget(),
            joinURLOverride: "https://remote.test/join/token.secret"
        )

        XCTAssertEqual(
            launchedCommand,
            "/usr/local/bin/slicc https://remote.test/join/token.secret follow /bin/zsh -c"
        )
    }

    // MARK: - Helpers

    private func makeStore(
        deviceName: String,
        deviceId: String? = nil,
        backend: KeyValueSyncBackend = InMemoryKeyValueBackend(),
        ttl: TimeInterval = TraySessionSyncStore.defaultTTL,
        clock: @escaping () -> Date = Date.init
    ) -> TraySessionSyncStore {
        TraySessionSyncStore(
            backend: backend,
            deviceId: deviceId ?? deviceName,
            deviceName: deviceName,
            ttl: ttl,
            clock: clock
        )
    }

    private func makeSession(
        joinUrl: String,
        deviceId: String = "MacA",
        deviceName: String = "MacA",
        lastSeenAt: Date = Date(timeIntervalSince1970: 0)
    ) -> SyncedTraySession {
        SyncedTraySession(
            joinUrl: joinUrl,
            label: "Chrome",
            deviceId: deviceId,
            deviceName: deviceName,
            createdAt: lastSeenAt,
            lastSeenAt: lastSeenAt
        )
    }

    private func terminalTarget() -> AppTarget {
        AppTarget(
            id: UUID().uuidString,
            name: "Terminal",
            path: "/Applications/Terminal.app",
            executablePath: "/Applications/Terminal.app/Contents/MacOS/Terminal",
            type: .terminal,
            icon: NSImage(),
            debugSupport: .unknown,
            isDebugBuild: false,
            originalAppPath: nil
        )
    }
}
