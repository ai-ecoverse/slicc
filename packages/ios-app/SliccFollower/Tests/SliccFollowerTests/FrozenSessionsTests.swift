import XCTest

@testable import SliccFollower
@testable import SliccTrayKit

final class FrozenSessionsTests: XCTestCase {
    // MARK: - Index parsing

    func testParsesAModernIndex() throws {
        let json = """
            [{"filename":"2026-07-30T10-00-00Z-fix-build.md","title":"Fix build",
            "frozenAt":"2026-07-30T10:00:00Z","messageCount":12,
            "sessionId":"abc","icon":"wrench","cost":{"total":1.2},"pendingEnrichment":false}]
            """.replacingOccurrences(of: "\n", with: "")
        let entries = try XCTUnwrap(FrozenSessionIndex.parse(indexJson: json))
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].title, "Fix build")
        XCTAssertEqual(entries[0].id, "abc")
        XCTAssertEqual(entries[0].path, "/sessions/2026-07-30T10-00-00Z-fix-build.md")
    }

    func testLegacyEntryWithoutSessionIdKeysOnFilename() throws {
        let json = #"[{"filename":"a.md","title":"A","frozenAt":"","messageCount":2}]"#
        let entries = try XCTUnwrap(FrozenSessionIndex.parse(indexJson: json))
        XCTAssertEqual(entries[0].id, "a.md")
    }

    func testCorruptIndexReturnsNilSoTheCallerRebuilds() {
        XCTAssertNil(FrozenSessionIndex.parse(indexJson: "not-json"))
        XCTAssertNil(FrozenSessionIndex.parse(indexJson: #"{"filename":"not-an-array"}"#))
        XCTAssertNil(FrozenSessionIndex.parse(indexJson: #"[{"filename":"tr"#))  // truncated
    }

    func testOneBadRowDoesNotTakeDownTheRail() throws {
        let json = #"[{"nope":true},{"filename":"ok.md","title":"OK","frozenAt":"","messageCount":1}]"#
        let entries = try XCTUnwrap(FrozenSessionIndex.parse(indexJson: json))
        XCTAssertEqual(entries.map(\.title), ["OK"])
    }

    // MARK: - Rebuild from directory scan

    func testRebuildRecoversTitleAndTimestampFromFilenames() {
        let entries = FrozenSessionIndex.rebuild(from: [
            // The canonical writer shape: toISOString().replace(/[:.]/g, "-")
            // dashes the milliseconds dot too.
            TrayFsDirEntry(name: "2026-05-13T19-30-00-123Z-fix-build.md", type: .file),
            TrayFsDirEntry(name: "2026-06-01T08-00-00Z-plan-launch.md", type: .file),
            TrayFsDirEntry(name: "index.json", type: .file),
            TrayFsDirEntry(name: "attachments", type: .directory),
            TrayFsDirEntry(name: "pending-ab12.md", type: .file),
        ])
        XCTAssertEqual(entries.count, 3)
        // Newest first by filename (timestamp prefixes sort chronologically;
        // pending-* sorts after the dated names).
        XCTAssertEqual(entries[0].filename, "pending-ab12.md")
        XCTAssertEqual(entries[0].title, "Pending session")
        XCTAssertEqual(entries[1].title, "Plan Launch")
        XCTAssertEqual(entries[2].title, "Fix Build")
        XCTAssertEqual(entries[2].frozenAt, "2026-05-13T19:30:00.123Z")
        XCTAssertNotNil(entries[2].frozenDate)
    }

    // MARK: - Meta line + search

    func testMetaLineMatchesTheRailFormat() {
        let entry = FrozenSessionIndexEntry(
            filename: "x.md", title: "X", frozenAt: "2026-01-01T12:00:00Z", messageCount: 12)
        XCTAssertEqual(FrozenSessionIndex.metaLine(for: entry), "Jan 1 · 12 turns")
        let unknown = FrozenSessionIndexEntry(
            filename: "y.md", title: "Y", frozenAt: "", messageCount: 0)
        XCTAssertEqual(FrozenSessionIndex.metaLine(for: unknown), "Archived session")
    }

    func testSearchIsCaseInsensitiveOverTitles() {
        let entries = [
            FrozenSessionIndexEntry(
                filename: "a.md", title: "Fix the build", frozenAt: "", messageCount: 1),
            FrozenSessionIndexEntry(
                filename: "b.md", title: "Plan launch", frozenAt: "", messageCount: 1),
        ]
        XCTAssertEqual(FrozenSessionIndex.search(entries, query: "BUILD").map(\.filename), ["a.md"])
        XCTAssertEqual(FrozenSessionIndex.search(entries, query: "  ").count, 2)
    }

    // MARK: - Archive parsing

    func testParsesModernArchiveViaSessionDataBlock() {
        let markdown = """
            ---
            title: "Debug \\"Auth\\" bug"
            frozenAt: 2026-07-30T10:00:00Z
            ---

            <!-- slicc:session-data
            [{"id":"m1","role":"user","content":"hi","timestamp":0},\
            {"id":"m2","role":"assistant","content":"a -- > b","timestamp":1}]
            -->

            # Debug "Auth" bug

            ## User

            hi
            """
        let parsed = FrozenArchiveParser.parse(markdown: markdown)
        XCTAssertEqual(parsed.title, #"Debug "Auth" bug"#)
        XCTAssertEqual(parsed.messages.count, 2)
        XCTAssertEqual(parsed.messages[0].content, "hi")
        // The writer escapes "-->" inside the block as "-- >"; the parser
        // must restore it.
        XCTAssertEqual(parsed.messages[1].content, "a --> b")
    }

    func testFallsBackToHeadingParserWithoutDataBlock() {
        let markdown = """
            ---
            title: Old archive
            ---

            # Old archive

            ## User

            question?

            ## Assistant

            answer.

            ### Tool: bash

            tool output stays in the assistant message
            """
        let parsed = FrozenArchiveParser.parse(markdown: markdown)
        XCTAssertEqual(parsed.title, "Old archive")
        XCTAssertEqual(parsed.messages.count, 2)
        XCTAssertEqual(parsed.messages[0].role, .user)
        XCTAssertEqual(parsed.messages[0].content, "question?")
        XCTAssertEqual(parsed.messages[1].role, .assistant)
        XCTAssertTrue(parsed.messages[1].content.contains("tool output stays"))
    }

    func testMalformedDataBlockFallsThroughToHeadings() {
        let markdown = """
            ---
            title: Broken block
            ---

            <!-- slicc:session-data
            [not valid json
            -->

            ## User

            still readable
            """
        let parsed = FrozenArchiveParser.parse(markdown: markdown)
        XCTAssertEqual(parsed.messages.count, 1)
        XCTAssertEqual(parsed.messages[0].content, "still readable")
    }

    func testRemapNeverTouchesStructuredArchives() {
        // A data-block message with timestamp 0 keeps the writer's value —
        // and, by extension, every rich field a rebuild would drop.
        let markdown = """
            <!-- slicc:session-data
            [{"id":"m1","role":"assistant","content":"x","timestamp":0,"model":"claude-opus-4-6"}]
            -->
            """
        let parsed = FrozenArchiveParser.parse(markdown: markdown)
        XCTAssertFalse(parsed.usedFallback)
        let remapped = FrozenArchiveParser.withFallbackTimestamps(
            parsed, frozenAt: Date(timeIntervalSince1970: 1000))
        XCTAssertEqual(remapped.messages[0].timestamp, 0)
        XCTAssertEqual(remapped.messages[0].model, "claude-opus-4-6")
    }

    func testZeroTimestampsRemapToTheFreezeDate() {
        let parsed = FrozenArchiveParser.parse(markdown: "## User\n\nhello")
        let frozenAt = Date(timeIntervalSince1970: 1_753_800_000)
        let remapped = FrozenArchiveParser.withFallbackTimestamps(parsed, frozenAt: frozenAt)
        XCTAssertEqual(remapped.messages[0].timestamp, 1_753_800_000_000)
        // Unknown freeze date leaves the archive untouched.
        let untouched = FrozenArchiveParser.withFallbackTimestamps(parsed, frozenAt: nil)
        XCTAssertEqual(untouched.messages[0].timestamp, 0)
    }

    func testArchiveWithoutFrontmatterIsUntitled() {
        let parsed = FrozenArchiveParser.parse(markdown: "## User\n\nhello")
        XCTAssertEqual(parsed.title, "Untitled")
        XCTAssertEqual(parsed.messages.count, 1)
    }
}
