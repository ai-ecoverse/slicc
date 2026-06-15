import XCTest
@testable import SwiftOptel

final class OptelWindowObserverTests: XCTestCase {
    // MARK: - OptelWindowIdentity.make

    func testIdentityPrefersTitleAsSourceWhenPresent() {
        let identity = OptelWindowIdentity.make(
            identifier: "main-window",
            title: "Sliccstart",
            fallbackKey: "0xDEAD"
        )
        XCTAssertEqual(identity.source, "Sliccstart")
        // Identifier wins as the stable key even when title is the visible source.
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
        XCTAssertEqual(identity.key, "title:Inspector")
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

    // MARK: - OptelWindowNavigateDecider.decide

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
        // Same underlying window (same key) re-reported with a renamed title
        // should not emit again — `key`, not `source`, drives the dedupe.
        let previous = OptelWindowIdentity(key: "id:A", source: "Window A")
        let renamed = OptelWindowIdentity(key: "id:A", source: "Window A (modified)")
        let decision = OptelWindowNavigateDecider.decide(previous: previous, current: renamed)
        XCTAssertFalse(decision.shouldEmit)
    }

    // MARK: - macOS observer install/uninstall

    #if os(macOS)
    func testObserverInstallIsIdempotent() {
        OptelWindowObserver._testing_reset()
        XCTAssertFalse(OptelWindowObserver.isInstalled)
        OptelWindowObserver.installIfNeeded()
        XCTAssertTrue(OptelWindowObserver.isInstalled)
        // Second call is a no-op; flag remains set and no crash.
        OptelWindowObserver.installIfNeeded()
        XCTAssertTrue(OptelWindowObserver.isInstalled)
        OptelWindowObserver.uninstall()
        XCTAssertFalse(OptelWindowObserver.isInstalled)
        // Uninstall when nothing is installed is also a no-op.
        OptelWindowObserver.uninstall()
        XCTAssertFalse(OptelWindowObserver.isInstalled)
    }
    #endif
}
