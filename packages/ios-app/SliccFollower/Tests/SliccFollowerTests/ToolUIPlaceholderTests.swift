import Foundation
import XCTest

@testable import SliccFollower






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
        
        
        XCTAssertEqual(title(html), "Allow npm publish?")
    }

    
    
    
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

    
    
    func testFallsBackWhenTheHeaderStripsToNothing() {
        let html = """
            <div class="sprinkle-action-card__header">
              <span class="sprinkle-badge">sudo</span>
              <div class="sprinkle-action-card__meta">/workspace</div>
            </div>
            """
        XCTAssertEqual(title(html), ToolUIPlaceholder.fallbackTitle)
    }

    
    
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
