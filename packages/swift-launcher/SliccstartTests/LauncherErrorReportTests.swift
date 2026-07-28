import AppUpdater
import SwiftOptel
import XCTest

@testable import Sliccstart

/// Coverage for the RUM `error` beacons the launcher emits from its Swift
/// `do/catch` boundaries. `.optelAutoInstrument` only hooks Objective-C
/// exceptions, so these call sites are the only way a launcher failure reaches
/// `helix_rum` — and the beacon is an outbound payload, so the redaction
/// contract is part of the behavior, not a nicety.
/// Declared at file scope so its bridged `NSError.domain` stays short — a type
/// nested in a test method gets an `(unknown context …)` domain that eats the
/// beacon budget.
private struct LeakyError: LocalizedError {
    var errorDescription: String? { "cannot write /Users/jane/Library/Application Support/Sliccstart/x.json" }
}

final class LauncherErrorReportTests: XCTestCase {

    private func target(_ operation: LauncherErrorReport.Operation, _ error: Error) -> String {
        LauncherErrorReport.mapping(operation: operation, error: error).target
    }

    func testSourceIsTheStableOperationKey() {
        let mapping = LauncherErrorReport.mapping(
            operation: .updateCheck,
            error: AppUpdater.Error.noValidUpdate
        )
        XCTAssertEqual(mapping.source, "sliccstart:update-check")
    }

    func testOperationKeysAreUniqueAndDashed() {
        let keys: [LauncherErrorReport.Operation] = [
            .updateCheck, .updateDetach, .bootstrap, .bootstrapUpdate,
            .launchStandalone, .launchElectron, .autoLaunch, .debugBuild,
            .terminalFollower, .reattach, .secretsUnlock, .secretsPersist,
        ]
        let raw = keys.map(\.rawValue)
        XCTAssertEqual(Set(raw).count, raw.count)
        for key in raw {
            XCTAssertEqual(key, key.lowercased())
            XCTAssertFalse(key.contains(" "))
        }
    }

    func testTargetKeepsTheErrorIdentity() {
        let reported = target(.updateCheck, URLError(.notConnectedToInternet))
        XCTAssertTrue(reported.contains("NSURLErrorDomain"), reported)
    }

    // MARK: - Redaction

    func testRedactsJoinURLBecauseItCarriesTheSessionSecret() {
        let redacted = LauncherErrorReport.redact(
            "follower failed for https://www.sliccy.ai/join/abc123secret"
        )
        XCTAssertFalse(redacted.contains("abc123secret"))
        XCTAssertTrue(redacted.contains("<url>"), redacted)
    }

    func testRedactsAbsolutePathsBecauseHomeRevealsTheUserName() {
        let redacted = LauncherErrorReport.redact(
            "could not copy /Users/jane/Applications/Slack Debug.app"
        )
        XCTAssertFalse(redacted.contains("jane"))
        XCTAssertTrue(redacted.contains("<path>"), redacted)
    }

    func testRedactsTokenAndSecretKeyValuePairs() {
        let redacted = LauncherErrorReport.redact("spawn failed --bridge-token=deadbeef key: hunter2")
        XCTAssertFalse(redacted.contains("deadbeef"))
        XCTAssertFalse(redacted.contains("hunter2"))
        XCTAssertTrue(redacted.contains("<redacted>"), redacted)
    }

    func testCollapsesWhitespaceSoBeaconsStaySingleLine() {
        XCTAssertEqual(LauncherErrorReport.redact("failed:\n\n  twice\ttoday"), "failed: twice today")
    }

    func testTruncatesLongMessages() {
        let redacted = LauncherErrorReport.redact(String(repeating: "e", count: 400))
        XCTAssertEqual(redacted.count, LauncherErrorReport.maxTargetLength)
        XCTAssertTrue(redacted.hasSuffix("…"))
    }

    func testRedactionAppliesToTheReportedTarget() {
        let reported = target(.updateDetach, LeakyError())
        XCTAssertFalse(reported.contains("jane"))
        XCTAssertTrue(reported.contains("<path>"), reported)
    }

    func testTargetStaysWithinTheBeaconBudget() {
        struct Verbose: LocalizedError {
            var errorDescription: String? { String(repeating: "detail ", count: 100) }
        }
        XCTAssertLessThanOrEqual(
            target(.launchElectron, Verbose()).count,
            LauncherErrorReport.maxTargetLength
        )
    }

    func testReportDoesNotThrowWhenOptelIsUnconfigured() {
        // Sliccstart configures Optel from `.optelAutoInstrument`; unit tests
        // never do. `Optel.sample` must no-op rather than trap, otherwise every
        // reported error would crash a test host — or a launcher that failed
        // before instrumentation was mounted.
        LauncherErrorReport.report(.bootstrap, URLError(.timedOut))
    }
}
