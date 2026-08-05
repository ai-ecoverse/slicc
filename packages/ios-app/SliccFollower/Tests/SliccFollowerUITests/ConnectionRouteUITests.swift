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
        // The sheet's chrome can lag its navigation bar on a loaded simulator,
        // so this waits rather than sampling once.
        XCTAssertTrue(
            app.buttons["Done"].waitForExistence(timeout: 30),
            "The Settings sheet should offer its dismiss control")
    }

    func testAvatarAndComposerReportFailureForAnUnreachableLeader() {
        let app = XCUIApplication()
        app.launchArguments += ["-joinUrl", Self.unreachableJoinUrl]
        app.launch()

        let avatar = app.descendants(matching: .any)
            .matching(identifier: "scoop-avatar")
            .matching(NSPredicate(format: "label CONTAINS %@", "Connection Failed"))
            .firstMatch
        XCTAssertTrue(
            avatar.waitForExistence(timeout: 60),
            "A launch Join URL should skip Settings and keep status in the avatar")

        XCTAssertEqual(app.staticTexts["composer-placeholder"].label, "Disconnected")
    }
}
