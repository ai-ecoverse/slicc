import XCTest

/// The dock's monitor surface (#1868): session vitals from tray state.
final class MonitorUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testMonitorShowsConnectionAndCost() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "connected",
            "-uiTestOpenDockSurface", "monitor",
        ]
        app.launch()

        XCTAssertTrue(
            app.staticTexts["Participants"].waitForExistence(timeout: 60),
            "the monitor renders connection vitals, not a placeholder")
        XCTAssertTrue(
            app.staticTexts["monitor-cost-total"].exists,
            "session cost is summed from message usage")
    }
}
