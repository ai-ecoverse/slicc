import Darwin
import XCTest

@testable import Sliccstart

final class BrokenPipeSignalTests: XCTestCase {
    private var savedAction = sigaction()

    override func setUp() {
        super.setUp()
        XCTAssertEqual(sigaction(SIGPIPE, nil, &savedAction), 0)
    }

    override func tearDown() {
        var restored = savedAction
        sigaction(SIGPIPE, &restored, nil)
        super.tearDown()
    }

    func testIgnoreSwitchesSIGPIPEFromDefaultToIgnored() {
        signal(SIGPIPE, SIG_DFL)
        XCTAssertFalse(BrokenPipeSignal.isIgnored)

        XCTAssertTrue(BrokenPipeSignal.ignore())
        XCTAssertTrue(BrokenPipeSignal.isIgnored)
    }

    func testIgnoreIsIdempotent() {
        XCTAssertTrue(BrokenPipeSignal.ignore())
        XCTAssertTrue(BrokenPipeSignal.ignore())
        XCTAssertTrue(BrokenPipeSignal.isIgnored)
    }

    // Without the ignore this write would kill the test runner outright.
    func testWriteToPipeWithoutReaderReturnsEPIPE() {
        BrokenPipeSignal.ignore()
        var fds: [Int32] = [0, 0]
        XCTAssertEqual(pipe(&fds), 0)
        close(fds[0])
        defer { close(fds[1]) }

        let byte: UInt8 = 0x0A
        let written = withUnsafePointer(to: byte) { write(fds[1], $0, 1) }
        XCTAssertEqual(written, -1)
        XCTAssertEqual(errno, EPIPE)
    }

    // Entry point: `main.swift` must ignore SIGPIPE before its first write. A
    // malformed `--computer-follow` writes usage to stderr and exits 2; with
    // stderr's reader already gone that write used to kill the process.
    func testLauncherEntryPointSurvivesClosedStderr() throws {
        let binary = Bundle(for: Self.self).bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("Sliccstart")
        try XCTSkipUnless(
            FileManager.default.isExecutableFile(atPath: binary.path),
            "Sliccstart executable not built next to the test bundle")

        let stderrPipe = Pipe()
        try stderrPipe.fileHandleForReading.close()

        let process = Process()
        process.executableURL = binary
        process.arguments = [ComputerFollowCLI.followFlag]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = stderrPipe
        var environment = ProcessInfo.processInfo.environment
        if let profilePath = environment["LLVM_PROFILE_FILE"] {
            environment["LLVM_PROFILE_FILE"] =
                URL(fileURLWithPath: profilePath).deletingLastPathComponent()
                .appendingPathComponent("sliccstart-\(UUID().uuidString)-%c.%p.profraw").path
        }
        process.environment = environment

        try process.run()
        process.waitUntilExit()

        XCTAssertEqual(process.terminationReason, .exit, "killed by signal \(process.terminationStatus)")
        XCTAssertEqual(process.terminationStatus, ComputerFollowCLI.usageExitCode)
    }
}
