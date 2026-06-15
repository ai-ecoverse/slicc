import XCTest
@testable import SwiftOptel

final class SwiftOptelTests: XCTestCase {
    func testVersionIsNonEmpty() {
        XCTAssertFalse(SwiftOptel.version.isEmpty)
    }
}
