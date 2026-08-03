import XCTest

@testable import SliccFollower

/// The block grammar behind `MarkdownText`. `AttributedString(markdown:)` is
/// inline-only in the configuration the view uses, so anything this parser
/// misses reaches the transcript as its literal source — which is how the
/// leader's comparison tables arrived as raw `| … |` rows.
final class MarkdownBlockParserTests: XCTestCase {

    // MARK: - Tables

    func testParsesPipeTableWithAlignments() {
        let blocks = MarkdownBlockParser.parse(
            """
            | Lens | Reach | Price |
            |------|:-----:|------:|
            | Leica 100-400 | 800mm-eq | €750 |
            | OM 100-400 | 800mm-eq | €650 |
            """)

        guard case .table(let table)? = blocks.first, blocks.count == 1 else {
            return XCTFail("expected one table block, got \(blocks)")
        }
        XCTAssertEqual(table.header, ["Lens", "Reach", "Price"])
        XCTAssertEqual(table.alignments, [.leading, .center, .trailing])
        XCTAssertEqual(table.rows.count, 2)
        XCTAssertEqual(table.rows[0], ["Leica 100-400", "800mm-eq", "€750"])
    }

    func testTableWithoutOuterPipesStillParses() {
        let blocks = MarkdownBlockParser.parse(
            """
            a | b
            --- | ---
            1 | 2
            """)
        guard case .table(let table)? = blocks.first else {
            return XCTFail("expected a table, got \(blocks)")
        }
        XCTAssertEqual(table.header, ["a", "b"])
        XCTAssertEqual(table.rows, [["1", "2"]])
    }

    func testRaggedRowsArePaddedAndTruncatedToTheHeader() {
        let blocks = MarkdownBlockParser.parse(
            """
            | a | b |
            |---|---|
            | 1 |
            | 1 | 2 | 3 |
            """)
        guard case .table(let table)? = blocks.first else {
            return XCTFail("expected a table, got \(blocks)")
        }
        XCTAssertEqual(
            table.rows, [["1", ""], ["1", "2"]],
            "a ragged row must not desync the grid or index out of bounds")
    }

