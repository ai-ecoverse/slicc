import XCTest

@testable import SliccFollower

final class SwipeArbiterTests: XCTestCase {
    private let leading = SwipeArbiter.ScrollContext(
        atLeadingEdge: true, atTrailingEdge: false)
    private let middle = SwipeArbiter.ScrollContext(
        atLeadingEdge: false, atTrailingEdge: false)
    private let trailing = SwipeArbiter.ScrollContext(
        atLeadingEdge: false, atTrailingEdge: true)
    private let nonOverflowing = SwipeArbiter.ScrollContext(
        atLeadingEdge: true, atTrailingEdge: true)

    func testOrdinaryContentNavigatesInBothDirections() {
        XCTAssertEqual(action(horizontal: -100), .next)
        XCTAssertEqual(action(horizontal: 100), .previous)
    }

    func testUnknownOriginFailsClosedInBothDirections() {
        XCTAssertEqual(action(horizontal: -100, origin: .unknown), .none)
        XCTAssertEqual(action(horizontal: 100, origin: .unknown), .none)
    }

    func testVerticalAndDiagonalDragsDoNotNavigate() {
        XCTAssertEqual(action(horizontal: 100, vertical: 100), .none)
        XCTAssertEqual(action(horizontal: 100, vertical: 70), .none)
    }

    func testDragBelowActionThresholdDoesNotNavigate() {
        XCTAssertEqual(action(horizontal: -59), .none)
        XCTAssertEqual(action(horizontal: 59), .none)
    }

    func testLeftDragRequiresTrailingEdge() {
        XCTAssertEqual(action(horizontal: -100, origin: .guardedContent(middle)), .none)
        XCTAssertEqual(action(horizontal: -100, origin: .guardedContent(leading)), .none)
        XCTAssertEqual(action(horizontal: -100, origin: .guardedContent(trailing)), .next)
    }

    func testRightDragRequiresLeadingEdge() {
        XCTAssertEqual(action(horizontal: 100, origin: .guardedContent(middle)), .none)
        XCTAssertEqual(action(horizontal: 100, origin: .guardedContent(trailing)), .none)
        XCTAssertEqual(action(horizontal: 100, origin: .guardedContent(leading)), .previous)
    }

    func testNonOverflowingScrollerDoesNotBlockNavigation() {
        XCTAssertEqual(
            action(horizontal: -100, origin: .guardedContent(nonOverflowing)), .next)
        XCTAssertEqual(
            action(horizontal: 100, origin: .guardedContent(nonOverflowing)), .previous)
    }

    func testOuterGestureDefersGuardedContentToScroller() {
        XCTAssertEqual(
            SwipeArbiter.outerAction(
                for: CGSize(width: -100, height: 4),
                origin: .guardedContent(trailing)),
            .none)
        XCTAssertEqual(
            SwipeArbiter.outerAction(
                for: CGSize(width: -100, height: 4),
                origin: .ordinaryContent),
            .next)
    }

    func testMeasuredEdgesIncludeToleranceBounceAndNonOverflowingContent() {
        let nearLeading = SwipeArbiter.ScrollContext(
            offset: 0.5, contentWidth: 200, viewportWidth: 100)
        let leadingBounce = SwipeArbiter.ScrollContext(
            offset: -5, contentWidth: 200, viewportWidth: 100)
        let trailingBounce = SwipeArbiter.ScrollContext(
            offset: 105, contentWidth: 200, viewportWidth: 100)
        let shortContent = SwipeArbiter.ScrollContext(
            offset: 0, contentWidth: 80, viewportWidth: 100)

        XCTAssertTrue(nearLeading.atLeadingEdge)
        XCTAssertTrue(leadingBounce.atLeadingEdge)
        XCTAssertTrue(trailingBounce.atTrailingEdge)
        XCTAssertEqual(shortContent, nonOverflowing)
    }

    func testOuterGestureKeepsTouchDownSnapshotAfterInnerGestureEnds() {
        let state = HorizontalScrollGestureState()
        state.beginInnerGesture(context: middle)
        state.beginOuterGesture(at: .zero)
        state.endInnerGesture()

        XCTAssertEqual(state.endOuterGesture(), .guardedContent(middle))

        state.beginOuterGesture(at: .zero)
        XCTAssertEqual(
            state.endOuterGesture(), .ordinaryContent,
            "completed inner drags must not leak context")
    }

    func testOuterFirstInnerCallbackLateFillsUnknownCapture() {
        let state = HorizontalScrollGestureState()
        let regionID = UUID()
        state.updateRegion(
            id: regionID,
            frame: CGRect(x: 10, y: 20, width: 100, height: 40),
            context: nil)

        state.beginOuterGesture(at: CGPoint(x: 20, y: 30))
        state.beginInnerGesture(context: middle)
        state.endInnerGesture()

        XCTAssertEqual(state.endOuterGesture(), .guardedContent(middle))
    }

    func testStartLocationLookupCapturesRegionAndTouchDownEdge() {
        let state = HorizontalScrollGestureState()
        let regionID = UUID()
        let frame = CGRect(x: 10, y: 20, width: 100, height: 40)
        state.updateRegion(id: regionID, frame: frame, context: leading)

        XCTAssertEqual(
            state.dragOrigin(at: CGPoint(x: 20, y: 30)), .guardedContent(leading))
        XCTAssertEqual(
            state.dragOrigin(at: CGPoint(x: 114, y: 30)), .guardedContent(leading),
            "the visible code-block hit area may extend slightly beyond its viewport")
        XCTAssertEqual(state.dragOrigin(at: CGPoint(x: 200, y: 30)), .ordinaryContent)

        state.beginOuterGesture(at: CGPoint(x: 20, y: 30))
        state.updateRegion(id: regionID, frame: frame, context: trailing)
        XCTAssertEqual(
            state.endOuterGesture(), .guardedContent(leading),
            "the region edge must be captured before the inner scroller moves")

        state.updateRegion(id: regionID, frame: frame, context: nil)
        XCTAssertEqual(state.dragOrigin(at: CGPoint(x: 20, y: 30)), .unknown)
    }

    private func action(
        horizontal: CGFloat,
        vertical: CGFloat = 0,
        origin: SwipeArbiter.DragOrigin = .ordinaryContent
    ) -> SwipeArbiter.Action {
        SwipeArbiter.action(
            for: CGSize(width: horizontal, height: vertical),
            origin: origin)
    }
}
