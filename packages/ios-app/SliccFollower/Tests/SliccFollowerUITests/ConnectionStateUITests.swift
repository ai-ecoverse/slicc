import XCTest

/// Avatar-static and composer states introduced with stall detection and bounded reconnect (#1793).
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

        let avatar = avatar(
            in: app,
            labeled: "SLICC: unknown, context fill unknown. The leader is busy — hang on…")
        XCTAssertTrue(avatar.waitForExistence(timeout: 60), "A stall should remain in the avatar")
        XCTAssertFalse(
            avatar.label.contains("Disconnected"),
            "A stall is not a disconnect and must not read as one")
    }

    /// A stall has to refuse the SEND, or a typed message is accepted into a
    /// channel that cannot deliver it — while the composer itself stays
    /// typable, because disabling it moves the keyboard around (see
    /// `ComposerKeyboardUITests`).
    func testAStallRefusesTheSendAndSaysWhy() {
        let app = launchApp(forcing: "stalled")

        let placeholder = app.staticTexts["composer-placeholder"]
        XCTAssertTrue(placeholder.waitForExistence(timeout: 60))
        XCTAssertEqual(placeholder.label, "The leader is busy — hang on…")
        XCTAssertFalse(app.buttons["composer-send"].isEnabled)
    }

    /// A transient reconnect must show progress, so it does not read as a hang.
    func testReconnectingShowsWhichAttemptIsInFlight() {
        let app = launchApp(forcing: "reconnecting")

        let avatar = avatar(
            in: app,
            labeled: "SLICC: unknown, context fill unknown. Reconnecting… (3/10)")
        XCTAssertTrue(avatar.waitForExistence(timeout: 60))
        XCTAssertEqual(app.staticTexts["composer-placeholder"].label, "Disconnected")
    }

    /// Exhausting the budget is terminal and returns to the actionable Settings route.
    func testGivingUpReturnsToSettings() {
        let app = launchApp(forcing: "gaveUp")

        XCTAssertTrue(
            app.navigationBars["Settings"].waitForExistence(timeout: 60),
            "Giving up should return to Settings instead of inserting a transcript banner")
        XCTAssertFalse(app.staticTexts["connection-status"].exists)
    }

    func testChangingToANonConnectedStateDoesNotShiftTheTranscript() {
        let connectedApp = launchApp(forcing: "connected", completedTurn: true)
        let connectedAvatar = connectedApp.descendants(matching: .any)["scoop-avatar"].firstMatch
        XCTAssertTrue(connectedAvatar.waitForExistence(timeout: 60))
        let connectedAvatarCenterX = connectedAvatar.frame.midX
        let connectedRow = connectedApp.descendants(matching: .any)["message-ui-test-reply"]
            .firstMatch
        XCTAssertTrue(connectedRow.waitForExistence(timeout: 60))
        let connectedFrame = connectedRow.frame
        connectedApp.terminate()

        let failedApp = launchApp(forcing: "failed", completedTurn: true)
        let failedAvatar = avatar(in: failedApp, containing: "Connection Failed")
        XCTAssertTrue(failedAvatar.waitForExistence(timeout: 60))
        XCTAssertEqual(
            failedAvatar.frame.midX, connectedAvatarCenterX, accuracy: 0.5,
            "Connection treatment must not move the avatar horizontally")

        let failedRow = failedApp.descendants(matching: .any)["message-ui-test-reply"].firstMatch
        XCTAssertTrue(failedRow.waitForExistence(timeout: 10))
        XCTAssertEqual(
            failedRow.frame, connectedFrame,
            "Connection state belongs in the avatar and must produce zero transcript layout shift")
    }

    // MARK: - Helpers

    /// `joinUrl` is passed explicitly and empty so a value persisted by another
    /// test cannot start a real connection underneath the forced state.
    private func launchApp(forcing state: String, completedTurn: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-uiTestConnectionState", state,
            "-joinUrl", "",
        ]
        if completedTurn {
            app.launchArguments += ["-uiTestCompletedTurn", "YES"]
        }
        app.launch()
        return app
    }

    private func avatar(in app: XCUIApplication, labeled label: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(identifier: "scoop-avatar")
            .matching(NSPredicate(format: "label == %@", label))
            .firstMatch
    }

    private func avatar(in app: XCUIApplication, containing text: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(identifier: "scoop-avatar")
            .matching(NSPredicate(format: "label CONTAINS %@", text))
            .firstMatch
    }
}
