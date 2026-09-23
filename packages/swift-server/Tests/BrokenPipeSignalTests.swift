import Darwin
import XCTest

@testable import slicc_server

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
}
