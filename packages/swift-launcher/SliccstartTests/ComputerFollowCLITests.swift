import Foundation
import XCTest

@testable import Sliccstart

/// Pure-logic coverage for the headless `Sliccstart --computer-follow` /
/// `--computer-preflight` modes the `slicc … follow --computer` CLI drives
/// (#3260). The AppKit/TCC/WebRTC glue lives in `ComputerFollowCLIRunner` and
/// is not reachable from a test bundle.
final class ComputerFollowCLITests: XCTestCase {
    private let joinUrl = "https://tray.sliccy.ai/join/abc123"

    private func parse(_ args: [String]) throws -> ComputerFollowCLI.Request? {
        try ComputerFollowCLI.parse(["/Applications/Sliccstart.app/Contents/MacOS/Sliccstart"] + args)
    }

    // MARK: - Falling through to the GUI

    func testAnOrdinaryLaunchIsNotAHeadlessRequest() throws {
        XCTAssertNil(try parse([]))
        XCTAssertNil(try parse(["--update-host", "example.test"]))
    }

    /// The `--list-sessions` mode is parsed first in `main.swift`; this one must
    /// not also claim it, or the two headless paths would race for the process.
    func testTheSessionListingModeIsNotClaimedHere() throws {
        XCTAssertNil(try parse(["--list-sessions", "--reveal-urls"]))
    }

    // MARK: - follow

    func testFollowTakesTheJoinUrlAndOptionalPairToken() throws {
        XCTAssertEqual(
            try parse(["--computer-follow", joinUrl]),
            .follow(joinUrl: joinUrl, pairId: nil))
        XCTAssertEqual(
            try parse(["--computer-follow", joinUrl, "--pair", "pair-abc"]),
            .follow(joinUrl: joinUrl, pairId: "pair-abc"))
    }

    /// argv[0] is the executable path and is never a flag.
    func testTheExecutablePathIsSkipped() throws {
        XCTAssertNil(try ComputerFollowCLI.parse(["--computer-follow"]))
    }

    func testAMissingJoinUrlIsAUsageError() {
        XCTAssertThrowsError(try parse(["--computer-follow"])) { error in
            XCTAssertEqual(error as? ComputerFollowCLI.ParseError, .missingJoinUrl)
        }
    }

