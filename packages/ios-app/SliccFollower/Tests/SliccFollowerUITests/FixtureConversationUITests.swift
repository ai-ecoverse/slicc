import XCTest

/// UI coverage for the leaderless fixture route.
///
/// `FixtureConversationView` renders every chat variant with no peer attached,
/// so these tests need no signaling server and no WebRTC connection. The route
/// is reached with the `-uiTestFixtureRoute` launch argument (see
/// `App/UITestHooks.swift`) rather than by tapping through the sidebar.
final class FixtureConversationUITests: XCTestCase {

    /// Every id in `ChatFixture.makeMessages()`.
    ///
    /// Duplicated here on purpose: a UI test bundle cannot import the app
    /// target, so this list is what makes "every variant still renders"
    /// enforceable. Adding or removing a fixture message fails
    /// `testEveryFixtureMessageVariantRenders` until this list is updated too.
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
        "fx-queued-1",
        "fx-assistant-streaming",
    ]

    /// Last message in `ChatFixture.makeMessages()`, and therefore the row the
    /// list auto-scrolls to. The bottom-to-top walk uses it as its start
    /// signal, so it must stay in step with the fixture's tail.
    private static let newestFixtureMessageId = "fx-assistant-streaming"

    /// Substrings that only a variant-specific renderer can produce.
    ///
    /// Row ids alone are not enough: SwiftUI propagates `message-<id>` to every
    /// leaf in the row, so a row still matches while its specialized subview is
    /// gone — delete the tool cluster and the plain bubble text keeps carrying
    /// the id. Each marker below is emitted by exactly one renderer, so losing
    /// that renderer fails the walk.
    private static let variantMarkers = [
        "Working",  // collapsed tool-call cluster header
        "edit: error",  // per-call status dot, error state
        "bash: running",  // per-call status dot, running state
        "list scoops",  // ungrouped tool row (fewer than 3 calls)
        "github-push",  // lick pill, webhook channel
        "src-watch",  // lick pill, fswatch channel relabelled "files"
        "0.4.1→0.5.0",  // lick pill, upgrade channel
        "Instructions from sliccy",  // delegation-sourced user message
        "npm run test",  // running tool under the streaming message
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
        // No leader means no connection. The status pill belongs to
        // ConversationView and must not bleed into the fixture route.
        XCTAssertFalse(
            app.staticTexts["connection-status"].exists,
            "The fixture route should not show a connection pill")
    }

    /// Walks the whole transcript and asserts every fixture variant rendered —
    /// both that each row exists and that its specialized renderer ran.
    ///
    /// The list is a `LazyVStack` pinned to the newest message, so offscreen
    /// rows are absent from the accessibility tree and the walk has to run
    /// bottom-to-top. Scrolling is what makes this a real assertion rather than
    /// a check that the last screenful happens to be right.
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

        // Bounded so a layout regression that stops the list scrolling fails
        // here instead of hanging until the suite times out.
        for _ in 0..<40 where !isComplete(ids: seenIds, labels: seenLabels) {
            app.swipeDown()
            let ids = visibleMessageIds(in: app)
            let labels = visibleLabels(in: app)
            seenIds.formUnion(ids)
            seenLabels.formUnion(labels)

            // Progress means *the screen changed*, not that the cumulative set
            // grew. Scrolling across rows already recorded adds nothing new
            // while still making progress, so counting that as a dry pass ends
            // the walk early — which is exactly how this went flaky on CI,
            // where the slower list renders fewer fresh rows per swipe.
            let screen = ids.union(labels)
            unchangedScrolls = screen == previousScreen ? unchangedScrolls + 1 : 0
            previousScreen = screen
            // The top of the list is stable forever, so waiting several rounds
            // costs a few swipes there and tolerates a swipe whose animation
            // had not settled when the tree was read.
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

    // MARK: - Helpers

    /// Launch straight into the fixture route.
    ///
    /// `joinUrl` is passed explicitly and empty so a value persisted by another
    /// test cannot leak in — the argument domain outranks the persistent one,
    /// and the suite runs in random order across parallel simulator clones.
    private func launchFixtureApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-uiTestFixtureRoute", "YES",
            "-joinUrl", "",
        ]
        app.launch()
        return app
    }

    /// Block until the list has settled on its newest message.
    ///
    /// The walk starts at the bottom and only ever scrolls up, so a row the
    /// first sample misses is never seen again. Waiting for *any* row is not
    /// enough — rows materialize while the auto-scroll to the bottom is still
    /// in flight, and sampling then drops the newest message from the set
    /// permanently. That is precisely how CI collected seventeen of the
    /// eighteen fixture rows and lost `fx-assistant-streaming` every time.
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

    /// Block until at least one message row is in the accessibility tree.
    ///
    /// A single-shot query straight after a transition is a race: the header
    /// can already be up while the `LazyVStack` is still materializing rows.
    /// That window is invisible locally and wide enough on a loaded CI
    /// simulator to fail the assertion outright, so every row read that
    /// follows a launch or a rebuild waits here first.
    private func waitForAnyMessageRow(in app: XCUIApplication, timeout: TimeInterval = 30) -> Bool {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "message-"))
            .firstMatch
            .waitForExistence(timeout: timeout)
    }

    /// Message ids currently present in the accessibility tree.
    ///
    /// SwiftUI pushes a row's identifier down onto its leaf elements, so one
    /// message yields several matches; the set collapses them. One query per
    /// scroll step keeps the walk to tens of round-trips rather than hundreds.
    private func visibleMessageIds(in app: XCUIApplication) -> Set<String> {
        let prefix = "message-"
        let rows = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix))
        return Set(
            rows.allElementsBoundByAccessibilityElement
                .map { String($0.identifier.dropFirst(prefix.count)) })
    }

    /// Accessibility labels currently on screen. Text and buttons are where the
    /// variant-specific renderers put their output — tool rows and lick pills
    /// are buttons, bubbles are text.
    private func visibleLabels(in app: XCUIApplication) -> Set<String> {
        var labels = Set<String>()
        labels.formUnion(app.staticTexts.allElementsBoundByAccessibilityElement.map(\.label))
        labels.formUnion(app.buttons.allElementsBoundByAccessibilityElement.map(\.label))
        return labels
    }

    private func missingMarkers(in labels: Set<String>) -> [String] {
        Self.variantMarkers.filter { marker in
            !labels.contains { $0.contains(marker) }
        }
    }

    private func isComplete(ids: Set<String>, labels: Set<String>) -> Bool {
        ids == Self.expectedMessageIds && missingMarkers(in: labels).isEmpty
    }
}
