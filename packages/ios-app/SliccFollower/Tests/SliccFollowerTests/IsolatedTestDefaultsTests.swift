import Foundation
import XCTest

@testable import SliccFollower

/// The isolation the rest of the bundle relies on, asserted rather than
/// assumed: seeding a fixture flag must reach the fixture seam and nothing
/// else — not the shared domain, and not a sibling suite.
final class IsolatedTestDefaultsTests: XCTestCase {
    private let flag = "uiTestSessionsFixture"

    func testASeededFlagReachesTheSeamAndNotTheSharedDomain() throws {
        let seeded = try makeIsolatedDefaults(flags: [flag: true])

        XCTAssertTrue(seeded.bool(forKey: flag))
        XCTAssertNotNil(
            UITestHooks.sessionsFixtureBackend(defaults: seeded),
            "the seam must read the suite it was handed, not UserDefaults.standard")
        XCTAssertFalse(
            UserDefaults.standard.bool(forKey: flag),
            "a seeded flag must never land in the app's persistent domain, which"
                + " every other test in this bundle — and the next run — shares")
    }

    func testEachSuiteIsIndependentOfEveryOther() throws {
        let seeded = try makeIsolatedDefaults(flags: [flag: true])
        let bare = try makeIsolatedDefaults()

        XCTAssertFalse(bare.bool(forKey: flag))
        XCTAssertNil(
            UITestHooks.sessionsFixtureBackend(defaults: bare),
            "one test's fixture flag must be invisible to another's defaults")
        XCTAssertNotNil(UITestHooks.sessionsFixtureBackend(defaults: seeded))
    }
}
