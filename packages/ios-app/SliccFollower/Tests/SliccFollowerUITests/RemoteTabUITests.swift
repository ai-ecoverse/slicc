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

    /// The remote-only state must offer a working local-tab path (#1916):
    /// visible affordance → URL prompt → live WKWebView target, with the
    /// remote previews surviving the transition.
    func testRemoteOnlyStateOpensLocalTab() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "connected",
            "-uiTestOpenDockSurface", "browser",
            "-uiTestRemoteTargetsFixture", "YES",
        ]
        app.launch()

        XCTAssertTrue(
            app.staticTexts["SLICC docs — architecture"].waitForExistence(timeout: 60),
            "the remote-only state renders before any local tab exists")

        let openNewTab = app.buttons["browser-open-new-tab"].firstMatch
        XCTAssertTrue(
            openNewTab.waitForExistence(timeout: 10),
            "the remote-only state carries the local-tab affordance in its content")
        XCTAssertTrue(
            openNewTab.isHittable,
            "the affordance is directly tappable, not buried in a toolbar overflow")
        XCTAssertFalse(
            app.buttons["settings-button"].exists,
            "the covered conversation's toolbar no longer bleeds into the browser surface")

        openNewTab.tap()
        let prompt = app.alerts["New tab"]
        XCTAssertTrue(
            prompt.waitForExistence(timeout: 10),
            "tapping the affordance presents the URL prompt")
        // Untouched "https://" input normalizes to about:blank — hermetic,
        // no network needed for the WKWebView to go live.
        prompt.buttons["Open"].tap()

        XCTAssertTrue(
            app.staticTexts["browser-local-tab-title"].firstMatch.waitForExistence(timeout: 30),
            "opening a URL creates and displays a live local WKWebView target")
        XCTAssertTrue(
            app.staticTexts["SLICC docs — architecture"].waitForExistence(timeout: 10),
            "remote preview cards remain available after creating a local tab")
    }
}
