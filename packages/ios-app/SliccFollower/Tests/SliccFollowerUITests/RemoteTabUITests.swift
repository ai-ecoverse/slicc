import UIKit
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
            app.staticTexts["Sliccy docs — architecture"].waitForExistence(timeout: 60),
            "remote registry entries render as cards")
        XCTAssertTrue(
            app.images["remote-preview-leader:tab-docs"].waitForExistence(timeout: 10),
            "leader tabs get preview screenshots")
    }

    /// The remote-only overview must offer a working local-tab path
    /// (#1916), Safari-shaped: `+` opens the tab full screen (rail and
    /// navigation bar gone), the bottom address bar is the prompt, and the
    /// overview grid is where local and remote tabs meet again.
    func testRemoteOnlyStateOpensLocalTab() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "connected",
            "-uiTestOpenDockSurface", "browser",
            "-uiTestRemoteTargetsFixture", "YES",
        ]
        app.launch()

        XCTAssertTrue(
            app.staticTexts["Sliccy docs — architecture"].waitForExistence(timeout: 60),
            "the remote-only overview renders before any local tab exists")

        let openNewTab = app.buttons["browser-open-new-tab"].firstMatch
        XCTAssertTrue(
            openNewTab.waitForExistence(timeout: 10),
            "the overview carries the local-tab affordance in its content")
        XCTAssertTrue(
            openNewTab.isHittable,
            "the affordance is directly tappable, not buried in a toolbar overflow")
        XCTAssertFalse(
            app.buttons["settings-button"].exists,
            "the covered conversation's toolbar no longer bleeds into the browser surface")

        openNewTab.tap()
        let addressField = app.textFields["browser-address-field"].firstMatch
        XCTAssertTrue(
            addressField.waitForExistence(timeout: 10),
            "tapping + opens the tab full screen and offers its address field")
        XCTAssertFalse(
            app.buttons["dock-browser"].exists,
            "full-screen browsing hides the dock rail")
        // about:blank is hermetic — no network needed for the WKWebView to
        // go live. Typed rather than an empty submit: iOS disables the Go
        // key while a URL field is empty, exactly like Safari's.
        addressField.tap()
        addressField.typeText("about:blank\n")

        XCTAssertTrue(
            app.buttons["browser-address-display"].firstMatch.waitForExistence(timeout: 30),
            "committing shows the glass address pill over the live WKWebView")

        app.buttons["browser-show-tabs"].firstMatch.tap()
        XCTAssertTrue(
            app.staticTexts["browser-local-tab-title"].firstMatch.waitForExistence(timeout: 10),
            "the overview lists the local tab as a card")
        XCTAssertTrue(
            app.staticTexts["Sliccy docs — architecture"].waitForExistence(timeout: 10),
            "remote previews share the overview grid with local tabs")
        XCTAssertTrue(
            app.buttons["dock-browser"].waitForExistence(timeout: 10),
            "leaving full screen brings the dock rail back")
    }

    /// Tapping a remote preview card opens its URL as a local tab, full
    /// screen. Only entry into browsing mode is asserted — page load is
    /// network and stays out of the test.
    func testRemoteCardOpensLocally() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "connected",
            "-uiTestOpenDockSurface", "browser",
            "-uiTestRemoteTargetsFixture", "YES",
        ]
        app.launch()

        let card = app.staticTexts["Sliccy docs — architecture"].firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 60), "the overview lists the remote card")
        card.tap()

        XCTAssertTrue(
            app.buttons["browser-address-display"].firstMatch.waitForExistence(timeout: 10),
            "the remote tab's URL opens as a local full-screen tab")
        XCTAssertFalse(
            app.buttons["dock-browser"].exists,
            "full-screen browsing hides the dock rail")
    }

    /// Run on an iPad simulator: regular-width browsing must claim the whole
    /// window, then restore the conversation + rail when tabs are shown.
    func testRegularWidthBrowsingEntersAndExitsFullScreen() throws {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "connected",
            "-uiTestOpenDockSurface", "browser",
            "-uiTestRemoteTargetsFixture", "YES",
        ]
        app.launch()

        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 10))
        guard UIDevice.current.userInterfaceIdiom == .pad, window.frame.width > 560 else {
            throw XCTSkip("Requires a regular-width iPad simulator destination")
        }
        let remoteCard = app.staticTexts["Sliccy docs — architecture"].firstMatch
        XCTAssertTrue(remoteCard.waitForExistence(timeout: 60))
        XCTAssertTrue(app.buttons["settings-button"].exists, "the split starts with chat visible")
        XCTAssertTrue(app.buttons["dock-browser"].exists, "the split starts with its rail visible")

        remoteCard.tap()
        XCTAssertTrue(app.buttons["browser-address-display"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["settings-button"].exists, "full screen hides the conversation")
        XCTAssertFalse(app.buttons["dock-browser"].exists, "full screen hides the rail")

        app.buttons["browser-show-tabs"].firstMatch.tap()

        XCTAssertTrue(remoteCard.waitForExistence(timeout: 10), "the tabs button restores the overview")
        XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["dock-browser"].waitForExistence(timeout: 10))
    }
}
