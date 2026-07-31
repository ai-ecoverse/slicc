import Foundation

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
    }
#endif
