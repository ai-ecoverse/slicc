import Foundation
import XCTest

@testable import SliccFollower

/// Title extraction for the read-only `tool_ui` placeholder (#1792).
///
/// The leader ships the approval card as rendered HTML. A follower cannot act
/// on it, so it shows only the title — which means pulling that title back out
/// of the markup. Mirrors `extractToolUiTitle` in `wc-chat-controller.ts`.
final class ToolUIPlaceholderTests: XCTestCase {

    private func title(_ html: String) -> String {
        ToolUIPlaceholder(requestId: "req-1", html: html).title
    }

    func testExtractsHeaderTextAndDropsBadgeAndMeta() {
        let html = """
            <div class="sprinkle-action-card">
              <div class="sprinkle-action-card__header">
                <span class="sprinkle-badge">sudo</span>
                Allow <code>npm publish</code>?
                <div class="sprinkle-action-card__meta">/workspace/package.json</div>
              </div>
            </div>
            """
        // No space before the `?`: tags are dropped with no separator, the way
        // `textContent` reads them on the web.
        XCTAssertEqual(title(html), "Allow npm publish?")
    }

    /// The meta line carries the mount target path. Followers are deliberately
    /// never shown it, so a regression that leaks it into the title is a
    /// disclosure bug rather than a cosmetic one.
    func testMetaPathNeverReachesTheTitle() {
        let html = """
            <div class="sprinkle-action-card__header">
              Approve write
              <div class="sprinkle-action-card__meta">/Users/someone/secrets/.env</div>
            </div>
            """
        XCTAssertEqual(title(html), "Approve write")
        XCTAssertFalse(title(html).contains("secrets"))
    }

    func testFallsBackWhenThereIsNoHeader() {
        XCTAssertEqual(
            title("<div class=\"sprinkle-action-card\">no header here</div>"),
            ToolUIPlaceholder.fallbackTitle)
        XCTAssertEqual(title(""), ToolUIPlaceholder.fallbackTitle)
    }

    /// A header holding only a badge and a meta line strips to nothing, which
    /// must fall back rather than render an empty title.
    func testFallsBackWhenTheHeaderStripsToNothing() {
        let html = """
            <div class="sprinkle-action-card__header">
              <span class="sprinkle-badge">sudo</span>
              <div class="sprinkle-action-card__meta">/workspace</div>
            </div>
            """
        XCTAssertEqual(title(html), ToolUIPlaceholder.fallbackTitle)
    }

    /// The header contains nested elements of the same tag, so a naive scan for
    /// the next `</div>` would cut the title short.
    func testHandlesNestedElementsOfTheSameTag() {
        let html = """
            <div class="sprinkle-action-card__header">
              <div><strong>Run</strong> migration</div>
            </div>
            """
        XCTAssertEqual(title(html), "Run migration")
    }

    func testDecodesEntitiesAndCollapsesWhitespace() {
        let html = """
            <div class="sprinkle-action-card__header">
              Allow    &lt;script&gt;   &amp;   more&hellip;
            </div>
            """
        XCTAssertEqual(title(html), "Allow <script> & more…")
    }

    func testIdentifierIsTheRequestIdSoToolUIDoneCanMatchIt() {
        let card = ToolUIPlaceholder(requestId: "req-42", html: "")
        XCTAssertEqual(card.id, "req-42")
    }
}
