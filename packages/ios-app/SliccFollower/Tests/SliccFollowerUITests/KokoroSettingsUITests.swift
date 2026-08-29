import XCTest

final class KokoroSettingsUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// The disclosure IS the consent. `requestInstallation()` downloads on the
    /// first tap by design (`SpeechSettingsSection`: "no second confirm step"),
    /// so the only thing that can carry consent is the size and the Wi-Fi-only
    /// rule being on screen *beside* the button, before it is pressed.
    ///
    /// This used to tap the button and wait for a `kokoro-download-confirm`
    /// that no build has ever rendered — and tapping it here would start a real
    /// 83 MB download on the runner. It went unnoticed because the class ran in
    /// no CI job (see `packages/ios-app/ui-test-exclusions.json`).
    func testEnablingKokoroRequiresSizeAndWiFiConsent() {
        let app = launchSettings(kokoroState: "not-installed")
        XCTAssertFalse(app.descendants(matching: .any)["speech-voice-picker"].exists)
        XCTAssertFalse(app.staticTexts["speech-voice-install-guidance"].exists)

        let enable = app.buttons["kokoro-install-toggle"]
        reveal(enable, in: app)

        let status = app.staticTexts["kokoro-install-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 10))
        XCTAssertTrue(
            status.label.contains("83 MB"),
            "the download size must be disclosed before the tap that starts it")
        XCTAssertTrue(
            status.label.contains("Wi-Fi"),
            "the Wi-Fi-only rule must be disclosed before the tap that starts it")

        // Frames, not `exists`. An element scrolled out of the viewport is still
        // in the accessibility hierarchy, so `exists` would keep passing if the
        // section grew and pushed the disclosure off screen — the one regression
        // this test is here to catch. An off-screen element reports a zero
        // frame, which intersects nothing.
        let viewport = app.windows.firstMatch.frame
        XCTAssertTrue(
            viewport.intersects(enable.frame),
            "the button that starts the download must be on screen")
        XCTAssertTrue(
            viewport.intersects(status.frame),
            "the size and Wi-Fi disclosure must be on screen WITH the button, not merely in the hierarchy")
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
