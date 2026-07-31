import XCTest

/// The connection banner and composer states introduced with stall detection
/// and bounded reconnect (#1793).
///
/// The stalled and gave-up states cannot be staged against a real leader in a
/// hermetic test — one needs a peer that stops answering pings while keeping
/// its channel open, the other needs a whole reconnect budget to expire — so
/// `-uiTestConnectionState` pins the state directly. See `UITestHooks`.
final class ConnectionStateUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// A busy leader must read as busy, not as a disconnect. This is the whole
    /// point of the stall state: the connection is fine.
    func testAStalledLeaderSaysSoInsteadOfClaimingDisconnection() {
        let app = launchApp(forcing: "stalled")

        let banner = app.staticTexts["connection-status"]
        XCTAssertTrue(banner.waitForExistence(timeout: 60), "A stall should raise the banner")
        XCTAssertTrue(
            banner.label.contains("busy"),
            "The banner should name the leader as busy, got \(banner.label)")
        XCTAssertFalse(
            banner.label.contains("Disconnected"),
            "A stall is not a disconnect and must not read as one")
    }

    /// The composer has to refuse input during a stall, or a typed message is
    /// accepted into a channel that cannot deliver it.
    func testTheComposerRefusesInputDuringAStall() {
        let app = launchApp(forcing: "stalled")

        let placeholder = app.staticTexts["composer-placeholder"]
        XCTAssertTrue(placeholder.waitForExistence(timeout: 60))
        XCTAssertTrue(
            placeholder.label.contains("busy"),
            "The composer should explain the block, got \(placeholder.label)")
    }

    /// A transient reconnect must show progress, so it does not read as a hang.
    func testReconnectingShowsWhichAttemptIsInFlight() {
        let app = launchApp(forcing: "reconnecting")

        let banner = app.staticTexts["connection-status"]
        XCTAssertTrue(banner.waitForExistence(timeout: 60))
        XCTAssertTrue(
            banner.label.contains("Reconnecting"),
            "Expected a reconnecting banner, got \(banner.label)")
        XCTAssertTrue(
            banner.label.contains("3"),
            "The attempt count is what distinguishes a retry from a hang, got \(banner.label)")
    }

    /// Exhausting the budget is terminal and must say what the user can do.
    func testGivingUpIsTerminalAndActionable() {
        let app = launchApp(forcing: "gaveUp")

        let banner = app.staticTexts["connection-status"]
        XCTAssertTrue(banner.waitForExistence(timeout: 60))
        XCTAssertTrue(
            banner.label.contains("Couldn't reach the leader"),
            "Expected the terminal copy, got \(banner.label)")
        XCTAssertFalse(
            banner.label.contains("Reconnecting"),
            "Giving up must not still claim to be retrying")
    }

    // MARK: - Helpers

    /// `joinUrl` is passed explicitly and empty so a value persisted by another
    /// test cannot start a real connection underneath the forced state.
    private func launchApp(forcing state: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-uiTestConnectionState", state,
            "-joinUrl", "",
        ]
        app.launch()
        return app
    }
}