    /// A launcher that exists to hand out screen access must not dial whatever
    /// string it is handed.
    func testOnlyHttpJoinUrlsAreAccepted() {
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "not a url", "https://"] {
            XCTAssertThrowsError(try parse(["--computer-follow", bad]), bad) { error in
                XCTAssertEqual(error as? ComputerFollowCLI.ParseError, .invalidJoinUrl(bad))
            }
        }
        XCTAssertTrue(ComputerFollowCLI.isJoinUrl("http://localhost:5710/join/x"))
    }

    /// `--pair` swallowing the next flag would hand the leader a token like
    /// "--no-banner" and pair this Mac with nothing.
    func testAPairFlagWithoutAValueIsAUsageError() {
        XCTAssertThrowsError(try parse(["--computer-follow", joinUrl, "--pair"])) { error in
            XCTAssertEqual(error as? ComputerFollowCLI.ParseError, .missingPairId)
        }
        XCTAssertThrowsError(
            try parse(["--computer-follow", joinUrl, "--pair", "--json"])
        ) { error in
            XCTAssertEqual(error as? ComputerFollowCLI.ParseError, .missingPairId)
        }
    }

    // MARK: - preflight

    func testPreflightIsRecognisedWithAndWithoutJson() throws {
        XCTAssertEqual(try parse(["--computer-preflight"]), .preflight(json: false))
        XCTAssertEqual(try parse(["--computer-preflight", "--json"]), .preflight(json: true))
    }

    /// The CLI always asks for JSON, and `internal/computer.Grants` decodes
    /// exactly these two keys — a rename here silently reads as "not granted".
    func testGrantsEncodeToTheShapeTheGoCliDecodes() throws {
        let data = try ComputerFollowCLI.encode(
            .init(screenRecording: true, accessibility: false))
        XCTAssertEqual(
            String(decoding: data, as: UTF8.self),
            #"{"accessibility":false,"screenRecording":true}"#)
    }

    func testTheHumanReadableReportNamesWhatIsMissing() {
        let partial = ComputerFollowCLI.describe(
            .init(screenRecording: true, accessibility: false))
        XCTAssertTrue(partial.contains("Screen Recording: granted"))
        XCTAssertTrue(partial.contains("Accessibility:    not granted"))
        XCTAssertTrue(partial.contains("System Settings"))

        let complete = ComputerFollowCLI.describe(
            .init(screenRecording: true, accessibility: true))
        XCTAssertFalse(
            complete.contains("System Settings"),
            "a fully granted Mac should not be told to go fix something")
    }

    func testExitCodeSeparatesFullyGrantedFromPartial() {
        XCTAssertEqual(
            ComputerFollowCLI.exitCode(for: .init(screenRecording: true, accessibility: true)), 0)
        XCTAssertEqual(
            ComputerFollowCLI.exitCode(for: .init(screenRecording: true, accessibility: false)), 3)
        XCTAssertEqual(
            ComputerFollowCLI.exitCode(for: .init(screenRecording: false, accessibility: false)), 3)
    }

    func testPreflightReportsWhateverTheProbeSays() {
        XCTAssertEqual(
            ComputerFollowCLI.resolveGrants(using: .alwaysGranted),
            .init(screenRecording: true, accessibility: true))
        XCTAssertEqual(
            ComputerFollowCLI.resolveGrants(using: .alwaysDenied),
            .init(screenRecording: false, accessibility: false))
    }

    /// An already-granted Mac must not be re-nagged every time `follow
    /// --computer` starts — `request*` is only reached when the grant is
    /// actually missing.
    func testPreflightDoesNotPromptWhenTheGrantAlreadyExists() {
        let screenPrompts = Counter()
        let accessibilityPrompts = Counter()
        let probe = ComputerPermissionProbe(
            screenRecordingGranted: { true },
            requestScreenRecording: {
                screenPrompts.bump()
                return true
            },
            accessibilityGranted: { false },
            requestAccessibility: {
                accessibilityPrompts.bump()
                return true
            })

        let grants = ComputerFollowCLI.resolveGrants(using: probe)

        XCTAssertEqual(grants, .init(screenRecording: true, accessibility: true))
        XCTAssertEqual(screenPrompts.count, 0, "an existing grant must not raise a prompt")
        XCTAssertEqual(accessibilityPrompts.count, 1, "a missing grant must be asked for")
    }

    func testPreflightWritesTheReportAndReturnsTheGrantStatus() {
        var out = Data()
        var err = Data()
        let partial = ComputerFollowCLI.preflight(
            using: ComputerPermissionProbe(
                screenRecordingGranted: { true }, requestScreenRecording: { true },
                accessibilityGranted: { false }, requestAccessibility: { false }),
            json: true, writeOut: { out.append($0) }, writeErr: { err.append($0) })

        XCTAssertEqual(partial, 3, "a partial grant is a distinct, scriptable status")
        XCTAssertEqual(
            String(decoding: out, as: UTF8.self),
            #"{"accessibility":false,"screenRecording":true}"# + "\n")
        XCTAssertTrue(err.isEmpty)

        out = Data()
        XCTAssertEqual(
            ComputerFollowCLI.preflight(
                using: .alwaysGranted, json: false,
                writeOut: { out.append($0) }, writeErr: { err.append($0) }),
            0)
        XCTAssertTrue(String(decoding: out, as: UTF8.self).contains("Screen Recording: granted"))
    }

    func testReportEmitsJsonOrProseAndAlwaysEndsWithANewline() throws {
        let grants = ComputerFollowCLI.Grants(screenRecording: true, accessibility: false)

        let json = String(decoding: try ComputerFollowCLI.report(grants, json: true), as: UTF8.self)
        XCTAssertEqual(json, #"{"accessibility":false,"screenRecording":true}"# + "\n")

        let prose = String(
            decoding: try ComputerFollowCLI.report(grants, json: false), as: UTF8.self)
        XCTAssertTrue(prose.contains("Screen Recording: granted"))
        XCTAssertTrue(prose.hasSuffix("\n"))
    }

    // MARK: - attach reporting

    func testFirstConnectReportsAttachedOnceAndReconnectsStayQuiet() {
        var reporter = ComputerFollowCLI.AttachReporter()
        XCTAssertEqual(reporter.connected(), .print(ComputerFollowCLI.attachedLine))
        XCTAssertTrue(reporter.attached)
        // A leader drop and reconnect is routine, not a second start.
        XCTAssertEqual(reporter.connected(), .none)
    }

    /// Both before and after the first attach: a launcher no leader can reach
    /// must not linger holding Screen Recording for nobody.
    func testGivingUpAlwaysExitsWithTheReason() {
        var fresh = ComputerFollowCLI.AttachReporter()
        XCTAssertEqual(
            fresh.gaveUp("signaling returned 404"),
            .printAndExit("SLICC_COMPUTER_FOLLOW_FAILED signaling returned 404", 1))

        var attached = ComputerFollowCLI.AttachReporter()
        _ = attached.connected()
        XCTAssertEqual(
            attached.gaveUp("ICE failed"),
            .printAndExit("SLICC_COMPUTER_FOLLOW_FAILED ICE failed", 1))
    }

    /// The CLI reads stdout line by line — a multi-line error must not split
    /// into a truncated reason plus stray lines.
    func testTheFailureReasonIsFlattenedToOneLine() {
        XCTAssertEqual(
            ComputerFollowCLI.failedLine(reason: "first\nsecond\r\nthird"),
            "SLICC_COMPUTER_FOLLOW_FAILED first second third")
        XCTAssertEqual(
            ComputerFollowCLI.failedLine(reason: "  \n "), ComputerFollowCLI.failedPrefix)
    }

    // MARK: - parent liveness

    /// launchd (pid 1) adopting us means the CLI that owned this process is
    /// already dead, possibly before the exit watch could be armed.
    func testAParentPidOfLaunchdMeansTheOwnerIsGone() {
        XCTAssertTrue(ComputerFollowCLI.parentIsGone(parentPid: 1))
        XCTAssertTrue(ComputerFollowCLI.parentIsGone(parentPid: 0))
        XCTAssertFalse(ComputerFollowCLI.parentIsGone(parentPid: 4242))
    }

    /// The Go CLI decides "this launcher understands the flag" by matching this
    /// exact line; the two constants are the contract.
    func testTheHandshakeLinesAreTheAgreedTokens() {
        XCTAssertEqual(ComputerFollowCLI.readyLine, "SLICC_COMPUTER_FOLLOW_READY")
        XCTAssertEqual(ComputerFollowCLI.attachedLine, "SLICC_COMPUTER_FOLLOW_ATTACHED")
        XCTAssertEqual(ComputerFollowCLI.failedPrefix, "SLICC_COMPUTER_FOLLOW_FAILED")
    }
}

/// `ComputerPermissionProbe` closures are `@Sendable`, so a captured counter
/// needs a reference box rather than a local `var`.
private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func bump() {
        lock.lock()
        value += 1
        lock.unlock()
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}
