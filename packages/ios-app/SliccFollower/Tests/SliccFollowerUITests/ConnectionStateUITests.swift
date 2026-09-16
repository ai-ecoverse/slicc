import XCTest

final class ConnectionStateUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testAStalledLeaderSaysSoInsteadOfClaimingDisconnection() {
        let app = launchApp(forcing: "stalled")

        let avatar = avatar(
            in: app,
            labeled: "Sliccy: unknown, context fill unknown. The leader is busy — hang on…")
        XCTAssertTrue(avatar.waitForExistence(timeout: 60), "A stall should remain in the avatar")
        XCTAssertFalse(
            avatar.label.contains("Disconnected"),
            "A stall is not a disconnect and must not read as one")
    }

    func testAStallRefusesTheSendAndSaysWhy() {
        let app = launchApp(forcing: "stalled")

        let placeholder = app.staticTexts["composer-placeholder"]
        XCTAssertTrue(placeholder.waitForExistence(timeout: 60))
        XCTAssertEqual(placeholder.label, "The leader is busy — hang on…")
        XCTAssertFalse(app.buttons["composer-send"].isEnabled)
    }

    func testReconnectingShowsWhichAttemptIsInFlight() {
        let app = launchApp(forcing: "reconnecting")

        let avatar = avatar(
            in: app,
            labeled: "Sliccy: unknown, context fill unknown. Reconnecting… (3/10)")
        XCTAssertTrue(avatar.waitForExistence(timeout: 60))
        XCTAssertEqual(app.staticTexts["composer-placeholder"].label, "Disconnected")
    }

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
