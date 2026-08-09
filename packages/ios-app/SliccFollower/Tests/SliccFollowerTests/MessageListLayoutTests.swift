import XCTest

@testable import SliccFollower

/// The cap itself is a constant and belongs here. Whether the capped column is
/// actually *centered* is not: it emerges from the live scroll view (the
/// transcript's `scrollTargetLayout()` re-anchors content that a frame has
/// offset), so it is only observable in a rendered hierarchy at regular width.
/// That half is covered by `SliccFollowerUITests/TranscriptColumnUITests` on
/// the iPad CI leg — a unit assertion here would pass against both layouts.
final class MessageListLayoutTests: XCTestCase {

    func testTranscriptUsesReadableRegularWidth() {
        XCTAssertEqual(MessageListLayout.maximumReadableWidth, 680)
    }
}
