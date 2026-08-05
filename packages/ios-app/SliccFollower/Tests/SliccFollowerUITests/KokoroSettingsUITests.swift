import XCTest

final class KokoroSettingsUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testEnablingKokoroRequiresSizeAndWiFiConsent() {
        let app = launchSettings(kokoroState: "not-installed")
        XCTAssertFalse(app.descendants(matching: .any)["speech-voice-picker"].exists)
        XCTAssertFalse(app.staticTexts["speech-voice-install-guidance"].exists)
        let enable = app.buttons["kokoro-install-toggle"]
        reveal(enable, in: app)

        enable.tap()

        let status = app.staticTexts["kokoro-install-status"]
        reveal(status, in: app)
        XCTAssertTrue(status.label.contains("83 MB"))
        XCTAssertTrue(status.label.contains("Wi-Fi"))
        XCTAssertTrue(app.buttons["kokoro-download-confirm"].waitForExistence(timeout: 10))
    }

    func testDownloadProgressAndCancellationAreVisible() {
        let app = launchSettings(kokoroState: "downloading")
        let progress = app.progressIndicators["kokoro-download-progress"]
        reveal(progress, in: app)

        XCTAssertTrue(app.staticTexts["kokoro-install-status"].label.contains("42%"))
        reveal(app.buttons["kokoro-download-cancel"], in: app)
    }

    func testTypedFailureShowsRetryAndSystemVoiceFallback() {
        let app = launchSettings(kokoroState: "failed")
        let failure = app.staticTexts["kokoro-install-failure"]
        reveal(failure, in: app)

        XCTAssertTrue(failure.label.contains("Connect to Wi-Fi"))
        XCTAssertTrue(app.staticTexts["kokoro-install-status"].label.contains("system voice"))
        reveal(app.buttons["kokoro-install-retry"], in: app)
    }

    private func launchSettings(kokoroState: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "",
            "-uiTestKokoroState", kokoroState,
        ]
        app.launch()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 60))
        return app
    }

    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<6 where !element.exists {
            app.swipeUp()
        }
        XCTAssertTrue(element.waitForExistence(timeout: 10))
    }
}
