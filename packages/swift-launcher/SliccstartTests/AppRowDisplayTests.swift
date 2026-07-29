import XCTest

@testable import Sliccstart

final class AppRowDisplayTests: XCTestCase {
    func testStatusDotForEachRuntimeState() {
        XCTAssertNil(AppRow.statusDot(for: .notRunning))
        XCTAssertEqual(AppRow.statusDot(for: .runningWithoutDebug), .runningWithoutDebug)
        XCTAssertEqual(AppRow.statusDot(for: .runningWithDebug(cdpPort: 9222)), .runningWithDebug)
        XCTAssertEqual(AppRow.statusDot(for: .startFailed(message: "boom")), .failed)
        XCTAssertEqual(AppRow.statusDot(for: .cannotStart(.needsDebugBuild)), .needsDebugBuild)
        XCTAssertEqual(AppRow.statusDot(for: .cannotStart(.needsPermission)), .needsPermission)
        XCTAssertEqual(AppRow.statusDot(for: .cannotStart(.needsLeader)), .needsLeader)
    }

    func testStatusDotColorAndHelpForEachCase() {
        let all: [AppRowStatusDot] = [
            .runningWithDebug,
            .runningWithoutDebug,
            .needsPermission,
            .needsDebugBuild,
            .needsLeader,
            .failed,
        ]
        var colors: Set<String> = []
        for dot in all {
            colors.insert(String(describing: dot.color))
            XCTAssertFalse(dot.help.isEmpty)
        }
        XCTAssertEqual(colors.count, 4)
        XCTAssertEqual(AppRowStatusDot.needsLeader.help, "Start a browser first to enable this app.")
    }

    func testIsDisabledOnlyForNeedsLeaderOrExplicitFlag() {
        XCTAssertTrue(
            AppRow.isDisabled(runtimeState: .cannotStart(.needsLeader), interactionDisabled: false)
        )
        XCTAssertTrue(
            AppRow.isDisabled(runtimeState: .notRunning, interactionDisabled: true)
        )
        XCTAssertFalse(
            AppRow.isDisabled(runtimeState: .notRunning, interactionDisabled: false)
        )
        XCTAssertFalse(
            AppRow.isDisabled(
                runtimeState: .cannotStart(.needsPermission),
                interactionDisabled: false
            )
        )
    }

    func testSubtitleOverrideWins() {
        XCTAssertEqual(
            AppRow.subtitle(for: .runningWithoutDebug, override: "Custom", isDebugBuild: false),
            "Custom"
        )
    }

    func testSubtitleForEachRuntimeState() {
        XCTAssertNil(AppRow.subtitle(for: .notRunning, override: nil, isDebugBuild: false))
        XCTAssertEqual(
            AppRow.subtitle(for: .notRunning, override: nil, isDebugBuild: true),
            "Debug Build"
        )
        XCTAssertEqual(
            AppRow.subtitle(for: .runningWithoutDebug, override: nil, isDebugBuild: false),
            "Running without SLICC"
        )
        XCTAssertEqual(
            AppRow.subtitle(for: .runningWithDebug(cdpPort: 9222), override: nil, isDebugBuild: false),
            "Running with SLICC on 9222"
        )
        XCTAssertEqual(
            AppRow.subtitle(for: .runningWithDebug(cdpPort: nil), override: nil, isDebugBuild: false),
            "Running with SLICC"
        )
        XCTAssertEqual(
            AppRow.subtitle(for: .startFailed(message: "x"), override: nil, isDebugBuild: false),
            "Start failed"
        )
        XCTAssertEqual(
            AppRow.subtitle(for: .cannotStart(.needsDebugBuild), override: nil, isDebugBuild: false),
            "Needs Debug Build"
        )
        XCTAssertEqual(
            AppRow.subtitle(for: .cannotStart(.needsPermission), override: nil, isDebugBuild: false),
            "Needs Permission"
        )
        XCTAssertEqual(
            AppRow.subtitle(for: .cannotStart(.needsLeader), override: nil, isDebugBuild: false),
            "Start a browser first"
        )
    }
}
