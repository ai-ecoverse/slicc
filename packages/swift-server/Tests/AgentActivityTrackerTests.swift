import Foundation
import XCTest

@testable import slicc_server

final class AgentActivityTrackerTests: XCTestCase {
    func testActivityExpiresAfterOneMinute() async {
        let clock = TestDateProvider(Date(timeIntervalSince1970: 1_700_000_000))
        let tracker = AgentActivityTracker(now: { clock.now() })

        let initiallyActive = await tracker.isActiveInLastMinute()
        XCTAssertFalse(initiallyActive)
        await tracker.recordActivity()
        let activeAfterRequest = await tracker.isActiveInLastMinute()
        XCTAssertTrue(activeAfterRequest)

        clock.advance(by: AgentActivityTracker.activityWindow + 0.001)
        let activeAfterWindow = await tracker.isActiveInLastMinute()
        XCTAssertFalse(activeAfterWindow)
    }
}

private final class TestDateProvider: @unchecked Sendable {
    private let lock = NSLock()
    private var date: Date

    init(_ date: Date) {
        self.date = date
    }

    func now() -> Date {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.date
    }

    func advance(by interval: TimeInterval) {
        self.lock.lock()
        self.date = self.date.addingTimeInterval(interval)
        self.lock.unlock()
    }
}
