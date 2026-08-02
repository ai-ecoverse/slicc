import XCTest

/// The send-while-streaming affordance: absent when no turn runs, present
/// (with the "Interrupt & send" long-press menu) while one does. Driven by
/// the `-uiTestConnectionState streaming` hook — no leader involved.
final class SteerUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testSteerAffordanceOnlyExistsWhileStreaming() {
        let app = XCUIApplication()
        app.launchArguments += ["-joinUrl", "", "-uiTestConnectionState", "streaming"]
        app.launch()

        // The forced state connects without a sheet; the composer is usable.
        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 60))

        // With an empty composer there is nothing to send — stop only.
        XCTAssertFalse(app.buttons["send-while-streaming"].exists)

        composer.tap()
        composer.typeText("actually, look at the failing test first")

        let send = app.buttons["send-while-streaming"]
        XCTAssertTrue(
            send.waitForExistence(timeout: 10),
            "A non-empty composer during a running turn should offer send")

        // Long-press reveals the interrupt option (Menu primaryAction keeps
        // plain tap as the queueing send). Under CI load a context menu can
        // eat the first press without opening (load-dependent, seen only on
        // busy simulator clones), so give it one more before judging.
        send.press(forDuration: 1.0)
        if !app.buttons["Interrupt & send"].waitForExistence(timeout: 10) {
            send.press(forDuration: 1.2)
        }
        XCTAssertTrue(
            app.buttons["Interrupt & send"].waitForExistence(timeout: 10),
            "The long-press menu should offer the steer action")
    }

    func testNoSteerAffordanceWhenIdle() {
        let app = XCUIApplication()
        app.launchArguments += ["-joinUrl", "", "-uiTestConnectionState", "connected"]
        app.launch()

        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 60))
        composer.tap()
        composer.typeText("hello")

        XCTAssertFalse(
            app.buttons["send-while-streaming"].exists,
            "The streaming send affordance must not exist while idle")
    }
}
