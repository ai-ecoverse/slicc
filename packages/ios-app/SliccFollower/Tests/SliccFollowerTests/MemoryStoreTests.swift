import XCTest

@testable import SliccFollower

/// The memory parser (#1867) — sections, tags, and title splitting over
/// the cone's `/workspace/CLAUDE.md`, mirroring `wc-memory.ts`.
final class MemoryStoreTests: XCTestCase {

    func testParsesSectionsAndBullets() {
        let rows = MemoryStore.parse(
            """
            # Memory

            ## User Preferences

            - Prefers dark mode.
            - Uses a left-handed dock.

            ## Project: parity

            - The dock mirrors the web order,
              with tools pinned at the bottom.
            """)
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows[0].section, "User Preferences")
        XCTAssertEqual(rows[0].tag, .user)
        XCTAssertEqual(rows[2].section, "Project: parity")
        XCTAssertEqual(rows[2].tag, .project)
        XCTAssertTrue(
            rows[2].body.contains("pinned at the bottom"),
            "hanging continuations belong to the open bullet")
    }

    func testFeedbackSectionsTagAsFeedback() {
        let rows = MemoryStore.parse(
            """
            ## Corrections & learnings

            - Never auto-merge UI PRs.
            """)
        XCTAssertEqual(rows.first?.tag, .feedback)
    }

    func testUnsectionedBulletsCarryNoTag() {
        let rows = MemoryStore.parse("- floating fact with no heading")
        XCTAssertEqual(rows.count, 1)
        XCTAssertNil(rows[0].tag)
        XCTAssertEqual(rows[0].section, "")
    }

    func testLongBulletsSplitNearTheCap() {
        let long = String(repeating: "word ", count: 40)
        let (title, rest) = MemoryStore.splitTitle(long)
        XCTAssertLessThanOrEqual(title.count, MemoryStore.titleMax)
        XCTAssertFalse(title.isEmpty)
        XCTAssertFalse(rest.isEmpty, "the split is lossless — the tail survives")
    }

    func testShortBulletsKeepTheirWholeTextAsTitle() {
        let (title, rest) = MemoryStore.splitTitle("Short and sweet.")
        XCTAssertEqual(title, "Short and sweet.")
        XCTAssertEqual(rest, "")
    }

    func testHeadingOnlyDocumentYieldsNoRows() {
        XCTAssertTrue(MemoryStore.parse("## Empty\n\n### Also empty").isEmpty)
    }

    func testAutoExtractedSectionsClassifyByContent() {
        let rows = MemoryStore.parse(
            """
            ## Auto-extracted (2026-08-02)

            - User prefers concise answers with keyboard-first workflows.
            - Correction: never auto-merge UI PRs without review.
            - The tray hub worker deploys manually.
            """)
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows[0].tag, .user, "content evidence, not the generic heading")
        XCTAssertEqual(rows[1].tag, .feedback)
        XCTAssertNil(rows[2].tag, "auto-extracted without signals stays untagged")
    }

    func testProseOnlyDocumentBecomesOneRow() {
        let rows = MemoryStore.parse(
            """
            # Memory

            The user works from Berlin and prefers espresso-length reviews.
            Deploys happen manually on Fridays.
            """)
        XCTAssertEqual(rows.count, 1, "a bullet-less memory file is not empty")
        XCTAssertTrue(rows[0].body.contains("espresso-length"))
        XCTAssertTrue(rows[0].body.contains("Fridays"))
    }
}
