import XCTest
@testable import SwiftOptel

final class OptelSourceDeriverTests: XCTestCase {
    func testIdentifierTakesPrecedenceOverLabel() {
        let result = OptelSourceDeriver.source(
            element: "button",
            identifier: "submit",
            label: "Submit"
        )
        XCTAssertEqual(result, "button#submit")
    }

    func testLabelUsedWhenIdentifierAbsent() {
        let result = OptelSourceDeriver.source(
            element: "button",
            label: "Submit"
        )
        XCTAssertEqual(result, "button \"Submit\"")
    }

    func testElementOnlyWhenNeitherIDNorLabel() {
        let result = OptelSourceDeriver.source(element: "view")
        XCTAssertEqual(result, "view")
    }

    func testContextPrefixedWhenProvided() {
        let result = OptelSourceDeriver.source(
            element: "button",
            identifier: "submit",
            context: "ContentView"
        )
        XCTAssertEqual(result, "ContentView button#submit")
    }

    func testContextWithLabel() {
        let result = OptelSourceDeriver.source(
            element: "button",
            label: "Buy",
            context: "Cart"
        )
        XCTAssertEqual(result, "Cart button \"Buy\"")
    }

    func testContextOnlyDropsToElementWhenNothingElse() {
        let result = OptelSourceDeriver.source(element: "view", context: "Home")
        XCTAssertEqual(result, "Home view")
    }

    func testWhitespaceOnlyInputsAreTreatedAsAbsent() {
        let result = OptelSourceDeriver.source(
            element: "button",
            identifier: "   ",
            label: " Submit ",
            context: "\t"
        )
        XCTAssertEqual(result, "button \"Submit\"")
    }

    func testEmptyElementFallsBackToView() {
        let result = OptelSourceDeriver.source(element: "", identifier: "x")
        XCTAssertEqual(result, "view#x")
    }
}
