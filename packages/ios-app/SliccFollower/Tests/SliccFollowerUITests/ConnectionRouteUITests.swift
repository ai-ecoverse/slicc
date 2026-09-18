import XCTest



final class ConnectionRouteUITests: XCTestCase {

    
    
    
    
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
