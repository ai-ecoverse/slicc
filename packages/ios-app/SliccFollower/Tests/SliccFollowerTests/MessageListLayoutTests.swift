import XCTest

@testable import SliccFollower

final class MessageListLayoutTests: XCTestCase {

    func testTranscriptUsesReadableRegularWidth() {
        XCTAssertEqual(MessageListLayout.maximumReadableWidth, 680)
    }
}