import XCTest

@testable import SliccFollower








final class TranscriptEntityScanTests: XCTestCase {

    

    private func paths(_ text: String) -> [String] {
        FileMentions.scan(text).map(\.path)
    }

    func testFindsBareNamesAndQualifiedPaths() {
        XCTAssertEqual(
            paths("I rewrote the watcher in check.js and packages/webapp/src/main.ts."),
            ["check.js", "packages/webapp/src/main.ts"])
    }

    func testCapturesLineSuffix() {
        let found = FileMentions.scan("see packages/webapp/src/main.ts:42:7 for the guard")
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found.first?.path, "packages/webapp/src/main.ts")
        XCTAssertEqual(found.first?.line, 42)
    }

    func testSpanCoversPathAndSuffix() {
        let text = "open main.ts:42 now"
        guard let found = FileMentions.scan(text).first else { return XCTFail("no mention") }
        let start = text.index(text.startIndex, offsetBy: found.offset)
        let end = text.index(start, offsetBy: found.length)
        XCTAssertEqual(String(text[start..<end]), "main.ts:42")
    }

    func testRejectsVersionsWordsAndDomains() {
        XCTAssertEqual(paths("shipped 1.2.3 today"), [])
        XCTAssertEqual(paths("and so. it goes"), [])
        XCTAssertEqual(paths("visit example.com for docs"), [])
        XCTAssertEqual(paths("that is 3.14 exactly"), [])
    }

    func testDropsTrailingSentencePunctuation() {
        XCTAssertEqual(paths("edit main.ts, then build.py."), ["main.ts", "build.py"])
    }

    func testFindsExtensionlessNames() {
        XCTAssertEqual(paths("the Makefile drives it"), ["Makefile"])
    }

    
    
    
    func testIgnoresPathsInsideURLs() {
        XCTAssertEqual(paths("see https://example.com/static/app.js for the bundle"), [])
    }

    
    
    
    func testOffsetsSurviveMaskingAMultiByteURL() {
        let text = "see https://exämple.com/ünicode.html then open notes.md"
        guard let found = FileMentions.scan(text).first else { return XCTFail("no mention") }
        let start = text.index(text.startIndex, offsetBy: found.offset)
        let end = text.index(start, offsetBy: found.length)
        XCTAssertEqual(String(text[start..<end]), "notes.md")
    }

    func testCapsCandidatesPerRun() {
        let many = (0..<40).map { "file\($0).ts" }.joined(separator: " ")
        XCTAssertEqual(FileMentions.scan(many).count, FileMentions.maximumCandidates)
    }

    

    func testFindsPhoneNumber() {
        let found = PhoneMentions.scan("If it is urgent, call +1 (415) 555-0134.")
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found.first?.number, "+1 (415) 555-0134")
    }

    
    
    func testIgnoresShortDigitRuns() {
        XCTAssertEqual(PhoneMentions.scan("listening on 12345").count, 0)
    }

    

    private static let noteBase64 =
        "VGhlIHF1aWNrIGJyb3duIGZveCBqdW1wcyBvdmVyIHRoZSBsYXp5IGRvZywgYW5kIHRoZW4ga2VlcHMgb24ganVtcGluZyB1bnRp"
        + "bCB0aGlzIHNlbnRlbmNlIGlzIGNvbWZvcnRhYmx5IGxvbmdlciB0aGFuIHRoZSBodW5kcmVkIGFuZCB0d2VudHkgZWlnaHQgY2hh"
        + "cmFjdGVyIGZsb29yLg=="

    func testFindsBareRun() {
        let found = Base64Mentions.scan("here it is: \(Self.noteBase64) — enjoy")
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found.first?.data, Self.noteBase64)
        XCTAssertNil(found.first?.declaredMime)
    }

    func testFindsDataURLAndCarriesDeclaredType() {
        let found = Base64Mentions.scan("data:image/png;base64,\(Self.noteBase64)")
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found.first?.declaredMime, "image/png")
        XCTAssertEqual(found.first?.data, Self.noteBase64)
    }

    
    
    func testReassemblesColumnWrappedBlock() {
        let wrapped = stride(from: 0, to: Self.noteBase64.count, by: 76)
            .map { start -> String in
                let from = Self.noteBase64.index(Self.noteBase64.startIndex, offsetBy: start)
                let to =
                    Self.noteBase64.index(
                        from, offsetBy: 76, limitedBy: Self.noteBase64.endIndex)
                    ?? Self.noteBase64.endIndex
                return String(Self.noteBase64[from..<to])
            }
            .joined(separator: "\n")
        let found = Base64Mentions.scan(wrapped)
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found.first?.data, Self.noteBase64)
    }

    func testIgnoresShortAlphabetRuns() {
        
        let digest = String(repeating: "a1b2", count: 16)
        XCTAssertEqual(Base64Mentions.scan("digest \(digest) done").count, 0)
    }

    
    
    func testIgnoresRaggedProseLines() {
        let prose = """
            The quick brown fox jumps over the lazy dog and keeps going for a while
            and then the second line is a slightly different length than the first
            """
        XCTAssertEqual(Base64Mentions.scan(prose).count, 0)
    }
}
