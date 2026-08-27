import CoreGraphics
import XCTest

@testable import SliccFollower

/// Column geometry for pipe tables. The rule these cover is what keeps a
/// three-column comparison from stretching across an iPad: the card is sized
/// from its own cells, never from the viewport it happens to land in.
final class MarkdownTableLayoutTests: XCTestCase {

    private let padding = MarkdownTableLayout.cellHorizontalPadding * 2

    private func table(
        header: [String], alignments: [MarkdownTable.Alignment] = [], rows: [[String]]
    ) -> MarkdownTable {
        MarkdownTable(
            header: header,
            alignments: alignments.isEmpty ? header.map { _ in .leading } : alignments,
            rows: rows)
    }

    /// Ten points per character, so an expected width is readable inline.
    private func measureByLength(_ text: String, _ isHeader: Bool) -> CGFloat {
        CGFloat(text.count) * 10
    }

    // MARK: - Hugging

    func testColumnHugsItsWidestCellPlusPadding() {
        let widths = MarkdownTableLayout.columnWidths(
            for: table(header: ["ab"], rows: [["abcdefghij"], ["abc"]]),
            measuring: measureByLength)

        XCTAssertEqual(widths, [100 + padding])
    }

    func testHeaderCanBeTheWidestCell() {
        let widths = MarkdownTableLayout.columnWidths(
            for: table(header: ["abcdefghij"], rows: [["a"]]),
            measuring: measureByLength)

        XCTAssertEqual(widths, [100 + padding])
    }

    func testEachColumnIsSizedIndependently() {
        let widths = MarkdownTableLayout.columnWidths(
            for: table(header: ["abcdefghij", "abcdefghijkl"], rows: [["abc", "abcde"]]),
            measuring: measureByLength)

        XCTAssertEqual(widths, [100 + padding, 120 + padding])
    }

    // MARK: - Floor and cap

    func testNarrowColumnKeepsTheMinimumWidth() {
        let widths = MarkdownTableLayout.columnWidths(
            for: table(header: ["a"], rows: [["b"]]),
            measuring: measureByLength)

        XCTAssertEqual(widths, [MarkdownTableLayout.minimumCellWidth])
    }

    /// The cap is what makes a long cell wrap instead of widening the card
    /// without bound; the view relies on the returned width being finite.
    func testRunawayColumnIsCappedSoTheCellWraps() {
        let long = String(repeating: "x", count: 200)
        let widths = MarkdownTableLayout.columnWidths(
            for: table(header: ["h"], rows: [[long]]),
            measuring: measureByLength)

        XCTAssertEqual(widths, [MarkdownTableLayout.maximumCellWidth])
    }

    // MARK: - Ragged input

    /// The parser emits rows exactly as written, so a row can be shorter or
    /// longer than the header. Column count follows the header either way.
    func testRaggedRowsDoNotAffectColumnCount() {
        let widths = MarkdownTableLayout.columnWidths(
            for: table(header: ["ab", "cd"], rows: [["a"], ["a", "b", "abcdefghij"]]),
            measuring: measureByLength)

        XCTAssertEqual(widths.count, 2)
    }

    func testHeaderlessTableStillYieldsOneColumn() {
        let widths = MarkdownTableLayout.columnWidths(
            for: table(header: [], rows: [[]]),
            measuring: measureByLength)

        XCTAssertEqual(widths, [MarkdownTableLayout.minimumCellWidth])
    }

    // MARK: - Text measurement

    /// Cells are measured off the inline parse the view renders, not off the
    /// raw source — sizing a column to its markdown syntax would leave every
    /// emphasized cell with a gap the width of its asterisks.
    func testMeasurementIgnoresInlineMarkdownSyntax() {
        let styled = MarkdownTableLayout.textWidth("**Runtime**", isHeader: false)
        let plain = MarkdownTableLayout.textWidth("Runtime", isHeader: false)
        let literal = MarkdownTableLayout.textWidth("\\*\\*Runtime\\*\\*", isHeader: false)

        XCTAssertLessThan(styled, literal)
        XCTAssertGreaterThanOrEqual(styled, plain)
    }

    func testInlineCodeIsMeasuredInTheMonospaceFaceItPaintsIn() {
        let code = MarkdownTableLayout.textWidth("`iframe`", isHeader: false)
        let plain = MarkdownTableLayout.textWidth("iframe", isHeader: false)

        XCTAssertGreaterThan(code, plain)
    }

    func testLongerTextMeasuresWider() {
        XCTAssertGreaterThan(
            MarkdownTableLayout.textWidth("boots Chrome over CDP", isHeader: false),
            MarkdownTableLayout.textWidth("boots", isHeader: false))
    }

    func testEmptyCellMeasuresZero() {
        XCTAssertEqual(MarkdownTableLayout.textWidth("", isHeader: false), 0)
    }

    // MARK: - Card width

    /// The card width is what the scroll guard is capped to, so a stale sum
    /// here means the guard reclaims the blank space beside a hugged table
    /// and swallows the scoop swipes that start in it.
    func testTotalWidthIsTheSumOfTheColumnWidths() {
        let subject = table(
            header: ["Float", "Runtime"],
            rows: [["CLI", "Express"], ["Cherry", "iframe"]])

        XCTAssertEqual(
            MarkdownTableLayout.totalWidth(for: subject),
            MarkdownTableLayout.columnWidths(for: subject).reduce(0, +))
    }

    func testTotalWidthGrowsWithAWiderCell() {
        let narrow = table(header: ["Float"], rows: [["CLI"]])
        let wide = table(header: ["Float"], rows: [["a much longer float name"]])

        XCTAssertGreaterThan(
            MarkdownTableLayout.totalWidth(for: wide),
            MarkdownTableLayout.totalWidth(for: narrow))
    }

    // MARK: - Memoized entry point

    func testMemoizedWidthsMatchTheMeasuredRule() {
        let subject = table(
            header: ["Float", "Runtime"],
            rows: [["CLI", "Express"], ["Cherry", "iframe"]])

        let first = MarkdownTableLayout.columnWidths(for: subject)
        let second = MarkdownTableLayout.columnWidths(for: subject)
        let direct = MarkdownTableLayout.columnWidths(
            for: subject, measuring: MarkdownTableLayout.textWidth)

        XCTAssertEqual(first, second)
        XCTAssertEqual(first, direct)
    }

    /// The cache is keyed by cell contents, so two tables that differ only in
    /// a cell must not share a width.
    func testTablesDifferingInOneCellGetTheirOwnWidths() {
        let narrow = table(header: ["Float"], rows: [["CLI"]])
        let wide = table(header: ["Float"], rows: [["a much longer float name"]])

        XCTAssertNotEqual(
            MarkdownTableLayout.columnWidths(for: narrow),
            MarkdownTableLayout.columnWidths(for: wide))
    }
}
