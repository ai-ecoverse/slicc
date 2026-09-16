import XCTest

final class FixtureConversationUITests: XCTestCase {

    private static let expectedMessageIds: Set<String> = [
        "fx-user-1",
        "fx-assistant-1",
        "fx-user-2",
        "fx-assistant-2",
        "fx-assistant-sprinkle",
        "fx-assistant-sprinkle-bare",
        "fx-assistant-3",
        "fx-assistant-mgmt",
        "fx-delegation-1",
        "fx-assistant-delegated",
        "fx-lick-webhook",
        "fx-lick-cron",
        "fx-lick-sprinkle",
        "fx-lick-fswatch",
        "fx-lick-navigate",
        "fx-lick-upgrade",
        "fx-lick-collated",
        "fx-lick-confirmed",
        "fx-lick-dismissed",
        "fx-user-attachments",
        "fx-user-attachment-only",
        "fx-assistant-error",

        "fx-assistant-progress",
        "fx-assistant-progress-cluster",

        "fx-compaction-idle",
        "fx-compaction-threshold-running",
        "fx-compaction-fallback",
        "fx-queued-1",
        "fx-assistant-streaming",
    ]

    private static let newestFixtureMessageId = "fx-assistant-streaming"

    private static let variantMarkers = [
        "Working",
        "edit: error",
        "bash: running",
        "list scoops",
        "github-push",
        "src-watch",
        "0.4.1→0.5.0",
        "Instructions from sliccy",
        "npm run test",
        "deploy-status \u{00D7}3",
        "SOMETHING WENT WRONG",
        "screenshot.png",
        "diagram.png",
        "Allow npm publish?",
        "Waiting for approval on the leader",
        "SWIPE_ARBITRATION_CODE_BLOCK_TRAILING_EDGE_MARKER",
        "embedded follower garnish",

        "Compacted while idle. Full transcript /sessions/live-cone-fixture-8egf.md",
        "Context filling up — compacting history. Full transcript /sessions/live-cone-fixture-8egf.md",
        "Summary unavailable — older messages truncated",
    ]

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testFixtureConversationRendersWithoutALeader() {
        let app = launchFixtureApp()

        XCTAssertTrue(
            app.staticTexts["fixture-header"].waitForExistence(timeout: 60),
            "The fixture route should render without a leader attached")
        XCTAssertTrue(
            app.buttons["Reload"].waitForExistence(timeout: 30),
            "The fixture chrome should offer a reload control")

        XCTAssertFalse(
            app.staticTexts["connection-status"].exists,
            "The fixture route should not show a connection pill")
    }

    func testEveryFixtureMessageVariantRenders() {
        let app = launchFixtureApp()
        XCTAssertTrue(
            app.staticTexts["fixture-header"].waitForExistence(timeout: 60),
            "The fixture route should render before scrolling")
        XCTAssertTrue(
            waitForListToSettleAtBottom(in: app),
            "The list should settle on its newest message before the walk starts")

        var seenIds = visibleMessageIds(in: app)
        var seenLabels = visibleLabels(in: app)
        var previousScreen = seenIds.union(seenLabels)
        var unchangedScrolls = 0

        for _ in 0..<40 where !isComplete(ids: seenIds, labels: seenLabels) {
            app.swipeDown()
            let ids = visibleMessageIds(in: app)
            let labels = visibleLabels(in: app)
            seenIds.formUnion(ids)
            seenLabels.formUnion(labels)

            let screen = ids.union(labels)
            unchangedScrolls = screen == previousScreen ? unchangedScrolls + 1 : 0
            previousScreen = screen

            if unchangedScrolls >= 4 { break }
        }

        XCTAssertEqual(
            seenIds, Self.expectedMessageIds,
            "Fixture rows never rendered: "
                + "\(Self.expectedMessageIds.subtracting(seenIds).sorted())")
        XCTAssertEqual(
            missingMarkers(in: seenLabels), [],
            "Variant renderers produced no output; the row can still carry its "
                + "id while its specialized subview is gone")
    }

    func testSettledLicksShowTheirDecisionGlyph() {
        let app = launchFixtureApp()
        XCTAssertTrue(
            app.staticTexts["fixture-header"].waitForExistence(timeout: 60),
            "The fixture route should render before scrolling")
        XCTAssertTrue(
            waitForAnyMessageRow(in: app),
            "Rows should be on screen before the walk starts")

        var seen = visibleStateIdentifiers(in: app)
        for _ in 0..<40 where !seen.isSuperset(of: ["lick-state-confirmed", "lick-state-dismissed"]) {
            app.swipeDown()
            let before = seen.count
            seen.formUnion(visibleStateIdentifiers(in: app))
            if seen.count == before && seen.count > 0 { break }
        }

        XCTAssertTrue(
            seen.contains("lick-state-confirmed"),
            "A confirmed lick should render its decision glyph")
        XCTAssertTrue(
            seen.contains("lick-state-dismissed"),
            "A dismissed lick should render its decision glyph")

        XCTAssertFalse(
            seen.contains("lick-state-pending"),
            "A pending lick should render no decision glyph")
    }

