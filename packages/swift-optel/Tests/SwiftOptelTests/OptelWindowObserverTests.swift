import XCTest

@testable import SwiftOptel

final class OptelWindowObserverTests: XCTestCase {

    func testIdentityPrefersTitleAsSourceWhenPresent() {
        let identity = OptelWindowIdentity.make(
            identifier: "main-window",
            title: "Sliccstart",
            fallbackKey: "0xDEAD"
        )
        XCTAssertEqual(identity.source, "Sliccstart")

        XCTAssertEqual(identity.key, "id:main-window")
    }

    func testIdentityFallsBackToIdentifierAsSourceWhenTitleIsBlank() {
        let identity = OptelWindowIdentity.make(
            identifier: "settings-window",
            title: "   ",
            fallbackKey: "0xCAFE"
        )
        XCTAssertEqual(identity.source, "settings-window")
        XCTAssertEqual(identity.key, "id:settings-window")
    }

    func testIdentityFallsBackToTitleKeyWhenIdentifierIsBlank() {
        let identity = OptelWindowIdentity.make(
            identifier: nil,
            title: "Inspector",
            fallbackKey: "0xBEEF"
        )
        XCTAssertEqual(identity.source, "Inspector")

        XCTAssertEqual(identity.key, "title:Inspector#ref:0xBEEF")
    }

    func testIdentityFallsBackToProvidedRefWhenIdAndTitleAreBlank() {
        let identity = OptelWindowIdentity.make(
            identifier: "",
            title: "",
            fallbackKey: "0xFEED"
        )
        XCTAssertEqual(identity.source, "window")
        XCTAssertEqual(identity.key, "ref:0xFEED")
    }

    func testIdentityKeysDistinguishBlankWindowsByFallback() {
        let a = OptelWindowIdentity.make(identifier: nil, title: nil, fallbackKey: "A")
        let b = OptelWindowIdentity.make(identifier: nil, title: nil, fallbackKey: "B")
        XCTAssertNotEqual(a.key, b.key)
    }

    func testIdentityKeysDistinguishSameTitleWindowsByFallback() {

        let first = OptelWindowIdentity.make(
            identifier: nil,
            title: "Untitled",
            fallbackKey: "0xAAA"
        )
        let second = OptelWindowIdentity.make(
            identifier: nil,
            title: "Untitled",
            fallbackKey: "0xBBB"
        )
        XCTAssertNotEqual(first.key, second.key)

        XCTAssertEqual(first.source, "Untitled")
        XCTAssertEqual(second.source, "Untitled")

        let decision = OptelWindowNavigateDecider.decide(previous: first, current: second)
        XCTAssertTrue(decision.shouldEmit)
        XCTAssertEqual(decision.source, "Untitled")
    }

    func testIdentityKeyStableAcrossReFocusOfSameWindow() {

        let first = OptelWindowIdentity.make(
            identifier: nil,
            title: "Untitled",
            fallbackKey: "0xSAME"
        )
        let second = OptelWindowIdentity.make(
            identifier: nil,
            title: "Untitled",
            fallbackKey: "0xSAME"
        )
        XCTAssertEqual(first.key, second.key)
        let decision = OptelWindowNavigateDecider.decide(previous: first, current: second)
        XCTAssertFalse(decision.shouldEmit)
    }

    func testIdentityKeyIgnoresFallbackWhenIdentifierPresent() {

        let first = OptelWindowIdentity.make(
            identifier: "main-window",
            title: "Sliccstart",
            fallbackKey: "0xAAA"
        )
        let second = OptelWindowIdentity.make(
            identifier: "main-window",
            title: "Sliccstart",
            fallbackKey: "0xBBB"
        )
        XCTAssertEqual(first.key, "id:main-window")
        XCTAssertEqual(second.key, "id:main-window")
    }

    func testFirstWindowEmits() {
        let current = OptelWindowIdentity(key: "id:A", source: "Window A")
        let decision = OptelWindowNavigateDecider.decide(previous: nil, current: current)
        XCTAssertTrue(decision.shouldEmit)
        XCTAssertEqual(decision.source, "Window A")
    }

    func testReFocusingSameWindowDoesNotEmit() {
        let identity = OptelWindowIdentity(key: "id:A", source: "Window A")
        let decision = OptelWindowNavigateDecider.decide(previous: identity, current: identity)
        XCTAssertFalse(decision.shouldEmit)
        XCTAssertNil(decision.source)
    }

    func testSwitchingWindowsEmitsNewSource() {
        let previous = OptelWindowIdentity(key: "id:A", source: "Window A")
        let current = OptelWindowIdentity(key: "id:B", source: "Window B")
        let decision = OptelWindowNavigateDecider.decide(previous: previous, current: current)
        XCTAssertTrue(decision.shouldEmit)
        XCTAssertEqual(decision.source, "Window B")
    }

    func testKeyComparisonIgnoresDisplaySourceChanges() {

        let previous = OptelWindowIdentity(key: "id:A", source: "Window A")
        let renamed = OptelWindowIdentity(key: "id:A", source: "Window A (modified)")
        let decision = OptelWindowNavigateDecider.decide(previous: previous, current: renamed)
        XCTAssertFalse(decision.shouldEmit)
    }

    #if os(macOS)
        func testObserverInstallIsIdempotent() {
            OptelWindowObserver._testing_reset()
            XCTAssertFalse(OptelWindowObserver.isInstalled)
            OptelWindowObserver.installIfNeeded()
            XCTAssertTrue(OptelWindowObserver.isInstalled)

            OptelWindowObserver.installIfNeeded()
            XCTAssertTrue(OptelWindowObserver.isInstalled)
            OptelWindowObserver.uninstall()
            XCTAssertFalse(OptelWindowObserver.isInstalled)

            OptelWindowObserver.uninstall()
            XCTAssertFalse(OptelWindowObserver.isInstalled)
        }
    #endif
}