    func testEscapedPipeStaysInsideItsCell() {
        XCTAssertEqual(MarkdownBlockParser.splitRow(#"| a \| b | c |"#), ["a | b", "c"])
    }

    func testProseFullOfPipesIsNotATable() {
        let blocks = MarkdownBlockParser.parse(
            """
            Run `a | b | c` and then
            pipe it | somewhere else
            """)
        XCTAssertEqual(blocks.count, 1)
        guard case .paragraph? = blocks.first else {
            return XCTFail("pipes without a delimiter row are prose, got \(blocks)")
        }
    }

    func testTableTerminatesAtTheFirstNonRow() {
        let blocks = MarkdownBlockParser.parse(
            """
            | a |
            |---|
            | 1 |

            After the table.
            """)
        XCTAssertEqual(blocks.count, 2)
        guard case .table(let table)? = blocks.first, case .paragraph(let text) = blocks[1] else {
            return XCTFail("expected table then paragraph, got \(blocks)")
        }
        XCTAssertEqual(table.rows, [["1"]])
        XCTAssertEqual(text, "After the table.")
    }

    // MARK: - Lists

    func testBulletListItemsCarryDepthAndMarker() {
        let blocks = MarkdownBlockParser.parse(
            """
            - Leica SL 100-400 L-mount
            - Hood-only listings
              - nested note
            """)
        guard case .list(let list)? = blocks.first else {
            return XCTFail("expected a list, got \(blocks)")
        }
        XCTAssertFalse(list.ordered)
        XCTAssertEqual(list.items.map(\.depth), [0, 0, 1])
        XCTAssertEqual(list.items.map(\.marker), ["•", "•", "◦"])
        XCTAssertEqual(list.items[0].text, "Leica SL 100-400 L-mount")
    }

    func testOrderedListKeepsTheAuthorsNumbering() {
        let blocks = MarkdownBlockParser.parse(
            """
            3. €750 Dinslaken
            4. €805 Senden
            """)
        guard case .list(let list)? = blocks.first else {
            return XCTFail("expected a list, got \(blocks)")
        }
        XCTAssertTrue(list.ordered)
        XCTAssertEqual(list.items.map(\.marker), ["3.", "4."])
    }

    func testSwitchingMarkerKindStartsANewList() {
        let blocks = MarkdownBlockParser.parse(
            """
            - bullet
            1. number
            """)
        XCTAssertEqual(blocks.count, 2)
        guard case .list(let bullets)? = blocks.first, case .list(let numbers) = blocks[1] else {
            return XCTFail("expected two lists, got \(blocks)")
        }
        XCTAssertFalse(bullets.ordered)
        XCTAssertTrue(numbers.ordered)
    }

    func testHyphenatedProseIsNotAListItem() {
        let blocks = MarkdownBlockParser.parse("-not a bullet")
        guard case .paragraph(let text)? = blocks.first else {
            return XCTFail("a marker needs a trailing space, got \(blocks)")
        }
        XCTAssertEqual(text, "-not a bullet")
    }

    // MARK: - Thematic breaks

    func testThematicBreakVariants() {
        for line in ["---", "***", "___", "- - -", "  ----"] {
            XCTAssertTrue(MarkdownBlockParser.isThematicBreak(line), "\(line) is a rule")
        }
        for line in ["--", "-- text", "|---|---|", "-"] {
            XCTAssertFalse(MarkdownBlockParser.isThematicBreak(line), "\(line) is not a rule")
        }
    }

    func testTableDelimiterRowIsNotEatenAsAThematicBreak() {
        let blocks = MarkdownBlockParser.parse(
            """
            | a | b |
            | --- | --- |
            | 1 | 2 |
            """)
        guard case .table? = blocks.first, blocks.count == 1 else {
            return XCTFail("delimiter rows carry pipes and belong to the table, got \(blocks)")
        }
    }

    // MARK: - Blocks that already worked

    func testHeadingsCodeAndQuotesSurviveTheRewrite() {
        let blocks = MarkdownBlockParser.parse(
            """
            # Title

            > quoted

            ```swift
            let x = 1
            ```

            tail
            """)
        XCTAssertEqual(blocks.count, 4)
        guard case .heading(let level, let title)? = blocks.first else {
            return XCTFail("expected a heading, got \(blocks)")
        }
        XCTAssertEqual(level, 1)
        XCTAssertEqual(title, "Title")
        XCTAssertEqual(blocks[1], .blockquote("quoted"))
        XCTAssertEqual(blocks[2], .codeBlock(language: "swift", code: "let x = 1"))
        XCTAssertEqual(blocks[3], .paragraph("tail"))
    }

    func testUnclosedFenceStillRendersAsCode() {
        let blocks = MarkdownBlockParser.parse(
            """
            ```
            still code
            """)
        XCTAssertEqual(blocks, [.codeBlock(language: nil, code: "still code")])
    }

    func testFencedContentIsNeverReinterpreted() {
        let blocks = MarkdownBlockParser.parse(
            """
            ```
            | a | b |
            |---|---|
            - not a bullet
            ---
            ```
            """)
        XCTAssertEqual(blocks.count, 1)
        guard case .codeBlock(_, let code)? = blocks.first else {
            return XCTFail("expected one code block, got \(blocks)")
        }
        XCTAssertTrue(code.contains("| a | b |"))
        XCTAssertTrue(code.contains("- not a bullet"))
    }

    func testHashInTitleSurvivesButClosingSequenceDoesNot() {
        XCTAssertEqual(MarkdownBlockParser.parseAtxHeading("# C#")?.text, "C#")
        XCTAssertEqual(MarkdownBlockParser.parseAtxHeading("# Heading ##")?.text, "Heading")
        XCTAssertNil(MarkdownBlockParser.parseAtxHeading("#NoSpace"))
        XCTAssertNil(
            MarkdownBlockParser.parseAtxHeading("    # indented"),
            "4+ leading spaces is an indented code block, not a heading")
    }

    func testEmptyContentProducesNoBlocks() {
        XCTAssertEqual(MarkdownBlockParser.parse(""), [])
        XCTAssertEqual(MarkdownBlockParser.parse("\n\n  \n"), [])
    }
}
