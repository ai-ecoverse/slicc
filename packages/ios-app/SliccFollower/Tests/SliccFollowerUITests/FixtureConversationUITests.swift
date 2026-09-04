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
        "fx-lick-collated",
        "fx-lick-confirmed",
        "fx-lick-dismissed",
        "fx-user-attachments",
        "fx-user-attachment-only",
        "fx-assistant-error",
        // Bash-progress overlay rows (#2282, #2316) — a single call and a
        // parallel cluster.
        "fx-assistant-progress",
        "fx-assistant-progress-cluster",
        // Compaction seams (#2843) — one row per rendered state.
        "fx-compaction-idle",
        "fx-compaction-threshold-running",
        "fx-compaction-fallback",
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
        "deploy-status \u{00D7}3",  // collated lick pill, count suffix
        "SOMETHING WENT WRONG",  // error card header, uppercased
        "screenshot.png",  // attachment chip beside a user bubble
        "diagram.png",  // attachment chip on a bubble-less message
        "Allow npm publish?",  // tool_ui title, badge and meta stripped
        "Waiting for approval on the leader",  // tool_ui read-only body
        "SWIPE_ARBITRATION_CODE_BLOCK_TRAILING_EDGE_MARKER",  // overflowing code block
        "embedded follower garnish",  // pipe-table cell (the Grid-free table card)
        // Compaction marker copy: the row derives every word from
        // trigger + state, so these strings can only come from its own table
        // (#2843). The transcript pointer rides the same combined label.
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

    /// A settled lick shows its decision glyph. This is asserted by identifier
    /// because the glyph is an SF Symbol with no text of its own, so the
    /// variant-marker walk above cannot see it.
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
        // `pending` is the default state and deliberately has no glyph on the
        // web either, so a stray one here would be a divergence.
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

        // The fixture starts at the newest message, so walk upward with a hard
        // bound until both drag targets in the markdown message are hittable.
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

        // A single physical flick does not guarantee that every simulator
        // width traverses the remaining content. Keep pulling through the
        // bounded scroll range until one drag starts at the trailing edge.
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

    /// Lick decision-glyph identifiers currently in the tree.
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
        // The trailing 48pt dock is outside the chat gesture surface even when
        // a wide text leaf reports an accessibility frame beneath it.
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
