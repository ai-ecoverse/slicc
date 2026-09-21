import Foundation
import XCTest

@testable import Sliccstart





final class ComputerFollowCLITests: XCTestCase {
    private let joinUrl = "https://tray.sliccy.ai/join/abc123"

    private func parse(_ args: [String]) throws -> ComputerFollowCLI.Request? {
        try ComputerFollowCLI.parse(["/Applications/Sliccstart.app/Contents/MacOS/Sliccstart"] + args)
    }

    

    func testAnOrdinaryLaunchIsNotAHeadlessRequest() throws {
        XCTAssertNil(try parse([]))
        XCTAssertNil(try parse(["--update-host", "example.test"]))
    }

    
    
    func testTheSessionListingModeIsNotClaimedHere() throws {
        XCTAssertNil(try parse(["--list-sessions", "--reveal-urls"]))
    }

    

    func testFollowTakesTheJoinUrlAndOptionalPairToken() throws {
        XCTAssertEqual(
            try parse(["--computer-follow", joinUrl]),
            .follow(joinUrl: joinUrl, pairId: nil))
        XCTAssertEqual(
            try parse(["--computer-follow", joinUrl, "--pair", "pair-abc"]),
            .follow(joinUrl: joinUrl, pairId: "pair-abc"))
    }

    
    func testTheExecutablePathIsSkipped() throws {
        XCTAssertNil(try ComputerFollowCLI.parse(["--computer-follow"]))
    }

    func testAMissingJoinUrlIsAUsageError() {
        XCTAssertThrowsError(try parse(["--computer-follow"])) { error in
            XCTAssertEqual(error as? ComputerFollowCLI.ParseError, .missingJoinUrl)
        }
    }

    
    
    func testOnlyHttpJoinUrlsAreAccepted() {
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "not a url", "https://"] {
            XCTAssertThrowsError(try parse(["--computer-follow", bad]), bad) { error in
                XCTAssertEqual(error as? ComputerFollowCLI.ParseError, .invalidJoinUrl(bad))
            }
        }
        XCTAssertTrue(ComputerFollowCLI.isJoinUrl("http://localhost:5710/join/x"))
    }

    
    
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

    

    func testPreflightIsRecognisedWithAndWithoutJson() throws {
        XCTAssertEqual(try parse(["--computer-preflight"]), .preflight(json: false))
        XCTAssertEqual(try parse(["--computer-preflight", "--json"]), .preflight(json: true))
    }

    
    
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

    

    func testFirstConnectReportsAttachedOnceAndReconnectsStayQuiet() {
        var reporter = ComputerFollowCLI.AttachReporter()
        XCTAssertEqual(reporter.connected(), .print(ComputerFollowCLI.attachedLine))
        XCTAssertTrue(reporter.attached)
        
        XCTAssertEqual(reporter.connected(), .none)
    }

    
    
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

    
    
    func testTheFailureReasonIsFlattenedToOneLine() {
        XCTAssertEqual(
            ComputerFollowCLI.failedLine(reason: "first\nsecond\r\nthird"),
            "SLICC_COMPUTER_FOLLOW_FAILED first second third")
        XCTAssertEqual(
            ComputerFollowCLI.failedLine(reason: "  \n "), ComputerFollowCLI.failedPrefix)
    }

    

    
    
    func testAParentPidOfLaunchdMeansTheOwnerIsGone() {
        XCTAssertTrue(ComputerFollowCLI.parentIsGone(parentPid: 1))
        XCTAssertTrue(ComputerFollowCLI.parentIsGone(parentPid: 0))
        XCTAssertFalse(ComputerFollowCLI.parentIsGone(parentPid: 4242))
    }

    
    
    func testTheHandshakeLinesAreTheAgreedTokens() {
        XCTAssertEqual(ComputerFollowCLI.readyLine, "SLICC_COMPUTER_FOLLOW_READY")
        XCTAssertEqual(ComputerFollowCLI.attachedLine, "SLICC_COMPUTER_FOLLOW_ATTACHED")
        XCTAssertEqual(ComputerFollowCLI.failedPrefix, "SLICC_COMPUTER_FOLLOW_FAILED")
    }
}



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
