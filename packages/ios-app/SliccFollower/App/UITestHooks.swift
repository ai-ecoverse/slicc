import Foundation
import SliccTraySession

#if DEBUG
    /// Launch-argument seams that let XCUITest reach a deterministic screen
    /// without a leader on the other end.
    ///
    /// These read the `UserDefaults` argument domain, the same mechanism the
    /// documented `-joinUrl` override uses (see `packages/ios-app/CLAUDE.md`).
    /// The argument domain outranks the persistent domain, so a test that
    /// passes a key explicitly is immune to whatever a previous run left on
    /// disk — which matters because the suite runs in random order.
    ///
    /// Compiled out of release builds. A shipped binary must not carry an
    /// argument that skips the connection path.
    enum UITestHooks {
        /// Route straight to `FixtureConversationView` and skip the join /
        /// connect path entirely, so no test needs a live WebRTC peer.
        static var routesToFixture: Bool {
            UserDefaults.standard.bool(forKey: "uiTestFixtureRoute")
        }

        /// Force the connection banner into a given state. The stalled and
        /// gave-up states are otherwise only reachable by starving a real
        /// leader of pings or exhausting a real reconnect budget, neither of
        /// which a hermetic UI test can stage.
        ///
        /// Accepts a `ConnectionState` raw value; `stalled` additionally means
        /// "connected, but the leader stopped answering".
        static var forcedConnectionState: String? {
            UserDefaults.standard.string(forKey: "uiTestConnectionState")
        }

        /// Seed the iCloud sessions list without touching iCloud:
        /// `-uiTestSessionsFixture YES` yields two devices' worth of fixture
        /// sessions, `-uiTestSessionsEmpty YES` a deterministic empty store.
        /// Join URLs dial 127.0.0.1:1 so a tap reaches Connection Failed
        /// hermetically, like the existing failure-state test.
        static func sessionsFixtureBackend() -> KeyValueSyncBackend? {
            if UserDefaults.standard.bool(forKey: "uiTestSessionsEmpty") {
                return InMemoryKeyValueBackend()
            }
            guard UserDefaults.standard.bool(forKey: "uiTestSessionsFixture") else { return nil }
            let backend = InMemoryKeyValueBackend()
            let now = Date()
            seed(
                backend,
                deviceId: "fixture-macbook",
                sessions: [
                    SyncedTraySession(
                        joinUrl: "http://127.0.0.1:1/join/fixture-chrome",
                        label: "Chrome on Fixture MacBook",
                        deviceId: "fixture-macbook",
                        deviceName: "Fixture MacBook",
                        createdAt: now.addingTimeInterval(-3600),
                        lastSeenAt: now.addingTimeInterval(-60)
                    ),
                    SyncedTraySession(
                        joinUrl: "http://127.0.0.1:1/join/fixture-edge",
                        label: "Edge on Fixture MacBook",
                        deviceId: "fixture-macbook",
                        deviceName: "Fixture MacBook",
                        createdAt: now.addingTimeInterval(-7200),
                        lastSeenAt: now.addingTimeInterval(-7200)
                    ),
                ]
            )
            seed(
                backend,
                deviceId: "fixture-studio",
                sessions: [
                    SyncedTraySession(
                        joinUrl: "http://127.0.0.1:1/join/fixture-studio",
                        label: "Chrome on Fixture Studio",
                        deviceId: "fixture-studio",
                        deviceName: "Fixture Studio",
                        createdAt: now.addingTimeInterval(-300),
                        lastSeenAt: now.addingTimeInterval(-300)
                    )
                ]
            )
            return backend
        }

        private static func seed(
            _ backend: KeyValueSyncBackend,
            deviceId: String,
            sessions: [SyncedTraySession]
        ) {
            guard let data = try? JSONEncoder().encode(sessions) else { return }
            backend.setData(data, forKey: TraySessionSyncStore.storageKeyPrefix + deviceId)
        }

        /// Present the freezer surfaces on launch (screenshots + tests that
        /// need the sheet or the frozen view without a tap).
        static var opensFrozenRail: Bool {
            UserDefaults.standard.bool(forKey: "uiTestOpenFrozenRail")
        }
        static var opensFrozenSession: Bool {
            UserDefaults.standard.bool(forKey: "uiTestOpenFrozenSession")
        }

        /// Seed the freezer rail without a leader: `-uiTestFrozenFixture YES`
        /// yields two archived sessions, `-uiTestFrozenEmpty YES` a
        /// deterministic empty list.
        static func frozenFixture() -> [FrozenSessionIndexEntry]? {
            if UserDefaults.standard.bool(forKey: "uiTestFrozenEmpty") { return [] }
            guard UserDefaults.standard.bool(forKey: "uiTestFrozenFixture") else { return nil }
            return [
                FrozenSessionIndexEntry(
                    filename: "2026-07-30T10-00-00Z-fix-the-build.md",
                    title: "Fix the build",
                    frozenAt: "2026-07-30T10:00:00Z",
                    messageCount: 12,
                    sessionId: "fixture-frozen-1"
                ),
                FrozenSessionIndexEntry(
                    filename: "2026-07-01T09-00-00Z-plan-the-launch.md",
                    title: "Plan the launch",
                    frozenAt: "2026-07-01T09:00:00Z",
                    messageCount: 4,
                    sessionId: "fixture-frozen-2"
                ),
            ]
        }

        /// The archive body backing the fixture entries — a modern archive
        /// with an intact `slicc:session-data` block.
        static func frozenArchiveFixture(for entry: FrozenSessionIndexEntry) -> String? {
            guard UserDefaults.standard.bool(forKey: "uiTestFrozenFixture") else { return nil }
            return """
                ---
                title: \(#""\#(entry.title)""#)
                frozenAt: \(entry.frozenAt)
                ---

                <!-- slicc:session-data
                [{"id":"m1","role":"user","content":"What did we ship?","timestamp":1753867200000},\
                {"id":"m2","role":"assistant","content":"The freezer rail, read-only on your phone.","timestamp":1753867260000}]
                -->

                # \(entry.title)

                ## User

                What did we ship?

                ## Assistant

                The freezer rail, read-only on your phone.
                """
        }
    }
#endif
