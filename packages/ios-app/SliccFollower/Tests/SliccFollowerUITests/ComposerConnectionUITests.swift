import XCTest








final class ComposerConnectionUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    
    
    
    
    func testTheComposerStaysTypableWhileDisconnected() {
        let app = launchApp(forcing: "failed")
        let composer = focusedComposer(in: app)

        composer.typeText("draft written while the leader is gone")

        XCTAssertTrue(
            (composer.value as? String)?.contains("draft written while the leader is gone")
                == true,
            "A disconnect must not refuse typing")
        XCTAssertFalse(
            app.buttons["composer-send"].isEnabled,
            "Sending is what an unusable leader blocks")
    }

    
    
    func testReachingTroubleDoesNotRaiseTheKeyboard() {
        let app = launchApp(connectedWithBlip: "1")

        XCTAssertTrue(
            troubledAvatar(in: app).waitForExistence(timeout: 60),
            "the staged drop should reach the avatar once the hold expires")
        XCTAssertEqual(
            app.keyboards.count, 0,
            "A connection change must never open the keyboard on its own")
    }

    
    
    
    func testADropKeepsTheComposerFocused() {
        let app = launchApp(connectedWithBlip: "3")
        let composer = focusedComposer(in: app)
        composer.typeText("before")

        XCTAssertTrue(troubledAvatar(in: app).waitForExistence(timeout: 60))
        composer.typeText(" and after")

        XCTAssertTrue(
            (composer.value as? String)?.contains("before and after") == true,
            "A drop must not take the keyboard from someone mid-sentence")
    }

    
    
    
    
    
    
    
    func testABlipOnAnEmptyComposerKeepsTheKeyboardUp() {
        
        
        
        
        let app = launchApp(connectedWithBlip: "3,3")
        let composer = focusedComposer(in: app)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))

        
        
        Thread.sleep(forTimeInterval: 9)

        XCTAssertTrue(
            app.keyboards.count > 0,
            "A blip must not dismiss the keyboard under an empty composer")
        composer.typeText("still focused")
        XCTAssertTrue(
            (composer.value as? String)?.contains("still focused") == true,
            "A blip must not take focus from an empty composer either")
    }

    

    
    
    private func launchApp(forcing state: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-joinUrl", "", "-uiTestConnectionState", state]
        app.launch()
        return app
    }

    
    
    
    
    private func launchApp(connectedWithBlip blip: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "",
            "-uiTestConnectionState", "connected",
            "-uiTestConnectionBlip", blip,
        ]
        app.launch()
        return app
    }

    
    
    private func troubledAvatar(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(identifier: "scoop-avatar")
            .matching(NSPredicate(format: "label CONTAINS %@", "Reconnecting"))
            .firstMatch
    }

    private func focusedComposer(in app: XCUIApplication) -> XCUIElement {
        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 60))
        composer.tap()
        return composer
    }
}
