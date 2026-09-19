import UIKit
import XCTest
















final class TranscriptComposerGrowthUITests: XCTestCase {

    
    
    
    
    
    private let allowedDrift: CGFloat = 60

    private let anchorId = "message-fx-delegation-1"

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    
    
    
    
    
    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
        super.tearDown()
    }

    

    func testHistoryStaysPutWhenTheComposerAndKeyboardClaimSpace() throws {
        try assertHistoryStaysPut(orientation: .portrait)
    }

    
    
    
    
    func testHistoryStaysPutInLandscape() throws {
        
        
        
        
        
        
        try XCTSkipUnless(
            UIDevice.current.userInterfaceIdiom == .pad,
            "landscape drift is measured on iPad; a phone's landscape "
                + "transcript is too short to hold a centred reading position")
        try assertHistoryStaysPut(orientation: .landscapeLeft)
    }

    private func assertHistoryStaysPut(orientation: UIDeviceOrientation) throws {
        let app = launchWithTranscript()
        XCUIDevice.shared.orientation = orientation
        Thread.sleep(forTimeInterval: 1.5)

        let anchor = app.descendants(matching: .any)
            .matching(identifier: anchorId).firstMatch
        waitForSeededTranscript(app)

        
        
        
        
        
        scrollBackUntilAnchorIsCentred(app: app, anchor: anchor)
        let afterScroll = anchor.frame.midY
        attach(app, name: "1-after-reader-scroll-\(orientation.rawValue)")

        let composer = focusedComposer(app)
        
        
        
        
        Thread.sleep(forTimeInterval: 1.5)
        let afterKeyboard = anchor.frame.midY
        attach(app, name: "2-keyboard-up-\(orientation.rawValue)")
        report("keyboard", orientation: orientation, drift: afterKeyboard - afterScroll)
        XCTAssertLessThan(
            abs(afterKeyboard - afterScroll), allowedDrift,
            "the keyboard's inset threw the reader through the history "
                + "(moved \(afterKeyboard - afterScroll)pt)")

        type("x", into: composer, app: app)
        Thread.sleep(forTimeInterval: 0.5)
        report("first keystroke", orientation: orientation, drift: anchor.frame.midY - afterScroll)
        XCTAssertLessThan(
            abs(anchor.frame.midY - afterScroll), allowedDrift,
            "the first keystroke threw the reader through the history "
                + "(moved \(anchor.frame.midY - afterScroll)pt)")

        type(
            " and now a great deal more text that wraps onto four separate lines",
            into: composer, app: app)
        Thread.sleep(forTimeInterval: 0.5)
        attach(app, name: "3-composer-grown-\(orientation.rawValue)")
        report("composer growth", orientation: orientation, drift: anchor.frame.midY - afterScroll)
        XCTAssertLessThan(
            abs(anchor.frame.midY - afterScroll), allowedDrift,
            "growing the composer threw the reader through the history "
                + "(moved \(anchor.frame.midY - afterScroll)pt)")
    }

    
    
    
    
    func testTranscriptStillFollowsANewlySentMessage() throws {
        let app = launchWithTranscript()
        waitForSeededTranscript(app)

        let composer = focusedComposer(app)
        let sent = "does the transcript follow me"
        type(sent, into: composer, app: app)

        tapSend(app)

        let sentBubble = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] %@", sent)
        ).firstMatch
        XCTAssertTrue(
            sentBubble.waitForExistence(timeout: 10),
            "the sent message should be in the transcript")
        
        
        
        XCTAssertTrue(
            sentBubble.isHittable,
            "the transcript must scroll to a newly sent message, not leave it below the fold")
    }

    
    
    
    
    
    
    func testAnIncomingMessageDoesNotYankAReaderOutOfTheHistory() throws {
        let appendAfter: Double = 15
        let app = launchWithTranscript(appendAfterSeconds: appendAfter)
        let anchor = app.descendants(matching: .any)
            .matching(identifier: anchorId).firstMatch
        waitForSeededTranscript(app)

        scrollBackUntilAnchorIsCentred(app: app, anchor: anchor)
        let beforeIncoming = anchor.frame.midY

        
        
        
        
        Thread.sleep(forTimeInterval: appendAfter + 8)

        XCTAssertTrue(anchor.exists, "the reader's row must survive an incoming message")
        XCTAssertLessThan(
            abs(anchor.frame.midY - beforeIncoming), allowedDrift,
            "an incoming message yanked the reader out of the history "
                + "(moved \(anchor.frame.midY - beforeIncoming)pt)")

        
        
        let incoming = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "arrived while you were reading back")
        ).firstMatch
        let low = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))
        let high = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.20))
        for _ in 0..<12 where !incoming.exists {
            low.press(
                forDuration: 0.1, thenDragTo: high, withVelocity: .slow,
                thenHoldForDuration: 0)
        }
        XCTAssertTrue(
            incoming.exists,
            "the scheduled incoming message should have reached the transcript")
    }

    

    
    
    
    
    
    
    func testALongTranscriptSurvivesTheKeyboardLanding() throws {
        let app = launchWithTranscript(repeatCount: 60)
        waitForSeededTranscript(app)
        XCTAssertGreaterThan(visibleRowCount(app), 0, "precondition: rows on screen at launch")

        _ = focusedComposer(app)
        Thread.sleep(forTimeInterval: 1.5)
        attach(app, name: "long-transcript-keyboard-up")
        XCTAssertGreaterThan(
            visibleRowCount(app), 0,
            "the transcript went blank when the keyboard claimed its space")
    }

    
    
    
    
    func testASentMessageIsVisibleInALongTranscript() throws {
        let app = launchWithTranscript(repeatCount: 60)
        waitForSeededTranscript(app)

        let composer = focusedComposer(app)
        let sent = "is my own message on screen"
        type(sent, into: composer, app: app)
        tapSend(app)

        let sentBubble = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] %@", sent)
        ).firstMatch
        XCTAssertTrue(
            sentBubble.waitForExistence(timeout: 10),
            "the sent message should be materialized, not lost in a blank transcript")
        attach(app, name: "long-transcript-sent")
        XCTAssertTrue(sentBubble.isHittable, "the sent message must be on screen")
    }

    
    
    private func visibleRowCount(_ app: XCUIApplication) -> Int {
        let window = app.windows.firstMatch.frame
        return app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "message-"))
            .allElementsBoundByIndex
            .filter { $0.frame.height > 0 && window.intersects($0.frame) }
            .count
    }

    

    
    
    
    
    
    
    
    
    
    
    private func type(_ text: String, into composer: XCUIElement, app: XCUIApplication) {
        let before = (composer.value as? String) ?? ""
        app.typeText(text)
        let after = (composer.value as? String) ?? ""
        XCTAssertTrue(
            after.contains(text.trimmingCharacters(in: .whitespaces)),
            "typing should reach the composer (before: '\(before)', after: '\(after)')")
    }

    
    
    
    
    
    
    private func tapSend(_ app: XCUIApplication) {
        let send = app.buttons["composer-send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "send button should exist")
        let enabled = expectation(
            for: NSPredicate(format: "isEnabled == true"), evaluatedWith: send)
        wait(for: [enabled], timeout: 10)
        send.tap()
    }

    
    
    
    
    
    private func focusedComposer(_ app: XCUIApplication) -> XCUIElement {
        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "composer should exist")
        composer.tap()
        XCTAssertTrue(
            app.keyboards.firstMatch.waitForExistence(timeout: 10),
            "tapping the composer should raise the keyboard")
        return composer
    }

    
    
    
    
    
    
    
    
    private func waitForSeededTranscript(_ app: XCUIApplication) {
        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 30), "composer should render")
        let anyRow = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "message-fx-"))
            .firstMatch
        XCTAssertTrue(
            anyRow.waitForExistence(timeout: 30),
            "the fixture transcript should have seeded")
    }

    private func report(_ step: String, orientation: UIDeviceOrientation, drift: CGFloat) {
        let side = orientation == .portrait ? "portrait" : "landscape"
        print("DRIFT \(side) after \(step): \(drift)pt")
    }

    
    private func attach(_ app: XCUIApplication, name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .deleteOnSuccess
        add(shot)
    }

    
    
    
    
    
    
    
    
    
    private func scrollBackUntilAnchorIsCentred(app: XCUIApplication, anchor: XCUIElement) {
        
        
        
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.20))
        let bottom = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))

        
        
        
        
        
        let viewport = app.windows.firstMatch.frame
        let lowerBound = viewport.height * 0.20
        let upperBound = viewport.height * 0.72

        for _ in 0..<20 {
            
            
            
            
            
            
            if anchor.exists {
                let frame = anchor.frame
                if frame.height > 0, frame.midY > lowerBound, frame.midY < upperBound { break }
            }
            
            
            top.press(
                forDuration: 0.1, thenDragTo: bottom, withVelocity: .slow,
                thenHoldForDuration: 0)
        }
        Thread.sleep(forTimeInterval: 1.0)
        XCTAssertTrue(
            anchor.exists && anchor.frame.height > 0,
            "anchor row should be on screen to measure against")
    }

    
    
    
    
    private func launchWithTranscript(
        appendAfterSeconds: Double? = nil, repeatCount: Int? = nil
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "",
            "-uiTestConnectionState", "connected",
            "-uiTestTranscriptFixture", "YES",
        ]
        if let repeatCount {
            app.launchArguments += [
                "-uiTestTranscriptRepeat", String(repeatCount), "-uiTestTranscriptTallTail", "YES",
            ]
        }
        if let appendAfterSeconds {
            app.launchArguments += [
                "-uiTestTranscriptAppendAfter", String(appendAfterSeconds),
            ]
        }
        app.launch()
        return app
    }
}
