import XCTest

/// Push-to-talk end to end against the scripted DEBUG engine
/// (`-uiTestSpeechPermission` / `-uiTestSpeechScript`) — no microphone, no
/// system permission prompt, no leader.
final class PttUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testHoldDictatesAndSubmitsTheTranscript() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "",
            "-uiTestConnectionState", "connected",
            "-uiTestSpeechPermission", "granted",
            "-uiTestSpeechScript", "hello from dictation",
        ]
        app.launch()

        let surface = app.otherElements["ptt-surface"]
        XCTAssertTrue(surface.waitForExistence(timeout: 60))

        // Hold well past the 400 ms engage window; the scripted engine
        // streams the transcript while held, release commits + submits it.
        surface.press(forDuration: 1.5)

        XCTAssertTrue(
            app.staticTexts["hello from dictation"].waitForExistence(timeout: 10),
            "the dictated transcript should submit as a user message")
    }

    func testBlockedPermissionNeverSubmits() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "",
            "-uiTestConnectionState", "connected",
            "-uiTestSpeechPermission", "denied",
            "-uiTestSpeechScript", "should never appear",
        ]
        app.launch()

        let surface = app.otherElements["ptt-surface"]
        XCTAssertTrue(surface.waitForExistence(timeout: 60))

        surface.press(forDuration: 1.5)

        // The hold surfaced the blocked overlay (not observable after
        // release) — what matters is that nothing was heard or sent.
        XCTAssertFalse(
            app.staticTexts["should never appear"].waitForExistence(timeout: 3),
            "a blocked microphone must never produce a message")
        XCTAssertTrue(surface.exists, "the composer stays empty and armed")
    }

    func testQuickTapStillFocusesTheComposer() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "",
            "-uiTestConnectionState", "connected",
            "-uiTestSpeechPermission", "granted",
            "-uiTestSpeechScript", "should never appear",
        ]
        app.launch()

        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 60))

        // A plain tap lands on the press surface (it overlays the empty
        // composer) and must forward to focus — the pre-PTT behavior every
        // other composer test relies on.
        composer.tap()
        composer.typeText("typed, not spoken")

        // typeText itself fails without focus, and the value proves the tap
        // forwarded to the editor instead of arming dictation.
        XCTAssertTrue((composer.value as? String)?.contains("typed, not spoken") == true)
        XCTAssertFalse(
            app.staticTexts["should never appear"].exists,
            "a quick tap must never trigger dictation")
    }
}