    func testReloadRebuildsTheTranscript() {
        let app = launchFixtureApp()
        XCTAssertTrue(
            app.staticTexts["fixture-header"].waitForExistence(timeout: 60),
            "The fixture route should render before reloading")
        XCTAssertTrue(
            waitForAnyMessageRow(in: app),
            "The transcript should be populated before reloading")

        app.buttons["Reload"].tap()

        XCTAssertTrue(
            app.staticTexts["fixture-header"].waitForExistence(timeout: 30),
            "Reload should leave the header on its default copy")
        XCTAssertTrue(
            waitForAnyMessageRow(in: app),
            "Reload should rebuild the fixture transcript")
    }

    func testCodeBlockScrollUsesRubberBandScoopHandoff() {
        let app = launchFixtureApp()
        let selection = app.staticTexts["fixture-scoop-selection"]
        XCTAssertTrue(selection.waitForExistence(timeout: 60))
        XCTAssertEqual(selection.label, "Fixture scoop 1")
        XCTAssertTrue(waitForListToSettleAtBottom(in: app))

        let codeBlock = app.staticTexts.matching(
            NSPredicate(
                format: "label CONTAINS %@",
                "SWIPE_ARBITRATION_CODE_BLOCK_TRAILING_EDGE_MARKER")
        ).firstMatch
        let ordinaryText = app.staticTexts.matching(
            NSPredicate(format: "label == %@", "A fenced code block:")
        ).firstMatch

        for _ in 0..<12 where !(codeBlock.isHittable && ordinaryText.isHittable) {
            app.swipeDown()
        }
        XCTAssertTrue(codeBlock.isHittable, "The overflowing code-block renderer should appear")
        XCTAssertTrue(ordinaryText.isHittable, "The ordinary-text control should appear")

        let leadingEdgeX = codeBlock.frame.minX
        dragLeft(across: codeBlock, in: app)

        XCTAssertEqual(
            selection.label, "Fixture scoop 1",
            "A code block with room to scroll must keep the current scoop")
        XCTAssertLessThan(
            codeBlock.frame.minX, leadingEdgeX - 20,
            "The guarded drag must still scroll the code block")

        for _ in 0..<3 where selection.label == "Fixture scoop 1" {
            dragLeft(across: codeBlock, in: app)
        }
        XCTAssertTrue(
            waitForLabel("Fixture scoop 2", on: selection),
            "At the trailing edge the same drag must hand off to scoop navigation; "
                + "gesture diagnostic: \(String(describing: selection.value))")

        dragLeft(across: ordinaryText, in: app)
        XCTAssertTrue(
            waitForLabel("Fixture scoop 3", on: selection),
            "Ordinary transcript text must not suppress scoop navigation")
    }

    private func launchFixtureApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-uiTestFixtureRoute", "YES",
            "-joinUrl", "",
        ]
        app.launch()
        return app
    }

    private func waitForListToSettleAtBottom(in app: XCUIApplication, timeout: TimeInterval = 30)
        -> Bool
    {
        app.descendants(matching: .any)
            .matching(
                NSPredicate(format: "identifier == %@", "message-\(Self.newestFixtureMessageId)")
            )
            .firstMatch
            .waitForExistence(timeout: timeout)
    }

    private func waitForAnyMessageRow(in app: XCUIApplication, timeout: TimeInterval = 30) -> Bool {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "message-"))
            .firstMatch
            .waitForExistence(timeout: timeout)
    }

    private func visibleMessageIds(in app: XCUIApplication) -> Set<String> {
        let prefix = "message-"
        let rows = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix))
        return Set(
            rows.allElementsBoundByAccessibilityElement
                .map { String($0.identifier.dropFirst(prefix.count)) })
    }

    private func visibleLabels(in app: XCUIApplication) -> Set<String> {
        var labels = Set<String>()
        labels.formUnion(app.staticTexts.allElementsBoundByAccessibilityElement.map(\.label))
        labels.formUnion(app.buttons.allElementsBoundByAccessibilityElement.map(\.label))
        return labels
    }

    private func visibleStateIdentifiers(in app: XCUIApplication) -> Set<String> {
        let rows = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "lick-state-"))
        return Set(rows.allElementsBoundByAccessibilityElement.map(\.identifier))
    }

    private func missingMarkers(in labels: Set<String>) -> [String] {
        Self.variantMarkers.filter { marker in
            !labels.contains { $0.contains(marker) }
        }
    }

    private func isComplete(ids: Set<String>, labels: Set<String>) -> Bool {
        ids == Self.expectedMessageIds && missingMarkers(in: labels).isEmpty
    }

    private func dragLeft(across element: XCUIElement, in app: XCUIApplication) {
        let visibleFrame = element.frame.intersection(app.frame)
        XCTAssertGreaterThan(visibleFrame.width, 100, "Drag target must expose a horizontal span")

        let chatTrailingEdge = app.frame.maxX - 48
        let origin = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
        let start = origin.withOffset(
            CGVector(dx: min(visibleFrame.maxX, chatTrailingEdge) - 12, dy: visibleFrame.midY))
        let end = origin.withOffset(
            CGVector(dx: visibleFrame.minX + 12, dy: visibleFrame.midY))
        start.press(forDuration: 0.05, thenDragTo: end)
    }

    private func waitForLabel(
        _ label: String,
        on element: XCUIElement,
        timeout: TimeInterval = 5
    ) -> Bool {
        XCTWaiter.wait(
            for: [
                XCTNSPredicateExpectation(
                    predicate: NSPredicate(format: "label == %@", label),
                    object: element)
            ],
            timeout: timeout
        ) == .completed
    }
}
