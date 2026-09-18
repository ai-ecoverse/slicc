import XCTest




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

        
        
        
        composer.tap()
        composer.typeText("typed, not spoken")

        
        
        XCTAssertTrue((composer.value as? String)?.contains("typed, not spoken") == true)
        XCTAssertFalse(
            app.staticTexts["should never appear"].exists,
            "a quick tap must never trigger dictation")
    }
}
