import Foundation

/// How the raw transport state reaches the chat surface.
///
/// The stored half — `settledConnection`, `connectionSettler`,
/// `connectionIngestSuspended` — has to live on the class itself, since Swift
/// keeps stored properties out of extensions. Everything that reads or feeds
/// them is here. Rules and rationale: `docs/ios-app-details.md`, "Settle
/// window".
extension AppState {

    /// The transport as it actually is, this instant.
    ///
    /// The attempt counter only means something while reconnecting, so it is
    /// dropped otherwise: a healthy reading that still carried the last
    /// attempt number would differ from the same healthy reading a moment
    /// later and republish for nothing.
    var rawConnectionHealth: ConnectionHealth {
        ConnectionHealth(
            state: connectionState,
            isStalled: isLeaderStalled,
            reconnectAttempt: connectionState == .reconnecting ? reconnectAttempt : 0)
    }

    /// Feed the settler one reading. Called from the `didSet` on each transport
    /// property, and once more at the end of an `updateConnection` block.
    func ingestConnectionHealth() {
        guard !connectionIngestSuspended else { return }
        connectionSettler.ingest(rawConnectionHealth)
    }

    /// Apply several transport properties as ONE reading.
    ///
    /// Each property publishes through its own `didSet`, so a sequence that
    /// passes through a healthy-looking intermediate — "clear the stall, then
    /// start reconnecting" is the one that bit — hands the settler a recovery
    /// it never had. It would then drop the treatment already on screen and
    /// make the real trouble serve a fresh hold, so a stall that died would
    /// read as connected for the whole window. Writes made inside this block
    /// are ingested once, on the value they end at.
    func updateConnection(_ mutate: () -> Void) {
        connectionIngestSuspended = true
        mutate()
        connectionIngestSuspended = false
        ingestConnectionHealth()
    }

    #if DEBUG
        /// Publish the raw state to the UI at once. The UI-test hooks pin a
        /// connection no transport produced, so the treatment has to be on
        /// screen when the test looks rather than a settle window later; a
        /// staged blip (`-uiTestConnectionBlip`) deliberately does NOT call
        /// this, since holding that transition is what it exists to exercise.
        func settleConnectionImmediately() {
            connectionSettler.settleImmediately(rawConnectionHealth)
        }
    #endif
}
