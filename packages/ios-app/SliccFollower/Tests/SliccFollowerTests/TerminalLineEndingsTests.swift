import XCTest

@testable import SliccFollower



final class TerminalLineEndingsTests: XCTestCase {

    private func normalize(_ chunks: [String]) -> String {
        var subject = TerminalLineEndings()
        var out = Data()
        for chunk in chunks {
            out.append(subject.normalize(Data(chunk.utf8)))
        }
        return String(decoding: out, as: UTF8.self)
    }

    func testBareLineFeedsBecomeCRLF() {
        XCTAssertEqual(
            normalize(["dev\netc\nhome\n"]),
            "dev\r\netc\r\nhome\r\n",
            "pipe-style output must be rendered as a terminal expects")
    }

    func testExistingCRLFIsLeftAlone() {
        XCTAssertEqual(
            normalize(["dev\r\netc\r\n"]), "dev\r\netc\r\n",
            "a second CR would blank the line by returning twice")
    }

    func testMixedEndingsConvergeOnCRLF() {
        XCTAssertEqual(normalize(["a\r\nb\nc\r\n"]), "a\r\nb\r\nc\r\n")
    }

    func testCRLFSplitAcrossChunksIsNotDoubled() {
        
        
        XCTAssertEqual(normalize(["line\r", "\nnext\n"]), "line\r\nnext\r\n")
    }

    func testBareLFOpeningAChunkStillConverts() {
        XCTAssertEqual(normalize(["line", "\nnext"]), "line\r\nnext")
    }

    func testLoneCarriageReturnIsPreserved() {
        
        
        XCTAssertEqual(normalize(["50%\r75%\r100%\n"]), "50%\r75%\r100%\r\n")
    }

    func testOutputWithoutNewlinesIsUnchanged() {
        XCTAssertEqual(normalize(["no trailing newline"]), "no trailing newline")
    }

    func testResetDropsTheCarry() {
        var subject = TerminalLineEndings()
        _ = subject.normalize(Data("ends with cr\r".utf8))
        subject.reset()
        XCTAssertEqual(
            String(decoding: subject.normalize(Data("\nfresh".utf8)), as: UTF8.self),
            "\r\nfresh",
            "a stale carry must not swallow the next session's first CR")
    }

    func testBinarySafeForNonTextBytes() {
        var subject = TerminalLineEndings()
        let raw = Data([0x1B, 0x5B, 0x33, 0x31, 0x6D, 0x0A, 0xFF, 0xFE])
        XCTAssertEqual(
            Array(subject.normalize(raw)),
            [0x1B, 0x5B, 0x33, 0x31, 0x6D, 0x0D, 0x0A, 0xFF, 0xFE],
            "escape sequences and invalid UTF-8 must pass through untouched")
    }
}
