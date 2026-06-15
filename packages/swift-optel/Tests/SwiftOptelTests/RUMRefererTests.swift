import XCTest
@testable import SwiftOptel

final class RUMRefererTests: XCTestCase {
    func testBuildUsesAppIDAsHost() {
        XCTAssertEqual(
            RUMReferer.build(appID: "com.example.app", viewPath: "/home"),
            "https://com.example.app/home"
        )
    }

    func testBuildNormalizesEmptyPathToRoot() {
        XCTAssertEqual(
            RUMReferer.build(appID: "com.example.app", viewPath: ""),
            "https://com.example.app/"
        )
    }

    func testBuildDefaultsToRootPath() {
        XCTAssertEqual(
            RUMReferer.build(appID: "com.example.app"),
            "https://com.example.app/"
        )
    }

    func testBuildPrependsLeadingSlashToRelativePath() {
        XCTAssertEqual(
            RUMReferer.build(appID: "com.example.app", viewPath: "settings/profile"),
            "https://com.example.app/settings/profile"
        )
    }

    func testBuildPreservesLeadingSlash() {
        XCTAssertEqual(
            RUMReferer.build(appID: "com.example.app", viewPath: "/a/b/c"),
            "https://com.example.app/a/b/c"
        )
    }

    func testDefaultCollectBaseURLMatchesHelixRumJs() {
        XCTAssertEqual(
            RUMReferer.defaultCollectBaseURL.absoluteString,
            "https://rum.hlx.page/"
        )
    }
}
