#if os(macOS)
import XCTest
@testable import SwiftOptel

/// Pure value-type fake so the deriver can be exercised without a running app.
private final class FakeElement: OptelAccessibleElement {
    var optelAccessibilityRole: String?
    var optelAccessibilityIdentifier: String?
    var optelAccessibilityLabel: String?
    var optelAccessibilityWindowTitle: String?
    var optelAccessibilityParent: OptelAccessibleElement?

    init(
        role: String? = nil,
        identifier: String? = nil,
        label: String? = nil,
        windowTitle: String? = nil,
        parent: OptelAccessibleElement? = nil
    ) {
        self.optelAccessibilityRole = role
        self.optelAccessibilityIdentifier = identifier
        self.optelAccessibilityLabel = label
        self.optelAccessibilityWindowTitle = windowTitle
        self.optelAccessibilityParent = parent
    }
}

final class OptelAccessibilityDeriverTests: XCTestCase {
    func testIdentifierWinsOverLabel() {
        let hit = FakeElement(role: "button", identifier: "submit", label: "Submit")
        let derived = OptelAccessibilityDeriver.derive(from: hit)
        XCTAssertEqual(derived.source, "button#submit")
        XCTAssertEqual(derived.target, "Submit")
    }

    func testLabelFallbackWhenNoIdentifier() {
        let hit = FakeElement(role: "button", label: "Buy")
        let derived = OptelAccessibilityDeriver.derive(from: hit)
        XCTAssertEqual(derived.source, "button \"Buy\"")
        XCTAssertEqual(derived.target, "Buy")
    }

    func testRoleOnlyFallback() {
        let hit = FakeElement(role: "slider")
        let derived = OptelAccessibilityDeriver.derive(from: hit)
        XCTAssertEqual(derived.source, "slider")
        XCTAssertNil(derived.target)
    }

    func testWindowTitleProvidesContext() {
        let window = FakeElement(windowTitle: "Settings")
        let hit = FakeElement(role: "button", identifier: "ok", parent: window)
        let derived = OptelAccessibilityDeriver.derive(from: hit)
        XCTAssertEqual(derived.source, "Settings button#ok")
        XCTAssertNil(derived.target)
    }

    func testWindowTitleFromHitElementDirectly() {
        let hit = FakeElement(role: "button", label: "Close", windowTitle: "Document")
        let derived = OptelAccessibilityDeriver.derive(from: hit)
        XCTAssertEqual(derived.source, "Document button \"Close\"")
        XCTAssertEqual(derived.target, "Close")
    }

    func testWalksPastGenericContainerToMeaningfulAncestor() {
        let window = FakeElement(windowTitle: "Main")
        let button = FakeElement(role: "AXButton", identifier: "save", parent: window)
        let group = FakeElement(role: "AXGroup", parent: button)
        let unknown = FakeElement(role: "AXUnknown", parent: group)
        let derived = OptelAccessibilityDeriver.derive(from: unknown)
        XCTAssertEqual(derived.source, "Main AXButton#save")
    }

    func testFallsBackToHitElementWhenNothingMeaningful() {
        let chain = FakeElement(role: "AXGroup", parent: FakeElement(role: "AXUnknown"))
        let derived = OptelAccessibilityDeriver.derive(from: chain)
        XCTAssertEqual(derived.source, "AXGroup")
        XCTAssertNil(derived.target)
    }

    func testHitElementWithNothingAndNoAncestorsYieldsViewFallback() {
        let hit = FakeElement()
        let derived = OptelAccessibilityDeriver.derive(from: hit)
        XCTAssertEqual(derived.source, "view")
        XCTAssertNil(derived.target)
    }

    func testWhitespaceOnlyFieldsAreTreatedAsAbsent() {
        let window = FakeElement(windowTitle: "   ")
        let hit = FakeElement(
            role: "button",
            identifier: "  ",
            label: " Save ",
            parent: window
        )
        let derived = OptelAccessibilityDeriver.derive(from: hit)
        XCTAssertEqual(derived.source, "button \"Save\"")
        XCTAssertEqual(derived.target, "Save")
    }

    func testEmptyStringRoleFallsBackToView() {
        let hit = FakeElement(role: "", identifier: "x")
        let derived = OptelAccessibilityDeriver.derive(from: hit)
        XCTAssertEqual(derived.source, "view#x")
    }

    func testWindowTitleWalksOnlyUntilFirstNonEmpty() {
        let outer = FakeElement(windowTitle: "Outer")
        let middle = FakeElement(windowTitle: "Inner", parent: outer)
        let hit = FakeElement(role: "button", identifier: "go", parent: middle)
        let derived = OptelAccessibilityDeriver.derive(from: hit)
        XCTAssertEqual(derived.source, "Inner button#go")
    }

    func testDepthCapPreventsRunawayWalk() {
        // Build a chain longer than the cap; only the deepest node is meaningful.
        let leaf = FakeElement(role: "button", identifier: "deep")
        var current: OptelAccessibleElement = leaf
        for _ in 0..<(OptelAccessibilityDeriver.maxAncestorDepth + 10) {
            current = FakeElement(role: "AXGroup", parent: current)
        }
        let derived = OptelAccessibilityDeriver.derive(from: current)
        // The deep meaningful node is beyond the cap, so the deriver falls
        // back to the hit element itself (a generic group, role-only source).
        XCTAssertEqual(derived.source, "AXGroup")
    }

    func testMeaningfulnessIgnoresGenericRolesButHonorsIdentifier() {
        let containerWithID = FakeElement(role: "AXGroup", identifier: "toolbar")
        XCTAssertTrue(OptelAccessibilityDeriver.isMeaningful(containerWithID))
        let bareGroup = FakeElement(role: "AXGroup")
        XCTAssertFalse(OptelAccessibilityDeriver.isMeaningful(bareGroup))
    }
}
#endif
