import XCTest

/// UI coverage for the two launch states that do not need a leader: no stored
/// join URL (Settings sheet) and an unreachable one (failed connection).
final class ConnectionRouteUITests: XCTestCase {

    /// Refused on connect rather than left hanging: port 1 on the loopback
    /// interface needs no DNS and no network, so `attach()` throws on the first
    /// attempt and `AppState` settles on `.failed` fast. A public host would
    /// make this test depend on CI egress and on retry timing.
    private static let unreachableJoinUrl = "http://127.0.0.1:1/join/ui-test"

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testSettingsSheetOpensWhenNoJoinUrlIsStored() {
        let app = XCUIApplication()
        app.launchArguments += ["-joinUrl", ""]
        app.launch()

        XCTAssertTrue(
            app.navigationBars["Settings"].waitForExistence(timeout: 60),
            "An empty join URL should open the Settings sheet on launch")
        XCTAssertTrue(
            app.buttons["Done"].exists,
            "The Settings sheet should offer its dismiss control")
    }

    func testConnectionPillReportsFailureForAnUnreachableLeader() {
        let app = XCUIApplication()
        app.launchArguments += ["-joinUrl", Self.unreachableJoinUrl]
        app.launch()

        let pill = app.staticTexts["connection-status"]
        XCTAssertTrue(
            pill.waitForExistence(timeout: 30),
            "A stored join URL should skip Settings and show the status pill")

        // The pill passes through "Connecting…" first, so wait for the settled
        // state rather than asserting on whatever is on screen at first sight.
        let failed = NSPredicate(format: "label == %@", "Connection Failed")
        expectation(for: failed, evaluatedWith: pill)
        waitForExpectations(timeout: 60)
    }
}
