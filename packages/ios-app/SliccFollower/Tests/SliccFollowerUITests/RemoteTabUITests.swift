import XCTest

/// Federated remote-tab preview cards on the browser surface (#1865).
final class RemoteTabUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testRemoteTargetsRenderPreviewCards() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "connected",
            "-uiTestOpenDockSurface", "browser",
            "-uiTestRemoteTargetsFixture", "YES",
        ]
        app.launch()

        XCTAssertTrue(
            app.staticTexts["SLICC docs — architecture"].waitForExistence(timeout: 60),
            "remote registry entries render as cards")
        XCTAssertTrue(
            app.images["remote-preview-leader:tab-docs"].waitForExistence(timeout: 10),
            "leader tabs get preview screenshots")
    }
}
